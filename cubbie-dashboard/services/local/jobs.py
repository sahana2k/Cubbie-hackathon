"""Extract explicit application statuses from incoming Cubbie messages; never infer a hiring stage."""
import hashlib
import json
import re
from datetime import datetime

ACTIVE = {'applied', 'assessment', 'interview'}
STATUSES = {s: s for s in (*ACTIVE, 'rejected', 'withdrawn', 'offer')}
STATUSES.update({'application submitted': 'applied', 'assessment invited': 'assessment',
                 'interview scheduled': 'interview', 'not selected': 'rejected'})

SYNC_PROMPT = '''Sync my Job hunt board from all accessible job-application context in my connected Gmail and our chat. Read actual application confirmations, assessments, interviews, and rejection updates; paginate where possible. Exclude generic job ads and do not assume a hiring status from a company mention or missing email.
Reply using one plain-text block per application, separated by a blank line:
Company: actual company
Role: actual role
Status: Applied, Assessment, Interview, Rejected, Withdrawn, or Offer (only when explicitly evidenced)
Status evidence: short quote supporting that status
Requisition: actual ID if known
Applied: YYYY-MM-DD only if the actual application date is verified
Assessment due: ISO date/time with offset if verified, otherwise the original deadline wording
Interview at: ISO date/time with offset if verified
Next action: verified next step if available
Omit unknown fields. Omit applications whose status is not verified. Include rejection/withdrawal updates so the board can remove old cards; those applications are hidden on the board. Keep different roles and requisitions separate. For many applications, send multiple messages. Report any incomplete Gmail coverage; never claim all mail was checked if it was not. Do not send applications or outreach. If Gmail is disconnected, tell me to connect it.'''


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed if parsed.tzinfo else None
    except (ValueError, TypeError, AttributeError):
        return None


def normalized(value):
    return ' '.join(value.casefold().split())


def updates(message):
    if message.get('direction') != 'in' or not message.get('id') or not timestamp(message.get('at')):
        return []
    text = message.get('text') or ''
    if not isinstance(text, str) or len(text) > 200_000:
        return []
    if re.search(r'\bfictional (?:demo|example)\b|^\s*(?:example output|template)\s*:', text, re.I | re.M):
        return []
    records, current = [], {}
    aliases = {'company': 'company', 'role': 'role', 'status': 'status', 'status evidence': 'evidence',
               'requisition': 'requisition', 'applied': 'applied', 'assessment due': 'assessment',
               'interview at': 'interview', 'next action': 'nextAction'}
    for raw in text.splitlines():
        line = re.sub(r'^\s*(?:[-*•]|\d+[.)])\s+', '', raw.replace('**', '')).strip()
        heading = re.fullmatch(r'([^:\n]{2,200})\s+[—–]\s+([^:\n]{2,200})', line)
        if heading:
            if current:
                records.append(current)
            current = {'company': heading.group(1).strip(), 'role': heading.group(2).strip()}
            continue
        match = re.match(r'^([A-Za-z ]+):\s*(.+)$', line)
        if not match:
            continue
        key = aliases.get(match.group(1).strip().lower())
        if key == 'company':
            if current:
                records.append(current)
            current = {}
        if key:
            current[key] = match.group(2).strip()
    if current:
        records.append(current)
    result = []
    for record in records:
        status = STATUSES.get(normalized(record.get('status', '')).rstrip('.'))
        if not status or not record.get('company') or not record.get('role'):
            continue
        if normalized(record['company']) in ('actual company', 'company name', 'company') or '<' in record['company'] or '<' in record['role']:
            continue
        if len(record['company']) > 200 or len(record['role']) > 200:
            continue
        record.update(status=status, messageId=message['id'], at=message['at'])
        record['evidence'] = record.get('evidence', 'Status: ' + status.title())[:1000]
        result.append(record)
    return result


def ingest(db, scope, messages):
    """Store explicit evidence and terminal states; an omitted application is never a rejection."""
    changed = 0
    ordered = sorted(messages, key=lambda message: timestamp(message.get('at')).timestamp() if timestamp(message.get('at')) else 0)
    for message in ordered:
        if message.get('direction') != 'in':
            continue
        fingerprint = hashlib.sha256(json.dumps(message, sort_keys=True).encode()).hexdigest()
        if db.execute('SELECT 1 FROM job_messages WHERE scope=? AND fingerprint=?', (scope, fingerprint)).fetchone():
            continue
        for record in updates(message):
            identity = normalized(record['company']) + '\0' + normalized(record['role'])
            existing = [(key, json.loads(data)) for key, data in db.execute(
                'SELECT application_key,data FROM job_records WHERE scope=?', (scope,))]
            matches = [(key, old) for key, old in existing if old['identity'] == identity]
            requisition = normalized(record.get('requisition', ''))
            if not requisition and len(matches) > 1:
                continue  # Do not apply an ambiguous update to multiple requisitions.
            key = identity + '\0' + requisition
            previous = None
            for old_key, old in matches:
                if old.get('requisition', '') == requisition or (len(matches) == 1 and (not requisition or not old.get('requisition'))):
                    key, previous = old_key, old
                    break
            if previous:
                if timestamp(record['at']) < timestamp(previous['at']):
                    continue
                if previous['status'] == 'rejected' and record['status'] != 'rejected':
                    continue  # Repeated acknowledgements do not reopen a rejected application.
            merged = {**(previous or {}), **record, 'identity': identity,
                      'requisition': requisition or (previous or {}).get('requisition', ''),
                      'createdAt': (previous or {}).get('createdAt', record['at'])}
            db.execute('INSERT OR REPLACE INTO job_records VALUES (?,?,?)', (scope, key, json.dumps(merged)))
            task_id = 'job_' + hashlib.sha256((scope + '\0' + key).encode()).hexdigest()[:24]
            application_date = merged.get('applied')
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', application_date or ''):
                application_date = None
            else:
                try:
                    datetime.strptime(application_date, '%Y-%m-%d')
                except ValueError:
                    application_date = None
            assessment = merged.get('assessment')
            interview = merged.get('interview')
            assessment_at = assessment if timestamp(assessment) else None
            interview_at = interview if timestamp(interview) else None
            due = assessment_at if merged['status'] == 'assessment' else interview_at if merged['status'] == 'interview' else None
            job = {'company': merged['company'], 'role': merged['role'], 'stage': merged['status'],
                   'applicationDate': application_date,
                   'applicationDateEvidence': 'Applied: ' + application_date if application_date else None,
                   'assessmentDeadline': assessment_at, 'assessmentDeadlineText': assessment if not assessment_at else None,
                   'interviewAt': interview_at, 'nextAction': merged.get('nextAction'),
                   'statusEvidence': merged['evidence'], 'statusMessageId': merged['messageId'], 'statusAt': merged['at']}
            task = {'id': task_id, 'view': 'jobs', 'kind': 'application' if merged['status'] == 'applied' else merged['status'] if merged['status'] in ACTIVE else 'application',
                    'title': merged['role'], 'source': 'cubbie', 'sourceId': 'imessage-job:' + scope + ':' + task_id,
                    'status': merged['status'], 'job': job, 'dueAt': due,
                    'dueLabel': 'Deadline not verified' if not due else None,
                    'notes': merged['evidence'], 'createdAt': (previous or {}).get('createdAt', merged['at']), 'updatedAt': merged['at']}
            db.execute('INSERT OR REPLACE INTO tasks VALUES (?,?)', (task_id, json.dumps(task)))
            changed += 1
        db.execute('INSERT OR IGNORE INTO job_messages VALUES (?,?)', (scope, fingerprint))
    return changed
