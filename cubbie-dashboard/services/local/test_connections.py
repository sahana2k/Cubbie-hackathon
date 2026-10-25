import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from canvas import Canvas, ConnectionError, assignment_task
from messages import Messages, body_text, handles
from server import State, database


class CanvasTests(unittest.TestCase):
    def test_auth_is_never_forwarded_off_origin(self):
        client = Canvas('https://canvas.asu.edu', 'test-only-token')
        for url in ('https://example.org/api/v1/courses', 'http://canvas.asu.edu/api/v1/courses', 'https://canvas.asu.edu/login'):
            with self.subTest(url=url), self.assertRaises(ConnectionError):
                client.get(url)

    def test_all_pages_are_read(self):
        client = Canvas('https://canvas.asu.edu', 'test-only-token')
        responses = iter([([{'id': 1}], '<https://canvas.asu.edu/api/v1/courses?page=2>; rel="next"'),
                          ([{'id': 2}], '')])
        client.get = lambda path: next(responses)
        self.assertEqual([row['id'] for row in client.pages('/api/v1/courses')], [1, 2])

    def test_grading_deadline_is_not_student_deadline(self):
        task = assignment_task({'id': 1, 'name': 'Test course', 'view': 'grader'},
                               {'id': 2, 'name': 'Lab', 'due_at': '2026-11-02T06:59:00Z', 'needs_grading_count': 5}, 'now')
        self.assertIsNone(task['dueAt'])
        self.assertIsNone(task['grading']['gradingDueAt'])
        self.assertEqual(task['grading']['studentDueAt'], '2026-11-02T06:59:00Z')
        self.assertIsNone(task['grading']['studentsSubmitted'])

    def test_section_dates_are_not_collapsed(self):
        task = assignment_task({'id': 1, 'name': 'Test', 'view': 'grader'},
                               {'id': 2, 'all_dates': [{'due_at': '2026-11-01T00:00:00Z'}, {'due_at': '2026-11-02T00:00:00Z'}]}, 'now')
        self.assertIsNone(task['grading']['studentDueAt'])
        self.assertIn('Multiple', task['notes'])

    def test_unknown_role_is_not_automatically_a_student(self):
        client = Canvas('https://canvas.asu.edu', 'test-only-token')
        client.pages = lambda _: [{'id': 1, 'name': 'Unknown', 'enrollments': []},
                                  {'id': 2, 'name': 'Staff', 'enrollments': [{'type': 'ta'}]}]
        self.assertEqual([c['view'] for c in client.courses()], ['skip', 'grader'])


class MessageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'chat.db'
        with database(self.path) as db:
            db.executescript('''
              CREATE TABLE message(guid TEXT,text TEXT,attributedBody BLOB,is_from_me INTEGER,date INTEGER,is_delivered INTEGER,date_read INTEGER,associated_message_type INTEGER);
              CREATE TABLE chat(chat_identifier TEXT,style INTEGER);
              CREATE TABLE chat_message_join(chat_id INTEGER,message_id INTEGER);
              CREATE TABLE attachment(filename TEXT,mime_type TEXT,transfer_name TEXT);
              CREATE TABLE message_attachment_join(message_id INTEGER,attachment_id INTEGER);
              INSERT INTO chat VALUES ('+15551234567',45),('+15550000000',45),('+15551234567',43);
              INSERT INTO message VALUES ('cubbie','Selected',NULL,0,1000000000,0,0,0),
                ('private','Private chat',NULL,0,1000000000,0,0,0),('group','Private group',NULL,0,1000000000,0,0,0),
                ('image','',NULL,0,1000000000,0,0,0);
              INSERT INTO chat_message_join VALUES (1,1),(2,2),(3,3),(1,4);
              INSERT INTO attachment VALUES ('/not-a-real-file.png','image/png','Card');
              INSERT INTO message_attachment_join VALUES (4,1);
            ''')

    def tearDown(self):
        self.temp.cleanup()

    def test_only_selected_one_to_one_thread_is_read(self):
        rows = Messages('+15551234567', self.path).rows()
        self.assertEqual([r['guid'] for r in rows], ['cubbie', 'image'])
        self.assertEqual(rows[1]['attachments'][0]['name'], 'Card')

    def test_email_never_expands_to_an_empty_phone_match(self):
        self.assertEqual(handles('cubbie@example.org'), ['cubbie@example.org'])
        with self.assertRaises(ConnectionError):
            handles('')

    def test_truncated_encoded_body_does_not_crash(self):
        self.assertIsNone(body_text(b'NSString' + b'12345' + bytes([0x82, 0x01])))

    def test_attachment_outside_messages_is_not_served(self):
        with self.assertRaises(ConnectionError):
            Messages('+15551234567', self.path).attachment(1)


class StorageTests(unittest.TestCase):
    def test_user_board_status_edit_is_kept_on_next_canvas_import(self):
        with tempfile.TemporaryDirectory() as folder:
            state = State(Path(folder))
            task = {'id': 'canvas_task', 'source': 'canvas', 'view': 'grader', 'status': 'todo', 'createdAt': 'now'}
            state.put_tasks([task])
            state.put_tasks([{**task, 'status': 'in_progress'}])
            self.assertEqual(state.tasks()[0]['status'], 'in_progress')
            state.put_tasks([{**task, 'status': 'todo'}], preserve_board_status=True)
            self.assertEqual(state.tasks()[0]['status'], 'in_progress')

    def test_no_demo_or_credentials_are_saved(self):
        with tempfile.TemporaryDirectory() as folder:
            state = State(Path(folder))
            self.assertEqual(state.tasks(), [])
            self.assertEqual(state.message_rows(), [])
            self.assertFalse(state.connections()['canvasConnected'])
            state.canvas = Canvas('https://canvas.asu.edu', 'private-test-token')
            state.config['canvasUrl'] = 'https://canvas.asu.edu'
            state.save_config()
            self.assertNotIn('private-test-token', (Path(folder) / 'connections.json').read_text())
            self.assertFalse(State(Path(folder)).connections()['canvasConnected'])

    def test_failed_course_import_preserves_existing_records(self):
        class Denied:
            def assignments(self, _):
                raise ConnectionError('Denied')
        with tempfile.TemporaryDirectory() as folder:
            state = State(Path(folder))
            state.canvas = Denied()
            state.config['courses'] = [{'id': 1, 'name': 'Test', 'view': 'grader'}]
            state.put_tasks([{'id': 'existing', 'source': 'manual', 'view': 'grader', 'status': 'todo', 'createdAt': 'now'}])
            with self.assertRaises(ConnectionError):
                state.sync_canvas([{'id': 1, 'view': 'grader'}])
            self.assertEqual(len(state.tasks()), 1)


if __name__ == '__main__':
    unittest.main()
