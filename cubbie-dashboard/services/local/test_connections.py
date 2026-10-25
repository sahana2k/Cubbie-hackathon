import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone

from canvas import Canvas, ConnectionError, assignment_task, course_activity, course_defaults
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

    def test_assignment_publication_preserves_false_without_inventing_unknown(self):
        course = {'id': 1, 'name': 'Course', 'view': 'student'}
        for published in (True, False, None):
            with self.subTest(published=published):
                assignment = {'id': 2, 'published': published}
                self.assertIs(assignment_task(course, assignment, 'now').get('published'), published)

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
        courses = client.courses()
        self.assertEqual([c['view'] for c in courses], ['skip', 'skip'])
        self.assertEqual(courses[1]['enrollmentView'], 'grader')


class CurrentTermTests(unittest.TestCase):
    at = datetime(2026, 10, 24, 19, tzinfo=timezone.utc)

    def test_last_fall_and_future_spring_are_excluded(self):
        for name, activity in [('CSE 579 (2025 Fall C)', 'past'), ('CSE 579 (2026 Fall C)', 'current'),
                               ('CSE 579 (Spring 2027)', 'future')]:
            with self.subTest(name=name):
                self.assertEqual(course_activity({'name': name}, self.at)[0], activity)

    def test_canvas_session_dates_override_a_current_fall_label(self):
        course = {'name': 'Course (2026 Fall A)', 'termStart': '2026-08-20T00:00:00Z',
                  'termEnd': '2026-10-10T00:00:00Z'}
        self.assertEqual(course_activity(course, self.at)[0], 'past')

    def test_restricted_course_dates_override_term_dates(self):
        course = {'name': 'Fall 2026', 'termStart': '2026-08-01T00:00:00Z', 'termEnd': '2026-12-31T00:00:00Z',
                  'restrictToCourseDates': True, 'courseStart': '2026-11-01T00:00:00Z', 'courseEnd': '2026-12-31T00:00:00Z'}
        self.assertEqual(course_activity(course, self.at)[0], 'future')

    def test_term_dates_precede_unrestricted_old_course_dates(self):
        course = {'name': 'Course', 'termStart': '2026-08-01T00:00:00Z', 'termEnd': '2026-12-31T00:00:00Z',
                  'courseStart': '2025-01-01T00:00:00Z', 'courseEnd': '2025-12-31T00:00:00Z'}
        self.assertEqual(course_activity(course, self.at)[0], 'current')

    def test_unknown_training_and_concluded_courses_do_not_default_current(self):
        self.assertEqual(course_activity({'name': 'Assistant training'}, self.at)[0], 'unknown')
        self.assertEqual(course_activity({'name': 'Fall 2026', 'workflowState': 'completed'}, self.at)[0], 'past')

    def test_current_staff_course_is_selected_but_historical_staff_course_is_not(self):
        courses = [{'id': 1, 'name': 'CSE 579 (2026 Fall C)', 'view': 'grader'},
                   {'id': 2, 'name': 'CSE 579 (2025 Fall C)', 'view': 'grader'}]
        self.assertEqual([course['view'] for course in course_defaults(courses, at=self.at)], ['grader', 'skip'])
        self.assertEqual([course['view'] for course in course_defaults(courses, True, self.at)], ['grader', 'grader'])


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
    def test_restart_removes_canvas_snapshot_and_requires_fresh_verification(self):
        with tempfile.TemporaryDirectory() as folder:
            state = State(Path(folder))
            state.config.update(canvasAccount='Cached account', canvasUserId=1, courses=[{'id': 1}], handle='+15551112222')
            state.save_config()
            state.put_tasks([{'id': 'cached', 'source': 'canvas', 'createdAt': 'now'}])
            fresh = State(Path(folder))
            self.assertEqual(fresh.tasks(all_courses=True), [])
            self.assertIsNone(fresh.connections()['canvasAccount'])
            self.assertEqual(fresh.connections()['courses'], [])
            self.assertEqual(fresh.connections()['handle'], '')
            self.assertIsNone(fresh.messages)
            self.assertNotIn('Cached account', (Path(folder) / 'connections.json').read_text())

    def test_user_board_status_edit_is_kept_on_next_canvas_import(self):
        with tempfile.TemporaryDirectory() as folder:
            state = State(Path(folder))
            state.canvas = object()  # This fixture represents a verified Canvas session.
            task = {'id': 'canvas_task', 'source': 'canvas', 'view': 'grader', 'status': 'todo', 'createdAt': 'now'}
            state.put_tasks([task])
            state.put_tasks([{**task, 'status': 'in_progress'}])
            self.assertEqual(state.tasks()[0]['status'], 'in_progress')
            state.put_tasks([{**task, 'status': 'todo'}], preserve_board_status=True)
            self.assertEqual(state.tasks()[0]['status'], 'in_progress')

    def test_grader_availability_matches_visible_canvas_role_options(self):
        with tempfile.TemporaryDirectory() as folder:
            state = State(Path(folder))
            self.assertFalse(state.status()['canvas']['graderAvailable'])
            state.canvas = object()
            student = {'id': 1, 'name': 'Student', 'roles': ['student'], 'view': 'student',
                       'termStart': '2000-01-01T00:00:00Z', 'termEnd': '2100-01-01T00:00:00Z'}
            staff = {**student, 'id': 2, 'roles': ['ta'], 'view': 'grader'}
            state.config['courses'] = [student]
            self.assertFalse(state.status()['canvas']['graderAvailable'])
            state.config['courses'].append(staff)
            self.assertTrue(state.status()['canvas']['graderAvailable'])
            staff['termEnd'] = '2001-01-01T00:00:00Z'
            self.assertFalse(state.status()['canvas']['graderAvailable'])
            state.config['includeOtherCourses'] = True
            self.assertTrue(state.status()['canvas']['graderAvailable'])

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
            state.config['courses'] = [{'id': 1, 'name': 'Test', 'view': 'grader',
                                        'termStart': '2000-01-01T00:00:00Z', 'termEnd': '2100-01-01T00:00:00Z'}]
            state.put_tasks([{'id': 'existing', 'source': 'manual', 'view': 'grader', 'status': 'todo', 'createdAt': 'now'}])
            with self.assertRaises(ConnectionError):
                state.sync_canvas([{'id': 1, 'view': 'grader'}])
            self.assertEqual(len(state.tasks()), 1)

    def test_old_canvas_cards_are_hidden_without_deleting_snapshots(self):
        with tempfile.TemporaryDirectory() as folder:
            state = State(Path(folder))
            state.config['courses'] = [{'id': 1, 'name': 'Old course', 'view': 'student', 'termEnd': '2000-01-01T00:00:00Z'}]
            state.put_tasks([{'id': 'old', 'source': 'canvas', 'sourceId': 'canvas:course:1:assignment:2:student',
                              'view': 'student', 'status': 'todo', 'createdAt': 'now'}])
            self.assertEqual(state.tasks(), [])
            self.assertEqual(len(state.tasks(all_courses=True)), 1)

    def test_other_term_cannot_be_imported_without_explicit_override(self):
        with tempfile.TemporaryDirectory() as folder:
            state = State(Path(folder))
            state.canvas = object()
            state.config['courses'] = [{'id': 1, 'name': 'Old course', 'view': 'student', 'termEnd': '2000-01-01T00:00:00Z'}]
            with self.assertRaisesRegex(ConnectionError, 'Only current courses'):
                state.sync_canvas([{'id': 1, 'view': 'student'}])


if __name__ == '__main__':
    unittest.main()
