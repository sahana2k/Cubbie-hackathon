import http.client
import json
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


if __name__ == '__main__':
    unittest.main()
