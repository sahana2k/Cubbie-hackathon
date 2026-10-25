from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch, Mock

from messages import Messages
from canvas import ConnectionError


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.path = Path(self.folder.name) / 'chat.db'
        with sqlite3.connect(self.path) as db:
            db.executescript('''CREATE TABLE chat (chat_identifier TEXT, display_name TEXT, style INTEGER);
                CREATE TABLE message (is_from_me INTEGER);
                CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);''')

    def add(self, handle, name=None, style=45, outgoing=False):
        with sqlite3.connect(self.path) as db:
            chat = db.execute('INSERT INTO chat VALUES (?,?,?)', (handle, name, style)).lastrowid
            msg = db.execute('INSERT INTO message VALUES (?)', (int(outgoing),)).lastrowid
            db.execute('INSERT INTO chat_message_join VALUES (?,?)', (chat, msg))

    def test_finds_named_incoming_conversation_without_reading_message_contents(self):
        self.add('+15551112222', 'Cubbie')
        self.add('+15552223333', 'Friend')
        self.add('+15553334444', 'Cubbie', style=43)
        self.add('+15554445555', 'Cubbie', outgoing=True)
        self.assertEqual(Messages.discover(path=self.path), ['+15551112222'])

    def test_saved_conversation_remains_a_verified_match(self):
        self.add('+15551112222')
        self.assertEqual(Messages.discover('+15551112222', path=self.path), ['+15551112222'])

    def test_multiple_matches_are_not_silently_selected(self):
        self.add('+15551112222', 'Cubbie')
        self.add('+15552223333', 'Cubbie AI')
        self.assertEqual(len(Messages.discover(path=self.path)), 2)

    def test_contacts_are_matched_against_incoming_one_to_one_chats(self):
        self.add('+15551112222')
        with patch('messages.subprocess.run', return_value=Mock(returncode=0, stdout='+1 (555) 111-2222\n')):
            self.assertEqual(Messages.discover(path=self.path), ['+15551112222'])

    def test_no_match_is_reported_honestly(self):
        self.add('+15552223333', 'Friend')
        with patch('messages.subprocess.run', return_value=Mock(returncode=1, stdout='')):
            self.assertEqual(Messages.discover(path=self.path), [])

    def test_unreadable_database_requests_full_disk_access(self):
        with self.assertRaisesRegex(ConnectionError, 'Full Disk Access'):
            Messages.discover(path=self.path.parent / 'missing.db')
