from pathlib import Path
import tempfile
import unittest

from jobs import updates, SYNC_PROMPT
from server import State


def message(status='Applied', role='Software Engineer', at='2026-10-24T18:00:00-07:00', id='m1', extra=''):
    return {'id': id, 'at': at, 'direction': 'in',
            'text': f'Company: FixtureCo\nRole: {role}\nStatus: {status}\nStatus evidence: Confirmed {status}\n{extra}'}


class JobTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.state = State(Path(self.folder.name))
        self.state.config['handle'] = '+15551234567'

    def tearDown(self):
        self.folder.cleanup()

    def test_incoming_explicit_status_creates_provenanced_card(self):
        self.state.import_jobs([message()])
        task = self.state.tasks()[0]
        self.assertEqual(task['status'], 'applied')
        self.assertEqual(task['job']['statusMessageId'], 'm1')
        self.assertIsNone(task['job']['applicationDate'])

    def test_outgoing_unknown_and_fictional_messages_are_not_applications(self):
        for incoming in [dict(message(), direction='out'), message('Maybe applied'),
                         dict(message(), text='You might like FixtureCo. They have interviews.'),
                         dict(message(), text='Fictional demo\n' + message()['text'])]:
            self.assertEqual(updates(incoming), [])
        self.assertEqual(updates(dict(message(), text='Company: FixtureCo\nRole: Engineer\nApplied: 2026-10-01')), [])

    def test_repeated_history_scan_is_idempotent(self):
        self.assertEqual(self.state.import_jobs([message()]), 1)
        self.assertEqual(self.state.import_jobs([message()]), 0)
        self.assertEqual(len(self.state.tasks()), 1)

    def test_progression_updates_same_card_and_older_message_cannot_reverse_it(self):
        self.state.import_jobs([message()])
        self.state.import_jobs([message('Interview', at='2026-10-24T19:00:00-07:00', id='m2')])
        self.state.import_jobs([message('Applied', at='2026-10-23T19:00:00-07:00', id='older')])
        self.assertEqual(len(self.state.tasks()), 1)
        self.assertEqual(self.state.tasks()[0]['status'], 'interview')

    def test_rejection_removes_old_card_and_acknowledgement_does_not_reopen(self):
        self.state.import_jobs([message()])
        self.state.import_jobs([message('Rejected', at='2026-10-24T19:00:00-07:00', id='m2')])
        self.assertEqual(self.state.tasks(), [])
        self.state.import_jobs([message('Applied', at='2026-10-24T20:00:00-07:00', id='ack')])
        self.assertEqual(self.state.tasks(), [])

    def test_different_roles_and_requisitions_remain_separate(self):
        self.state.import_jobs([message(extra='Requisition: A'), message(role='Data Scientist', id='other'),
                                message(id='second', extra='Requisition: B')])
        self.assertEqual(len(self.state.tasks()), 3)
        self.state.import_jobs([message('Rejected', at='2026-10-24T19:00:00-07:00', id='rejectA', extra='Requisition: A')])
        self.assertEqual(len(self.state.tasks()), 2)
        self.state.import_jobs([message('Rejected', at='2026-10-24T20:00:00-07:00', id='ambiguous')])
        self.assertEqual(len(self.state.tasks()), 2)  # An ambiguous requisition update is not applied broadly.

    def test_company_role_heading_still_requires_explicit_status(self):
        record = dict(message(), text='FixtureCo — Engineer\nStatus: Assessment')
        self.assertEqual(updates(record)[0]['status'], 'assessment')

    def test_dates_without_timezone_stay_unverified(self):
        self.state.import_jobs([message('Assessment', extra='Assessment due: November 1\nApplied: 2026-10-01')])
        job = self.state.tasks()[0]['job']
        self.assertIsNone(job['assessmentDeadline'])
        self.assertEqual(job['assessmentDeadlineText'], 'November 1')
        self.assertEqual(job['applicationDate'], '2026-10-01')

    def test_new_cubbie_messages_are_imported_during_normal_polling(self):
        class Reader:
            def rows(self, limit=200): return [message('Interview')]
            def send(self, text): raise AssertionError('Automatic chat polling must not send messages')
        self.state.messages = Reader()
        self.state.message_rows()
        self.assertEqual(self.state.tasks()[0]['status'], 'interview')

    def test_manual_sync_reads_history_and_sends_only_refresh_request(self):
        sent = []
        class Reader:
            def rows(self, limit=200): return [message()]
            def send(self, text): sent.append(text)
        self.state.messages = Reader()
        result = self.state.sync_jobs()
        self.assertTrue(result['requested'])
        self.assertEqual(sent, [SYNC_PROMPT])

    def test_changing_selected_thread_hides_previous_thread_applications(self):
        self.state.import_jobs([message()])
        self.state.config['handle'] = '+15557654321'
        self.assertEqual(self.state.tasks(), [])
