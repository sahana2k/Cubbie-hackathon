import json
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from canvas import ConnectionError
from jobs import jobs_from_workbook
from messages import Messages
from server import State, database


def workbook(path, applications, assessments=None, shared=True, sheet_name='Applications'):
    """Write a minimal real .xlsx (shared strings or inline strings, like Excel and other writers produce)."""
    strings = []

    def cell(ref, value):
        if isinstance(value, (int, float)):
            return f'<c r="{ref}"><v>{value}</v></c>'
        if shared:
            strings.append(value)
            return f'<c r="{ref}" t="s"><v>{len(strings) - 1}</v></c>'
        return f'<c r="{ref}" t="inlineStr"><is><t>{value}</t></is></c>'

    def sheet(rows):
        body = ''.join(f'<row r="{i + 1}">' + ''.join(cell(f'{chr(65 + j)}{i + 1}', v) for j, v in enumerate(r)) + '</row>'
                       for i, r in enumerate(rows))
        return ('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                f'<sheetData>{body}</sheetData></worksheet>')

    sheets = [(sheet_name, applications)] + ([('Assessments', assessments)] if assessments else [])
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        z.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                   'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
                   + ''.join(f'<sheet name="{n}" sheetId="{i + 1}" r:id="rId{i + 1}"/>' for i, (n, _) in enumerate(sheets))
                   + '</sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   + ''.join(f'<Relationship Id="rId{i + 1}" Target="worksheets/sheet{i + 1}.xml"/>' for i in range(len(sheets)))
                   + '</Relationships>')
        for i, (_, rows) in enumerate(sheets):
            z.writestr(f'xl/worksheets/sheet{i + 1}.xml', sheet(rows))
        if shared:
            z.writestr('xl/sharedStrings.xml', '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                       + ''.join(f'<si><t>{s}</t></si>' for s in strings) + '</sst>')


HEAD = ['Company name', 'Role applied', 'Status', 'Date applied']


class WorkbookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'cubboard-jobs-2026-10-25.xlsx'

    def tearDown(self):
        self.temp.cleanup()

    def test_status_labels_map_to_board_columns_and_rejected_is_skipped(self):
        workbook(self.path, [HEAD,
                             ['Northwind', 'Data Analyst Intern', 'Online assessment', '2026-10-12'],
                             ['Lumen Health', 'SWE Intern', 'Interview stage', 'Not verified'],
                             ['Harbor', 'Product Analyst', 'Applied', 46300],
                             ['Bluebird', 'Analytics Intern', 'Rejected', '2026-09-01'],
                             ['Mesa Labs', 'ML Intern', 'Withdrawn', '']])
        tasks, skipped = jobs_from_workbook(self.path, 'now')
        self.assertEqual(skipped, 2)
        self.assertEqual({t['job']['company']: t['status'] for t in tasks},
                         {'Northwind': 'assessment', 'Lumen Health': 'interview', 'Harbor': 'applied'})
        by = {t['job']['company']: t for t in tasks}
        self.assertEqual(by['Northwind']['title'], 'Online assessment')
        self.assertEqual(by['Northwind']['job']['applicationDate'], '2026-10-12')
        self.assertIsNone(by['Lumen Health']['job']['applicationDate'])          # "Not verified" stays unknown
        self.assertEqual(by['Harbor']['job']['applicationDate'], '2026-10-05')   # Excel date serial 46300
        self.assertTrue(all(t['view'] == 'jobs' for t in tasks))

    def test_inline_strings_and_assessment_deadlines(self):
        workbook(self.path, [HEAD, ['Northwind', 'Data Analyst Intern', 'Online assessment', '']],
                 assessments=[['Company name', 'Assessment', 'Deadline', 'Add to Google Calendar link'],
                              ['Northwind', 'SQL test', 'Oct 28, 2026, 5:00 PM MST', '']], shared=False)
        (task,), _ = jobs_from_workbook(self.path, 'now')
        self.assertEqual(task['job']['assessmentDeadlineText'], 'Oct 28, 2026, 5:00 PM MST')
        self.assertEqual(task['dueLabel'], 'Oct 28, 2026, 5:00 PM MST')

    def test_duplicates_collapse_and_ids_are_stable(self):
        workbook(self.path, [HEAD, ['Acme', 'Intern', 'Applied', ''], ['ACME', 'intern', 'Applied', '']])
        first, _ = jobs_from_workbook(self.path, 'now')
        again, _ = jobs_from_workbook(self.path, 'later')
        self.assertEqual(len(first), 1)
        self.assertEqual(first[0]['id'], again[0]['id'])

    def test_crafted_or_broken_files_are_refused(self):
        self.path.write_bytes(b'not a zip')
        with self.assertRaises(ConnectionError):
            jobs_from_workbook(self.path, 'now')

        with zipfile.ZipFile(self.path, 'w') as z:
            z.writestr('xl/workbook.xml', '<!DOCTYPE x [<!ENTITY a "aaaa">]><workbook/>')
            z.writestr('xl/_rels/workbook.xml.rels', '<Relationships/>')
        with self.assertRaises(ConnectionError):
            jobs_from_workbook(self.path, 'now')

    def test_missing_xml_parser_returns_an_actionable_import_error(self):
        workbook(self.path, [HEAD, ['Acme', 'Intern', 'Applied', '']])
        with mock.patch('jobs.ElementTree.fromstring', side_effect=ImportError('expat unavailable')):
            with self.assertRaisesRegex(ConnectionError, 'XML parser is unavailable'):
                jobs_from_workbook(self.path, 'now')


class ThreadImportTests(unittest.TestCase):
    """End to end: a workbook Cubbie sent in the thread becomes Job hunt cards in the local board."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.home = root / 'home'
        self.attachments = self.home / 'Library/Messages/Attachments'
        self.attachments.mkdir(parents=True)
        self.chat = root / 'chat.db'
        with database(self.chat) as db:
            db.executescript('''
              CREATE TABLE message(guid TEXT,text TEXT,attributedBody BLOB,is_from_me INTEGER,date INTEGER,is_delivered INTEGER,date_read INTEGER,associated_message_type INTEGER);
              CREATE TABLE chat(chat_identifier TEXT,style INTEGER);
              CREATE TABLE chat_message_join(chat_id INTEGER,message_id INTEGER);
              CREATE TABLE attachment(filename TEXT,mime_type TEXT,transfer_name TEXT);
              CREATE TABLE message_attachment_join(message_id INTEGER,attachment_id INTEGER);
              INSERT INTO chat VALUES ('+15551234567',45),('+15550000000',45);
            ''')
        self.patch = mock.patch('pathlib.Path.home', return_value=self.home)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def send(self, rows, chat=1, from_me=0, date=1_000_000_000, name='cubboard-jobs-2026-10-25.xlsx'):
        path = self.attachments / f'{date}-{chat}-{from_me}-{name}'
        workbook(path, rows)
        with database(self.chat) as db:
            db.execute('INSERT INTO message VALUES (?,?,NULL,?,?,0,0,0)', (f'm{date}{chat}{from_me}', '', from_me, date))
            message = db.execute('SELECT max(ROWID) FROM message').fetchone()[0]
            db.execute('INSERT INTO chat_message_join VALUES (?,?)', (chat, message))
            db.execute('INSERT INTO attachment VALUES (?,?,?)', (str(path), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name))
            db.execute('INSERT INTO message_attachment_join VALUES (?,?)', (message, db.execute('SELECT max(ROWID) FROM attachment').fetchone()[0]))

    def state(self):
        state = State(self.home / 'state')
        state.messages = Messages('+15551234567', self.chat)
        return state

    def jobs(self, state):
        return {t['job']['company']: t['status'] for t in state.tasks() if t.get('view') == 'jobs'}

    def test_latest_workbook_from_cubbie_is_imported_and_rejected_jobs_drop_off(self):
        state = self.state()
        state.put_tasks([{'id': 'mine', 'source': 'manual', 'view': 'jobs', 'status': 'applied', 'createdAt': 'x',
                          'job': {'company': 'My own entry', 'role': 'Intern', 'stage': 'applied'}}])
        self.send([HEAD, ['Northwind', 'Analyst', 'Online assessment', ''], ['Harbor', 'PM', 'Applied', '']], date=1_000_000_000)
        state.message_rows()
        self.assertEqual(self.jobs(state), {'My own entry': 'applied', 'Northwind': 'assessment', 'Harbor': 'applied'})
        # A newer workbook: Harbor was rejected, Northwind moved to interview.
        self.send([HEAD, ['Northwind', 'Analyst', 'Interview stage', ''], ['Harbor', 'PM', 'Rejected', '']], date=2_000_000_000)
        state.message_rows()
        self.assertEqual(self.jobs(state), {'My own entry': 'applied', 'Northwind': 'interview'})
        self.assertEqual(state.status()['jobs']['imported'], 1)
        self.assertEqual(state.status()['jobs']['skipped'], 1)

    def test_files_from_other_chats_or_sent_by_you_are_ignored(self):
        state = self.state()
        self.send([HEAD, ['Spoof', 'Role', 'Applied', '']], chat=2)            # a different conversation
        self.send([HEAD, ['Mine', 'Role', 'Applied', '']], from_me=1, date=2)  # a file you sent to Cubbie
        state.message_rows()
        self.assertEqual(self.jobs(state), {})

    def test_same_workbook_is_imported_once_and_board_notes_are_kept(self):
        state = self.state()
        self.send([HEAD, ['Northwind', 'Analyst', 'Applied', '']])
        state.message_rows()
        (card,) = [t for t in state.tasks() if t['id'].startswith('cubbridge_')]
        state.put_tasks([{**card, 'notes': 'Prep SQL joins'}])
        with mock.patch('server.jobs_from_workbook') as parse:
            state.message_rows()
            parse.assert_not_called()
        self.send([HEAD, ['Northwind', 'Analyst', 'Online assessment', '']], date=3_000_000_000)
        state.message_rows()
        (card,) = [t for t in state.tasks() if t['id'].startswith('cubbridge_')]
        self.assertEqual((card['status'], card['notes']), ('assessment', 'Prep SQL joins'))

    def test_unreadable_workbook_keeps_existing_cards(self):
        state = self.state()
        self.send([HEAD, ['Northwind', 'Analyst', 'Applied', '']])
        state.message_rows()
        self.send([['Nothing here']], date=4_000_000_000)
        state.message_rows()
        self.assertEqual(self.jobs(state), {'Northwind': 'applied'})
        self.assertIn('no job rows', state.status()['jobs']['error'])


if __name__ == '__main__':
    unittest.main()
