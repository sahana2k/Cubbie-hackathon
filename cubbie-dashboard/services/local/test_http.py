import http.client
import json
import subprocess
import sys
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer

from server import Handler, State


class LocalHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.http.state = State(Path(self.folder.name))
        self.port = self.http.server_port
        self.origin = f'http://127.0.0.1:{self.port}'
        self.cookie = 'cubboard_session=' + self.http.state.session

    def tearDown(self):
        self.folder.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        fields = {'Cookie': self.cookie, 'Origin': self.origin, 'Content-Type': 'application/json', **(headers or {})}
        connection.request(method, path, None if body is None else json.dumps(body), fields)
        response = connection.getresponse()
        raw = response.read()
        result = json.loads(raw) if response.getheader('Content-Type') == 'application/json' else raw
        connection.close()
        return response.status, result

    def test_start_has_no_demo_records_and_config_selects_local_adapter(self):
        code, config = self.request('GET', '/config.json')
        self.assertEqual(code, 200)
        self.assertTrue(config['localApi'])
        self.assertEqual(self.request('GET', '/api/tasks'), (200, {'items': []}))
        self.assertEqual(self.request('GET', '/api/chat/messages'), (200, {'items': []}))

    def test_api_requires_session_and_same_origin(self):
        for headers in ({'Cookie': ''}, {'Origin': 'https://unrelated.example'}, {'Host': 'unrelated.example'}):
            with self.subTest(headers=headers):
                self.assertEqual(self.request('GET', '/api/tasks', headers=headers)[0], 403)
        self.assertEqual(self.request('POST', '/api/tasks', {}, {'Origin': ''})[0], 403)

    def test_tesseract_routes_require_session_and_restrict_proxy_paths(self):
        self.assertEqual(self.request('POST', '/api/tesseract/connect', {}, {'Cookie': ''})[0], 403)
        self.assertEqual(self.request('POST', '/api/tesseract/connect', {}, {'Origin': 'https://evil.example'})[0], 403)
        self.assertEqual(self.request('GET', '/api/tesseract/unknown')[0], 404)
        self.assertEqual(self.request('GET', '/api/tesseract/servers')[0], 400)
        with patch.object(self.http.state.tesseract, 'request', return_value={'servers': []}) as proxy:
            self.assertEqual(self.request('GET', '/api/tesseract/channels?guild=123')[0], 200)
            proxy.assert_called_once_with('/channels?guild=123')
            self.assertEqual(self.request('GET', '/api/tesseract/messages?guild=123&channel=456')[0], 200)
            proxy.assert_called_with('/messages?guild=123&channel=456')

    def test_toggling_discord_panel_keeps_bot_connected_without_reentering_secrets(self):
        bridge = self.http.state.tesseract
        bot = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        self.addCleanup(bridge.disconnect)
        def fake_connect(data):
            bridge.process, bridge.port, bridge.token = bot, 1, 'bridge-token'
            return {'servers': [{'id': '123', 'name': 'hackathon project'}]}
        # Same fields the dashboard form posts.
        creds = {'provider': 'anthropic', 'model': 'm', 'baseUrl': '', 'botToken': 'bot-secret', 'apiKey': 'llm-secret', 'guildId': '123'}
        with patch.object(bridge, '_connect', side_effect=fake_connect) as start, \
             patch.object(bridge, 'request', return_value={'servers': [{'id': '123', 'name': 'hackathon project'}]}):
            self.assertEqual(self.request('POST', '/api/tesseract/connect', creds)[0], 200)
            for _ in range(3):  # Each Discord off -> on remounts the panel, which repeats exactly these calls.
                code, saved = self.request('GET', '/api/tesseract/settings')
                self.assertEqual(code, 200)
                self.assertTrue(saved['connected'])
                self.assertTrue(saved['hasCredentials'])
                self.assertEqual(saved['guildId'], '123')
                self.assertNotIn('botToken', saved); self.assertNotIn('apiKey', saved)
                self.assertEqual(self.request('GET', '/api/tesseract/servers')[0], 200)
            # Saving settings with blank secret fields keeps the running bot instead of asking again.
            self.assertEqual(self.request('POST', '/api/tesseract/connect', {**creds, 'botToken': '', 'apiKey': ''})[0], 200)
        self.assertEqual(start.call_count, 1)
        self.assertIsNone(bot.poll())

    def test_manual_tasks_are_real_local_records(self):
        code, task = self.request('POST', '/api/tasks', {'title': 'Actual user task', 'view': 'student', 'kind': 'task', 'status': 'todo'})
        self.assertEqual(code, 201)
        self.assertEqual(len(self.request('GET', '/api/tasks')[1]['items']), 1)
        self.assertEqual(self.request('PATCH', '/api/tasks/' + task['id'], {'status': 'done'})[1]['status'], 'done')
        self.assertEqual(self.request('DELETE', '/api/tasks/' + task['id'], {})[0], 200)
        self.assertEqual(self.request('GET', '/api/tasks')[1]['items'], [])

    def test_canvas_connect_and_import_never_returns_or_saves_token(self):
        class FakeCanvas:
            def __init__(self, base, token):
                self.base = base
            def get(self, _):
                return {'id': 7, 'name': 'Fixture account'}, ''
            def courses(self):
                return [{'id': 10, 'name': 'Fixture course', 'roles': ['ta'], 'view': 'grader',
                         'termStart': '2000-01-01T00:00:00Z', 'termEnd': '2100-01-01T00:00:00Z'}]
            def assignments(self, _):
                return [{'id': 42, 'name': 'Fixture assignment', 'due_at': '2026-11-02T06:59:00Z'}]
        with patch('server.Canvas', FakeCanvas):
            code, result = self.request('POST', '/api/local/canvas/connect', {'url': 'https://canvas.asu.edu', 'token': 'fake-private-token'})
        self.assertEqual(code, 200)
        self.assertNotIn('fake-private-token', json.dumps(result))
        self.assertNotIn('fake-private-token', (Path(self.folder.name) / 'connections.json').read_text())
        code, result = self.request('POST', '/api/local/canvas/sync', {'courses': [{'id': 10, 'view': 'grader'}]})
        self.assertEqual((code, result['imported']), (200, 1))
        task = self.request('GET', '/api/tasks')[1]['items'][0]
        self.assertEqual(task['source'], 'canvas')
        self.assertIsNone(task['grading']['gradingDueAt'])
        self.assertIsNone(task['grading']['studentsSubmitted'])

    def test_connecting_messages_never_sends_a_message(self):
        class Reader:
            def __init__(self, handle): self.handle = handle
            def rows(self, _=200): return [{'id': 'fixture', 'text': 'Fixture message'}]
            def send(self, _): raise AssertionError('Connect must not send')
        with patch('server.Messages', Reader):
            self.assertEqual(self.request('POST', '/api/local/imessage/connect', {'handle': '+15551234567'})[0], 200)
        self.assertEqual(self.request('GET', '/api/chat/messages')[1]['items'][0]['text'], 'Fixture message')

    def test_job_sync_reports_missing_connection_and_workbook(self):
        code, result = self.request('POST', '/api/local/jobs/sync', {})
        self.assertEqual(code, 400)
        self.assertIn('Connect your Cubbie', result['message'])
        from unittest.mock import Mock
        self.http.state.messages = Mock()
        self.http.state.messages.latest_jobs_workbook.return_value = None
        code, result = self.request('POST', '/api/local/jobs/sync', {})
        self.assertEqual(code, 400)
        self.assertIn('No jobs workbook', result['message'])

    def test_job_sync_updates_stages_and_reimports_without_duplicates_or_sending(self):
        from test_jobs import workbook, HEAD
        from unittest.mock import Mock
        path = Path(self.folder.name) / 'cubboard-jobs.xlsx'
        reader = Mock()
        reader.latest_jobs_workbook.return_value = {'id': 1, 'name': path.name, 'path': path}
        self.http.state.messages = reader
        workbook(path, [HEAD, ['Acme', 'Engineer', 'Applied', ''],
                       ['Northwind', 'Analyst', 'Online assessment', ''],
                       ['Harbor', 'Intern', 'Interview stage', ''],
                       ['Closed Co', 'Intern', 'Rejected', '']])
        for _ in range(2):
            code, result = self.request('POST', '/api/local/jobs/sync', {})
            self.assertEqual((code, result['active'], result['skipped']), (200, 3, 1))
            self.assertEqual(len(self.http.state.tasks()), 3)
        workbook(path, [HEAD, ['Acme', 'Engineer', 'Interview stage', '']])
        self.assertEqual(self.request('POST', '/api/local/jobs/sync', {})[0], 200)
        (card,) = self.http.state.tasks()
        self.assertEqual((card['status'], card['job']['stage']), ('interview', 'interview'))
        path.write_bytes(b'broken workbook')
        self.assertEqual(self.request('POST', '/api/local/jobs/sync', {})[0], 400)
        self.assertEqual(self.http.state.tasks(), [card])
        reader.send.assert_not_called()
        self.assertEqual(self.request('POST', '/api/local/jobs/sync', {}, {'Cookie': ''})[0], 403)


if __name__ == '__main__':
    unittest.main()
