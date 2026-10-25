"""Import the Cubbridge jobs workbook that Cubbie sends in the connected iMessage conversation.

Cubbie runs in the cloud and cannot reach this Mac's 127.0.0.1 dashboard, so it delivers the job list as an
Excel attachment named cubboard-jobs-<date>.xlsx in the Cubbie thread. This module reads that workbook with the
standard library only and turns each row into a Job hunt card. Rejected and withdrawn applications are skipped.
"""
import hashlib
import re
import zipfile
from datetime import date, timedelta
from xml.etree import ElementTree

from canvas import ConnectionError

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
      'p': 'http://schemas.openxmlformats.org/package/2006/relationships'}
MAX_UNCOMPRESSED = 20_000_000
MAX_ROWS = 2000
WORKBOOK_NAME = re.compile(r'^cubboard-jobs.*\.xlsx$', re.I)

# Workbook status label -> board column. The Skill writes the first four; the rest are accepted defensively.
STATUS = {
    'applied': 'applied', 'online assessment': 'assessment', 'assessment': 'assessment',
    'interview stage': 'interview', 'interview': 'interview', 'offer': 'offer',
}
SKIPPED = {'rejected', 'withdrawn', 'closed'}
KIND = {'applied': 'application', 'assessment': 'assessment', 'interview': 'interview', 'offer': 'application'}
TITLE = {'applied': 'Applied', 'assessment': 'Online assessment', 'interview': 'Interview stage', 'offer': 'Offer'}


def _xml(archive, name):
    data = archive.read(name)
    # Workbooks never need a DOCTYPE; refusing one rules out entity-expansion tricks in a crafted file.
    if b'<!DOCTYPE' in data[:4096].upper() or b'<!ENTITY' in data.upper():
        raise ConnectionError('The jobs workbook contains unsupported XML and was not imported.')
    return ElementTree.fromstring(data)


def _column(ref):
    letters = re.match(r'[A-Z]+', ref or '')
    if not letters:
        return None
    n = 0
    for ch in letters.group(0):
        n = n * 26 + ord(ch) - 64
    return n - 1


def _sheet_rows(archive, target, shared):
    root = _xml(archive, target)
    rows = []
    for row in root.iterfind('.//m:sheetData/m:row', NS):
        values = {}
        for position, cell in enumerate(row.iterfind('m:c', NS)):
            index = _column(cell.get('r'))
            index = position if index is None else index
            kind = cell.get('t')
            if kind == 'inlineStr':
                value = ''.join(t.text or '' for t in cell.iterfind('.//m:t', NS))
            else:
                raw = cell.findtext('m:v', default='', namespaces=NS)
                value = shared[int(raw)] if kind == 's' and raw.isdigit() and int(raw) < len(shared) else raw
            values[index] = value.strip()
        if values:
            rows.append([values.get(i, '') for i in range(max(values) + 1)])
        if len(rows) > MAX_ROWS:
            raise ConnectionError('The jobs workbook has too many rows to import.')
    return rows


def read_workbook(path):
    """Return {sheet name (lowercase): rows} for a .xlsx file."""
    try:
        with zipfile.ZipFile(path) as archive:
            if sum(info.file_size for info in archive.infolist()) > MAX_UNCOMPRESSED or len(archive.infolist()) > 500:
                raise ConnectionError('The jobs workbook is too large to import.')
            shared = []
            if 'xl/sharedStrings.xml' in archive.namelist():
                for item in _xml(archive, 'xl/sharedStrings.xml').iterfind('m:si', NS):
                    shared.append(''.join(t.text or '' for t in item.iterfind('.//m:t', NS)))
            workbook = _xml(archive, 'xl/workbook.xml')
            rels = {rel.get('Id'): rel.get('Target') for rel in _xml(archive, 'xl/_rels/workbook.xml.rels').iterfind('p:Relationship', NS)}
            sheets = {}
            for sheet in workbook.iterfind('.//m:sheets/m:sheet', NS):
                target = rels.get(sheet.get(f'{{{NS["r"]}}}id'), '')
                target = target.lstrip('/') if target.startswith('/') else 'xl/' + target
                if target in archive.namelist():
                    sheets[(sheet.get('name') or '').strip().lower()] = _sheet_rows(archive, target, shared)
            return sheets
    except ImportError:
        raise ConnectionError('Python’s XML parser is unavailable. Restart the dashboard with /usr/bin/python3 services/local/server.py, then sync again.') from None
    except (zipfile.BadZipFile, KeyError, ElementTree.ParseError, OSError):
        raise ConnectionError('The jobs workbook could not be read. Ask Cubbie to send it again.') from None


def _records(rows):
    """Rows under a header row, as dicts keyed by normalized header text."""
    for start, row in enumerate(rows[:10]):
        headers = [re.sub(r'\s+', ' ', cell).strip().lower() for cell in row]
        if any(h.startswith('company') for h in headers):
            return [{headers[i]: (r[i] if i < len(r) else '') for i in range(len(headers)) if headers[i]} for r in rows[start + 1:]]
    return []


def _pick(record, *names):
    for name in names:
        for key, value in record.items():
            if key == name or key.startswith(name):
                return value.strip()
    return ''


def _iso_date(value):
    value = value.strip()
    if not value or value.lower().startswith('not verified'):
        return None
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        return value
    if re.fullmatch(r'\d{5}(\.0+)?', value):  # Excel date serial (1900 date system)
        return (date(1899, 12, 30) + timedelta(days=int(float(value)))).isoformat()
    return None


def jobs_from_workbook(path, now):
    """Parse the workbook into board tasks. Returns (tasks, skipped_count)."""
    sheets = read_workbook(path)
    rows = sheets.get('applications') or next(iter(sheets.values()), [])
    deadlines = {}
    for record in _records(sheets.get('assessments', [])):
        company = _pick(record, 'company')
        deadline = _pick(record, 'deadline')
        if company and deadline:
            deadlines.setdefault(company.lower(), deadline)
    tasks, skipped, seen = [], 0, set()
    for record in _records(rows):
        company, role = _pick(record, 'company'), _pick(record, 'role')
        label = _pick(record, 'status', 'stage').lower()
        if not company or not role:
            continue
        if label in SKIPPED or label.startswith('reject'):
            skipped += 1
            continue
        stage = STATUS.get(label, 'applied')
        key = f'{company.lower()}|{role.lower()}'
        if key in seen:
            continue
        seen.add(key)
        digest = hashlib.sha1(key.encode('utf-8')).hexdigest()[:16]
        applied_on = _iso_date(_pick(record, 'date applied', 'date'))
        deadline = deadlines.get(company.lower()) if stage == 'assessment' else None
        note = deadline or (f'Status not recognized: {label}' if label and label not in STATUS else None)
        job = {'company': company[:200], 'role': role[:200], 'stage': stage, 'applicationDate': applied_on,
               'applicationDateEvidence': 'Cubbridge workbook from Cubbie' if applied_on else None,
               'nextAction': None, 'calendarState': 'none'}
        if deadline:
            job['assessmentDeadlineText'] = deadline[:500]
        tasks.append({
            'id': f'cubbridge_{digest}', 'source': 'gmail', 'sourceId': f'cubbridge:{key}',
            'view': 'jobs', 'status': stage, 'kind': KIND[stage], 'title': TITLE[stage], 'course': None,
            'dueAt': None, 'dueLabel': note[:60] if note else None,
            'notes': None, 'job': job, 'createdAt': now, 'updatedAt': now})
    return tasks, skipped
