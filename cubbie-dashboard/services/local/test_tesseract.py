import tempfile
import unittest
from unittest.mock import Mock, patch
from pathlib import Path
from tesseract import Tesseract


class TesseractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.bridge = Tesseract(self.root, self.root)

    def tearDown(self):
        self.bridge.disconnect()
        self.temp.cleanup()

    def test_unconnected_bridge_does_not_proxy(self):
        with self.assertRaisesRegex(ValueError, 'Connect your Discord'):
            self.bridge.request('/snapshot')

    def test_missing_entry_is_built_for_direct_python_start(self):
        service = self.root / 'services/tesseract'
        (service / 'node_modules').mkdir(parents=True)
        entry = service / 'dist/index.js'
        def build(command, **kwargs):
            self.assertEqual(command[-3:], ['--filter', '@cubbie/tesseract', 'build'])
            self.assertEqual(kwargs['cwd'], self.root)
            entry.parent.mkdir()
            entry.write_text('// compiled fixture')
            return Mock(returncode=0)
        with patch('tesseract.shutil.which', side_effect=lambda name: '/test/pnpm' if name == 'pnpm' else None), patch('tesseract.subprocess.run', side_effect=build) as run:
            self.assertEqual(self.bridge.ensure_entry(), entry)
            self.assertEqual(run.call_count, 1)

    def test_fresh_checkout_installs_service_dependencies_before_build(self):
        service = self.root / 'services/tesseract'
        service.mkdir(parents=True)
        def prepare(command, **kwargs):
            if 'install' in command:
                self.assertIn('--frozen-lockfile', command)
                (service / 'node_modules').mkdir()
            else:
                self.assertTrue((service / 'node_modules').is_dir())
                (service / 'dist').mkdir()
                (service / 'dist/index.js').write_text('// compiled fixture')
            return Mock(returncode=0)
        with patch('tesseract.shutil.which', side_effect=lambda name: '/test/pnpm' if name == 'pnpm' else None), patch('tesseract.subprocess.run', side_effect=prepare) as run:
            self.assertTrue(self.bridge.ensure_entry().is_file())
            self.assertEqual(run.call_count, 2)

    def test_prepared_entry_is_reused_without_running_another_build(self):
        service = self.root / 'services/tesseract'
        (service / 'node_modules').mkdir(parents=True)
        (service / 'dist').mkdir()
        entry = service / 'dist/index.js'
        entry.write_text('// fixture')
        with patch('tesseract.subprocess.run') as run:
            self.assertEqual(self.bridge.ensure_entry(), entry)
            run.assert_not_called()

    def test_failed_or_incomplete_build_does_not_report_success(self):
        with patch('tesseract.shutil.which', side_effect=lambda name: '/test/pnpm' if name == 'pnpm' else None), patch('tesseract.subprocess.run', return_value=Mock(returncode=1, stderr='fixture-secret')):
            with self.assertRaisesRegex(ValueError, 'preparation failed') as error:
                self.bridge.ensure_entry()
            self.assertNotIn('fixture-secret', str(error.exception))
        with patch('tesseract.shutil.which', side_effect=lambda name: '/test/pnpm' if name == 'pnpm' else None), patch('tesseract.subprocess.run', return_value=Mock(returncode=0)):
            with self.assertRaisesRegex(ValueError, 'did not produce'):
                self.bridge.ensure_entry()

    def test_rejects_missing_credentials_without_writing_secrets(self):
        with self.assertRaises(ValueError):
            self.bridge.connect({'apiKey': 'test-secret'})
        self.assertEqual(list(self.root.iterdir()), [])

    def test_rejects_unsafe_endpoint_and_invalid_server_id(self):
        data = dict(apiKey='test-secret', botToken='test-bot', model='chosen', guildId='123', provider='custom')
        for url in ['http://example.com', 'https://user:password@example.com', 'https://example.com?token=key']:
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, 'HTTPS API'):
                self.bridge.connect({**data, 'baseUrl': url})
        with self.assertRaisesRegex(ValueError, 'numeric Discord'):
            self.bridge.connect({**data, 'guildId': '../../elsewhere'})
        self.assertEqual(list(self.root.iterdir()), [])

    def test_reuses_existing_bot_database_for_same_server_only(self):
        import sqlite3
        root = self.root / 'checkout/cubbie-dashboard'
        root.mkdir(parents=True)
        legacy = self.root / 'mergemates/data/mergemates.db'
        legacy.parent.mkdir(parents=True)
        with sqlite3.connect(legacy) as db:
            db.execute('CREATE TABLE projects (guild_id TEXT)')
            db.execute("INSERT INTO projects VALUES ('123')")
        bridge = Tesseract(root, self.root)
        self.assertEqual(bridge.database_path('123'), legacy.resolve())
        self.assertEqual(bridge.database_path('456'), self.root / 'tesseract-456.sqlite3')
        current = self.root / 'tesseract-123.sqlite3'
        with sqlite3.connect(current) as db:
            db.execute('CREATE TABLE projects (guild_id TEXT)')
            db.execute("INSERT INTO projects VALUES ('123')")
        self.assertEqual(bridge.database_path('123'), current)

    def test_saved_fields_survive_restart_but_secrets_are_never_written(self):
        import json
        from unittest.mock import Mock, patch
        data = dict(guildId='123', provider='anthropic', model='chosen', baseUrl='', botToken='private-bot', apiKey='private-key')
        with patch.object(self.bridge, '_connect', return_value={'servers': [{'id': '123'}]}):
            self.bridge.connect(data)
        path = self.root / 'tesseract-settings.json'
        text = path.read_text()
        self.assertNotIn('private-', text)
        restored = Tesseract(self.root, self.root)
        self.assertEqual(restored.settings()['guildId'], '123')
        self.assertEqual(restored.settings()['model'], 'chosen')
        self.assertFalse(restored.settings()['hasCredentials'])
        self.assertFalse(restored.settings()['connected'])
        self.assertNotIn('apiKey', json.loads(text))

    def test_blank_secrets_and_unchanged_save_do_not_disconnect(self):
        from unittest.mock import Mock, patch
        data = dict(guildId='123', provider='anthropic', model='chosen', baseUrl='', botToken='private-bot', apiKey='private-key')
        with patch.object(self.bridge, '_connect', return_value={'servers': []}):
            self.bridge.connect(data)
        self.bridge.process = Mock()
        self.bridge.process.poll.return_value = None
        self.bridge.port = 12345
        with patch.object(self.bridge, '_connect') as start, patch.object(self.bridge, 'request', return_value={'servers': []}):
            self.bridge.connect({**data, 'botToken': '', 'apiKey': ''})
            start.assert_not_called()
        self.assertEqual(self.bridge.credentials, data)
        self.assertTrue(self.bridge.settings()['connected'])
        self.bridge.process = None

    def test_failed_edit_restores_previous_connection_and_saved_settings(self):
        from unittest.mock import patch
        data = dict(guildId='123', provider='anthropic', model='chosen', baseUrl='', botToken='private-bot', apiKey='private-key')
        with patch.object(self.bridge, '_connect', return_value={'servers': []}):
            self.bridge.connect(data)
        saved = (self.root / 'tesseract-settings.json').read_text()
        with patch.object(self.bridge, '_connect', side_effect=[ValueError('bad model'), {'servers': []}]) as start:
            with self.assertRaisesRegex(ValueError, 'bad model'):
                self.bridge.connect({**data, 'model': 'invalid'})
            self.assertEqual(start.call_args_list[1].args[0], data)
        self.assertEqual(self.bridge.credentials, data)
        self.assertEqual((self.root / 'tesseract-settings.json').read_text(), saved)
