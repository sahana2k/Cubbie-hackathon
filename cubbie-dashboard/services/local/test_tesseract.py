import tempfile
import unittest
from unittest.mock import patch, Mock
from urllib.error import HTTPError
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

    def test_remote_connection_needs_no_local_build_and_does_not_save_key(self):
        servers = {'servers': [{'id': '12345', 'name': 'Project team'}]}
        with patch.object(self.bridge, 'remote_get', return_value=servers) as read, patch('tesseract.subprocess.Popen') as spawn:
            self.assertEqual(self.bridge.connect({'remoteUrl': 'https://remote.example', 'remoteToken': 'private-bridge-key'}), servers)
            self.assertTrue(self.bridge.settings()['connected'])
            spawn.assert_not_called()
            self.bridge.request('/channels?guild=12345')
            read.assert_called_with('https://remote.example', 'private-bridge-key', '/channels?guild=12345')
        self.assertNotIn('private-bridge-key', (self.root / 'tesseract-settings.json').read_text())
        self.assertNotIn('private-bridge-key', str(self.bridge.settings()))
        restored = Tesseract(self.root, self.root)
        self.assertFalse(restored.settings()['connected'])
        self.assertFalse(restored.settings()['hasCredentials'])

    def test_failed_remote_edit_keeps_working_connection_and_never_reuses_key_off_origin(self):
        with patch.object(self.bridge, 'remote_get', return_value={'servers': [{'id': '12345', 'name': 'Team'}]}):
            self.bridge.connect({'remoteUrl': 'https://original.example', 'remoteToken': 'private-key'})
        with patch.object(self.bridge, 'remote_get', side_effect=ValueError('Unavailable')) as read:
            with self.assertRaisesRegex(ValueError, 'connection key'):
                self.bridge.connect({'remoteUrl': 'https://other.example', 'remoteToken': ''})
            read.assert_not_called()
            with self.assertRaisesRegex(ValueError, 'Unavailable'):
                self.bridge.connect({'remoteUrl': 'https://other.example', 'remoteToken': 'new-key'})
        self.assertEqual(self.bridge.remote_url, 'https://original.example')
        self.assertEqual(self.bridge.remote_token, 'private-key')
        self.assertTrue(self.bridge.settings()['connected'])

    def test_remote_origin_supports_https_or_tunnel_and_restricts_reads(self):
        self.assertEqual(Tesseract.remote_origin('http://127.0.0.1:8791/'), 'http://127.0.0.1:8791')
        for url in ('http://remote.example', 'https://user:secret@remote.example', 'https://remote.example?token=x', 'https://remote.example/path'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                Tesseract.remote_origin(url)
        for path in ('https://evil.example/servers', '/connect', '/disconnect', '/messages?guild=12345&channel=67890&token=x', '/snapshot?guild=12345'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                Tesseract.remote_path(path)
        self.assertEqual(Tesseract.remote_path('/snapshot?guild=12345&channel=67890'), '/snapshot?guild=12345&channel=67890')

    def test_remote_redirect_and_auth_errors_do_not_echo_keys(self):
        for code in (302, 401):
            opener = Mock()
            opener.open.side_effect = HTTPError('https://remote.example', code, 'private-key', {}, None)
            with patch('tesseract.build_opener', return_value=opener), self.assertRaises(ValueError) as error:
                Tesseract.remote_get('https://remote.example', 'private-key', '/servers')
            self.assertNotIn('private-key', str(error.exception))

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
