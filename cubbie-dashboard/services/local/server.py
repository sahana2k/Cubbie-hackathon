#!/usr/bin/env python3
"""Personal, loopback-only dashboard with direct Canvas and the selected Cubbie Messages thread."""
import argparse
import base64
import hashlib
from contextlib import contextmanager
import json
import mimetypes
import os
import re
from pathlib import Path
import secrets
import sqlite3
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit
import uuid

from canvas import Canvas, ConnectionError, assignment_task, course_activity, course_defaults, current_term
from jobs import jobs_from_workbook
from messages import Messages
from tesseract import Tesseract

ROOT = Path(__file__).resolve().parents[2]
# Hostnames the dashboard may be served under when hosted, e.g. "cubbie-tesseract.duckdns.org".
# Only set this when a reverse proxy in front (Caddy) enforces HTTPS and a login.
PUBLIC_HOSTS = {h.strip().lower() for h in os.environ.get('PUBLIC_HOSTS', '').split(',') if h.strip()}
# Optional team login for hosts without a proxy that adds one (Railway, Render). Browsers show a sign-in prompt.
DASHBOARD_USER = os.environ.get('DASHBOARD_USER', 'team')
DASHBOARD_PASSWORD = os.environ.get('DASHBOARD_PASSWORD', '')


def now():
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def database(path):
    connection = sqlite3.connect(path)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


DB_ERRORS = (sqlite3.Error,)
try:
    import psycopg
    DB_ERRORS += (psycopg.Error,)
except ImportError:  # only needed when DATABASE_URL points at PostgreSQL
    psycopg = None


class Board:
    """Board task storage: a SQLite file by default, PostgreSQL when DATABASE_URL is set."""

    def __init__(self, sqlite_path):
        self.url = os.environ.get('DATABASE_URL', '')
        self.postgres = self.url.startswith(('postgres://', 'postgresql://'))
        self.path = sqlite_path
        if self.postgres:
            if psycopg is None:
                raise RuntimeError('DATABASE_URL is PostgreSQL but psycopg is not installed: pip install "psycopg[binary]"')
            # board_tasks, not tasks: Tesseract already owns a "tasks" table in the same database.
            with self.connect() as db:
                db.execute('CREATE TABLE IF NOT EXISTS board_tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
        else:
            with database(sqlite_path) as db:
                db.execute('CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
            os.chmod(sqlite_path, 0o600)

    @contextmanager
    def connect(self):
        if not self.postgres:
            with database(self.path) as db:
                yield db
            return
        connection = psycopg.connect(self.url, connect_timeout=10)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def sql(self, query):
        """Write queries once in SQLite style; translate for PostgreSQL."""
        if not self.postgres:
            return query
        return query.replace('FROM tasks', 'FROM board_tasks').replace('?', '%s')

    def all(self):
        with self.connect() as db:
            return [json.loads(row[0]) for row in db.execute(self.sql('SELECT data FROM tasks ORDER BY id'))]

    def get(self, task_id, db):
        row = db.execute(self.sql('SELECT data FROM tasks WHERE id=?'), (task_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def put(self, task, db):
        if self.postgres:
            db.execute('INSERT INTO board_tasks (id, data) VALUES (%s, %s) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data',
                       (task['id'], json.dumps(task)))
        else:
            db.execute('INSERT OR REPLACE INTO tasks VALUES (?,?)', (task['id'], json.dumps(task)))

    def delete(self, task_id, db=None):
        if db is None:
            with self.connect() as db:
                return self.delete(task_id, db)
        db.execute(self.sql('DELETE FROM tasks WHERE id=?'), (task_id,))


class State:
    def __init__(self, folder):
        self.folder = folder
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.sync_lock = threading.Lock()
        self.session = secrets.token_urlsafe(32)
        self.tesseract = Tesseract(ROOT, folder.resolve())
        self.canvas = None
        self.canvas_error = None
        self.messages_error = None
        self.jobs_error = None
        try:
            self.config = json.loads((folder / 'connections.json').read_text())
        except (OSError, ValueError):
            self.config = {}
        self.messages = Messages(self.config['handle']) if self.config.get('handle') else None
        self.path = folder / 'board.sqlite3'
        self.board = Board(self.path)

    def save_config(self):
        with self.lock:
            path = self.folder / 'connections.json'
            temporary = path.with_suffix('.tmp')
            with open(temporary, 'w', encoding='utf-8', opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
                json.dump(self.config, output)
            os.replace(temporary, path)

    def tasks(self, all_courses=False):
        tasks = self.board.all()
        courses = self.config.get('courses', [])
        if all_courses or not courses:
            return tasks
        choices = {str(c['id']): c for c in course_defaults(courses, self.config.get('includeOtherCourses', False))}
        names = {c['name']: c for c in choices.values()}
        def visible(task):
            if task.get('source') != 'canvas':
                return True
            match = re.match(r'canvas:course:([^:]+):', task.get('sourceId') or '')
            course = choices.get(match.group(1)) if match else names.get(task.get('course'))
            return bool(course and course.get('view') == task.get('view') and course.get('view') != 'skip')
        return [task for task in tasks if visible(task)]

    def put_tasks(self, tasks, preserve_board_status=False):
        with self.lock, self.board.connect() as db:
            for task in tasks:
                old = self.board.get(task['id'], db)
                if old:
                    task['createdAt'] = old['createdAt']
                    if preserve_board_status and task['source'] == 'canvas' and task['status'] != 'done':
                        task['status'] = old.get('status', task['status'])
                    task['notes'] = old.get('notes') or task.get('notes')
                self.board.put(task, db)

    def message_rows(self):
        if not self.messages:
            return []
        try:
            rows = self.messages.rows()
            self.messages_error = None
            try:
                self.import_jobs()
            except Exception:  # a job-list problem must never break the chat pane
                self.jobs_error = 'The job list from Cubbie could not be imported. Ask Cubbie to send the workbook again.'
            return rows
        except ConnectionError as error:
            self.messages_error = str(error)
            return []

    def import_jobs(self, force=False):
        """Import Cubbie's newest cubboard-jobs*.xlsx from the thread, once per new attachment.

        Cards from the workbook replace earlier Cubbie-imported job cards (so rejected jobs drop off);
        jobs you added yourself on the board are never touched. Your notes on a card are kept.
        """
        finder = getattr(self.messages, 'latest_jobs_workbook', None)
        if not finder:
            if force:
                raise ConnectionError('Connect your Cubbie conversation in Settings before syncing jobs.')
            return
        try:
            found = finder()
        except ConnectionError:
            if force:
                raise
            return  # message_rows already reports Messages access problems
        if not found:
            if force:
                raise ConnectionError('No jobs workbook is available in your Cubbie conversation. Ask Cubbie for a cubboard-jobs-…xlsx applications workbook and download it in Messages, then sync again.')
            return
        with self.lock:
            if not force and self.config.get('jobsWorkbookId') == found['id']:
                return
            self.config['jobsWorkbookId'] = found['id']  # never retry the same file on every refresh
            try:
                tasks, skipped = jobs_from_workbook(found['path'], now())
                if not tasks and not skipped:
                    raise ConnectionError('The jobs workbook from Cubbie has no job rows. Existing job cards were kept.')
            except ConnectionError as error:
                self.jobs_error = str(error)
                self.save_config()
                if force:
                    raise
                return
            keep = {task['id'] for task in tasks}
            with self.board.connect() as db:
                for (task_id,) in db.execute(self.board.sql('SELECT id FROM tasks')).fetchall():
                    if task_id.startswith('cubbridge_') and task_id not in keep:
                        self.board.delete(task_id, db)
                for task in tasks:
                    old = self.board.get(task['id'], db)
                    if old:
                        task['createdAt'] = old['createdAt']
                        task['notes'] = old.get('notes') or task.get('notes')
                    self.board.put(task, db)
            self.config.update(lastJobsImport=now(), jobsImported=len(tasks), jobsSkipped=skipped, jobsWorkbook=found['name'])
            self.save_config()
            self.jobs_error = None
            return {'imported': len(tasks), 'active': sum(task['status'] in ('applied', 'assessment', 'interview') for task in tasks),
                    'skipped': skipped, 'workbook': found['name']}

    def status(self):
        return {'mode': 'live', 'transport': 'local',
                'imessageRelay': 'online' if self.messages and not self.messages_error else 'offline' if self.messages else 'not_set_up',
                'relayDevice': 'this Mac', 'discord': 'not_linked',
                'canvas': {'connected': self.canvas is not None,
                           'graderAvailable': any(c.get('enrollmentView') == 'grader' or any(r in ('ta', 'teacher', 'taenrollment', 'teacherenrollment') for r in c.get('roles', []))
                                                  for c in self.connections()['courses']
                                                  if self.config.get('includeOtherCourses', False) or c.get('activity') == 'current'), 'lastSync': self.config.get('lastCanvasSync'),
                           'error': self.canvas_error, 'coverageNotes': self.config.get('coverageNotes', [])},
                'imessageError': self.messages_error,
                'jobs': {'lastImport': self.config.get('lastJobsImport'), 'imported': self.config.get('jobsImported'),
                         'skipped': self.config.get('jobsSkipped'), 'workbook': self.config.get('jobsWorkbook'),
                         'error': self.jobs_error}}

    def connections(self):
        return {'canvasConnected': self.canvas is not None, 'canvasUrl': self.config.get('canvasUrl', 'https://canvas.asu.edu'),
                'canvasAccount': self.config.get('canvasAccount'),
                'courses': course_defaults(self.config.get('courses', []), self.config.get('includeOtherCourses', False)),
                'currentTermLabel': '%s %s' % current_term(),
                'includeOtherCourses': self.config.get('includeOtherCourses', False),
                'handle': self.config.get('handle', ''), 'lastSync': self.config.get('lastCanvasSync'),
                'coverageNotes': self.config.get('coverageNotes', []), 'canvasError': self.canvas_error,
                'imessageError': self.messages_error}

    def sync_canvas(self, requested, include_other=False):
        if not self.canvas:
            raise ConnectionError('Connect Canvas with your personal token first. It must be re-entered after a server restart.')
        if not self.sync_lock.acquire(blocking=False):
            raise ConnectionError('A Canvas sync is already running. Wait for it to finish.')
        try:
            allowed = {str(course['id']): course for course in self.config.get('courses', [])}
            if not isinstance(requested, list) or not requested:
                raise ConnectionError('Select at least one course and its student or grader role.')
            selected = []
            for choice in requested:
                if not isinstance(choice, dict) or str(choice.get('id')) not in allowed or choice.get('view') not in ('student', 'grader'):
                    raise ConnectionError('Choose a course returned by this Canvas connection and a valid role.')
                course = allowed[str(choice['id'])]
                if course_activity(course)[0] != 'current' and not include_other:
                    raise ConnectionError('Only current courses are selected by default. Enable “Show other courses” to explicitly import a different term.')
                selected.append({**course, 'view': choice['view']})
            tasks, notes = [], []
            for course in selected:
                try:
                    assignments = self.canvas.assignments(course)
                    tasks.extend(assignment_task(course, item, now()) for item in assignments)
                except ConnectionError as error:
                    notes.append(f'{course["name"]}: {error}')
            if not tasks and notes:
                self.canvas_error = notes[0]
                raise ConnectionError(notes[0] + ' Existing board data was preserved.')
            self.put_tasks(tasks, preserve_board_status=True)
            chosen = {str(c['id']): c['view'] for c in selected}
            for course in self.config['courses']:
                course['view'] = chosen.get(str(course['id']), 'skip')
            self.config.update(lastCanvasSync=now(), coverageNotes=notes, includeOtherCourses=bool(include_other))
            self.save_config()
            self.canvas_error = None
            return {'imported': len(tasks), 'coverageNotes': notes}
        finally:
            self.sync_lock.release()


INGEST_ORDER = {'student': ['todo', 'in_progress', 'partial', 'done'],
                'grader': ['todo', 'in_progress', 'partial', 'done'],
                'jobs': ['applied', 'assessment', 'interview', 'offer', 'closed']}


class Handler(BaseHTTPRequestHandler):
    @property
    def state(self):
        return self.server.state

    def log_message(self, *_):
        pass  # Never log message bodies, tokens, or request URLs.

    def reply(self, code, body=None, mime='application/json', cookie=False):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('X-Frame-Options', 'DENY')
        if cookie:
            secure = '; Secure' if PUBLIC_HOSTS else ''
            self.send_header('Set-Cookie', f'cubboard_session={self.state.session}; HttpOnly; SameSite=Strict; Path=/{secure}')
        self.end_headers()
        self.wfile.write(raw)

    def check_request(self, api=False):
        host = self.headers.get('Host', '')
        forwarded = self.headers.get('X-Forwarded-Host', '').split(',')[0].strip().lower()
        if forwarded in PUBLIC_HOSTS:  # platforms like Railway may pass the public name here
            host = forwarded
        valid = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
        public = host.lower() in PUBLIC_HOSTS  # set when hosted behind HTTPS (Caddy, Railway, …)
        if host not in valid and not public:
            raise PermissionError('This dashboard accepts only its local loopback address.')
        expected_origin = ('https://' if public else 'http://') + host
        if api:
            cookies = SimpleCookie()
            cookies.load(self.headers.get('Cookie', ''))
            cookie = cookies.get('cubboard_session')
            if not cookie or not secrets.compare_digest(cookie.value, self.state.session):
                raise PermissionError('Open the dashboard in your browser before using its local API.')
            origin = self.headers.get('Origin')
            if (origin and origin != expected_origin) or (self.command != 'GET' and origin != expected_origin):
                raise PermissionError('This request did not originate from the local dashboard.')

    def body(self, limit=64_000):
        size = int(self.headers.get('Content-Length', '0'))
        if size < 0 or size > limit:
            raise ValueError(f'Request exceeds the {limit // 1000} KB limit.')
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            raise ValueError('Use a JSON request.')
        data = json.loads(self.rfile.read(size) or b'{}')
        if not isinstance(data, dict):
            raise ValueError('Expected a JSON object.')
        return data

    def logged_in(self):
        header = self.headers.get('Authorization', '')
        if not header.startswith('Basic '):
            return False
        try:
            user, _, password = base64.b64decode(header[6:]).decode('utf-8').partition(':')
        except (ValueError, UnicodeDecodeError):
            return False
        return secrets.compare_digest(user, DASHBOARD_USER) and secrets.compare_digest(password, DASHBOARD_PASSWORD)

    def ask_login(self):
        raw = b'{"message": "Sign in with the team username and password."}'
        self.send_response(401)
        self.send_header('WWW-Authenticate', 'Basic realm="Cubbie dashboard", charset="UTF-8"')
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(raw)

    def ingest_cubbie(self):
        """POST /api/ingest/cubbie from the cubbie-dashboard-sync Skill (Canvas, Gmail, Cubbridge data).

        Same contract as the serverless handler: x-cubbie-key header, whole batch validated before any
        write, cards keyed by sourceId so re-syncs update, and a sync never moves a card backwards.
        """
        expected = os.environ.get('CUBBIE_INGEST_KEY', '')
        supplied = self.headers.get('x-cubbie-key', '')
        if not expected or not supplied or not secrets.compare_digest(supplied, expected):
            return self.reply(401, {'message': 'Missing or unknown x-cubbie-key.'})
        try:
            batch = self.body(limit=5_000_000)
            items = batch.get('tasks')
            if not isinstance(items, list) or len(items) > 2000:
                raise ValueError('tasks must be a list of at most 2000 items')
            for i, t in enumerate(items):
                if not isinstance(t, dict) or t.get('view') not in INGEST_ORDER:
                    raise ValueError(f'tasks[{i}].view must be student, grader or jobs')
                if not isinstance(t.get('title'), str) or not t['title'].strip() or not isinstance(t.get('status'), str):
                    raise ValueError(f'tasks[{i}] needs a title and status')
                if not isinstance(t.get('sourceId'), str) or not t['sourceId'] or len(t['sourceId']) > 300:
                    raise ValueError(f'tasks[{i}].sourceId is required')
            existing = {t['id']: t for t in self.state.tasks(all_courses=True)}
            stamp, merged = now(), []
            for item in items:
                task_id = 'src_' + hashlib.sha1(item['sourceId'].encode()).hexdigest()[:20]
                prev = existing.get(task_id)
                task = {'source': 'cubbie', **item, 'id': task_id, 'createdAt': prev['createdAt'] if prev else stamp, 'updatedAt': stamp}
                if prev:
                    order = INGEST_ORDER[task['view']]
                    if task['view'] != 'jobs' and prev.get('status') in order and task['status'] in order \
                            and order.index(prev['status']) > order.index(task['status']):
                        task['status'] = prev['status']
                    if 'progress' in prev or 'progress' in task:
                        task['progress'] = max(prev.get('progress') or 0, task.get('progress') or 0)
                    if prev.get('notes') or task.get('notes'):
                        task['notes'] = prev.get('notes') or task.get('notes')
                merged.append(task)
            changed = [t for t in merged if t['id'] not in existing or
                       {k: v for k, v in existing[t['id']].items() if k != 'updatedAt'} != {k: v for k, v in t.items() if k != 'updatedAt'}]
            self.state.put_tasks(changed)
            with self.state.lock:
                self.state.config.update(lastCubbieSync=batch.get('checkedAt'), coverageNotes=batch.get('coverageNotes', []))
                self.state.save_config()
            return self.reply(200, {'received': len(merged), 'written': len(changed), 'unchanged': len(merged) - len(changed),
                                    'coverageNotes': batch.get('coverageNotes', [])})
        except (ValueError, KeyError, TypeError) as error:
            return self.reply(400, {'message': str(error)})

    def do_GET(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch()

    def do_PATCH(self):
        self.dispatch()

    def do_DELETE(self):
        self.dispatch()

    def dispatch(self):
        path = urlsplit(self.path).path.rstrip('/') or '/'
        try:
            if path == '/api/ingest/cubbie' and self.command == 'POST':
                return self.ingest_cubbie()  # server-to-server: authenticated by key, not by browser session
            if DASHBOARD_PASSWORD and not self.logged_in():
                return self.ask_login()
            self.check_request(path.startswith('/api/'))
            if not path.startswith('/api/'):
                if self.command != 'GET':
                    return self.reply(405, {'message': 'Method not allowed'})
                if path == '/config.json':
                    return self.reply(200, {'apiUrl': '/api', 'localApi': True, 'stage': 'local'})
                dist = ROOT / 'apps/web/dist'
                target = (dist / unquote(path.lstrip('/'))).resolve()
                if not target.is_relative_to(dist.resolve()):
                    return self.reply(404, {'message': 'Not found'})
                if not target.is_file():
                    target = dist / 'index.html'
                if not target.exists():
                    return self.reply(503, {'message': 'Build the frontend first: corepack pnpm --filter @cubbie/web build'})
                return self.reply(200, target.read_bytes(), mimetypes.guess_type(target.name)[0] or 'application/octet-stream', cookie=target.name == 'index.html')
            if self.command == 'GET':
                if path.startswith('/api/tesseract/'):
                    route = path.removeprefix('/api/tesseract')
                    if route == '/settings':
                        return self.reply(200, self.state.tesseract.settings())
                    if route not in ('/servers', '/channels', '/snapshot', '/messages'):
                        return self.reply(404, {'message': 'Not found'})
                    query = urlsplit(self.path).query
                    return self.reply(200, self.state.tesseract.request(route + ('?' + query if query else '')))
                if path == '/api/tasks':
                    return self.reply(200, {'items': self.state.tasks()})
                if path == '/api/chat/messages':
                    return self.reply(200, {'items': self.state.message_rows()})
                if path == '/api/discord/messages':
                    return self.reply(200, {'items': []})
                if path == '/api/integrations/status':
                    return self.reply(200, self.state.status())
                if path == '/api/local/connections':
                    return self.reply(200, self.state.connections())
                if path.startswith('/api/chat/attachments/') and self.state.messages:
                    file, mime = self.state.messages.attachment(int(path.rsplit('/', 1)[1]))
                    return self.reply(200, file.read_bytes(), mime)
            data = self.body() if self.command != 'GET' else {}
            if path == '/api/tesseract/connect' and self.command == 'POST':
                return self.reply(200, self.state.tesseract.connect(data))
            if path == '/api/tesseract/disconnect' and self.command == 'POST':
                self.state.tesseract.disconnect()
                return self.reply(200, {'ok': True})
            if path == '/api/local/canvas/connect' and self.command == 'POST':
                client = Canvas(data.get('url', 'https://canvas.asu.edu'), data.get('token', ''))
                identity, _ = client.get('/api/v1/users/self/profile')
                courses = client.courses()
                # A different Canvas user must not see the previous user's imported records.
                if self.state.config.get('canvasUserId') not in (None, identity['id']):
                    for task in self.state.tasks(all_courses=True):
                        if task.get('source') == 'canvas':
                            self.state.board.delete(task['id'])
                    self.state.config.update(lastCanvasSync=None, coverageNotes=[])
                self.state.canvas = client
                self.state.canvas_error = None
                self.state.config.update(canvasUrl=client.base, canvasUserId=identity['id'],
                                         canvasAccount=identity.get('name'), courses=courses)
                self.state.save_config()
                return self.reply(200, self.state.connections())
            if path == '/api/local/canvas/sync' and self.command == 'POST':
                return self.reply(200, self.state.sync_canvas(data.get('courses'), data.get('includeOtherCourses') is True))
            if path == '/api/local/jobs/sync' and self.command == 'POST':
                return self.reply(200, self.state.import_jobs(force=True))
            if path == '/api/local/canvas/disconnect' and self.command == 'POST':
                self.state.canvas = None
                self.state.canvas_error = None
                return self.reply(200, {'ok': True})
            if path == '/api/local/imessage/connect' and self.command == 'POST':
                reader = Messages(str(data.get('handle', '')))
                if not reader.rows(1):
                    raise ConnectionError('No local one-to-one conversation matches that handle. Open the existing Cubbie thread in Messages and check its exact phone/email.')
                self.state.messages = reader
                self.state.messages_error = None
                self.state.config['handle'] = reader.handle
                self.state.save_config()
                return self.reply(200, self.state.connections())
            if path == '/api/local/imessage/disconnect' and self.command == 'POST':
                self.state.messages = None
                self.state.messages_error = None
                self.state.config.pop('handle', None)
                self.state.save_config()
                return self.reply(200, {'ok': True})
            if path == '/api/chat/messages' and self.command == 'POST':
                text = data.get('text')
                if not isinstance(text, str) or not text.strip() or len(text) > 4000:
                    raise ValueError('Enter a message of up to 4,000 characters.')
                if not self.state.messages:
                    raise ConnectionError('Connect the Cubbie conversation in Settings first.')
                self.state.messages.send(text.strip())
                return self.reply(201, {'id': 'pending_' + uuid.uuid4().hex, 'direction': 'out', 'text': text, 'at': now(), 'status': 'sent'})
            if path == '/api/tasks' and self.command == 'POST':
                if data.get('view') not in ('student', 'grader', 'jobs') or not isinstance(data.get('title'), str) or not data['title'].strip():
                    raise ValueError('A task needs a title and valid view.')
                task = {**data, 'id': uuid.uuid4().hex, 'source': 'manual', 'createdAt': now(), 'updatedAt': now()}
                self.state.put_tasks([task])
                return self.reply(201, task)
            if path.startswith('/api/tasks/') and self.command in ('PATCH', 'DELETE'):
                task_id = unquote(path.rsplit('/', 1)[1])
                old = next((t for t in self.state.tasks() if t['id'] == task_id), None)
                if old is None:
                    return self.reply(404, {'message': 'Task not found'})
                if self.command == 'DELETE':
                    self.state.board.delete(task_id)
                    return self.reply(200, {'ok': True})
                allowed = {'status', 'title', 'notes', 'priority', 'progress', 'dueAt', 'dueLabel'}
                task = {**old, **{k: v for k, v in data.items() if k in allowed}, 'updatedAt': now()}
                self.state.put_tasks([task])
                return self.reply(200, task)
            if path == '/api/summary' and self.command == 'POST':
                tasks = self.state.tasks()
                return self.reply(200, {'text': f'Your board contains {sum(t["view"] == "student" for t in tasks)} class items, '
                                              f'{sum(t["view"] == "grader" for t in tasks)} grading tasks, and '
                                              f'{sum(t["view"] == "jobs" for t in tasks)} career items. Review Upcoming for verified dates.'})
            return self.reply(404, {'message': 'This connection is not available in the local dashboard.'})
        except PermissionError as error:
            return self.reply(403, {'message': str(error)})
        except (ConnectionError, ValueError, KeyError, TypeError) as error:
            return self.reply(400, {'message': str(error)})
        except (OSError,) + DB_ERRORS:
            return self.reply(500, {'message': 'The local operation failed. Check file permissions and the local server.'})


def auto_connect_tesseract(state):
    """Hosted mode: start the Discord bot from environment variables instead of the Settings form."""
    if not os.environ.get('DISCORD_BOT_TOKEN'):
        return
    settings = {'botToken': os.environ['DISCORD_BOT_TOKEN'], 'guildId': os.environ.get('DISCORD_GUILD_ID', ''),
                'provider': os.environ.get('LLM_PROVIDER', 'anthropic'), 'model': os.environ.get('LLM_MODEL', 'claude-sonnet-5-5'),
                'apiKey': os.environ.get('LLM_API_KEY', ''), 'baseUrl': os.environ.get('LLM_BASE_URL', '')}
    def run():
        for attempt in range(5):
            try:
                state.tesseract.connect(settings)
                print('Tesseract connected to Discord.', flush=True)
                return
            except Exception as error:  # report and retry; never print the credentials
                print(f'Tesseract connect attempt {attempt + 1} failed: {error}', flush=True)
                threading.Event().wait(15)
    threading.Thread(target=run, daemon=True).start()


def main():
    # Some macOS Homebrew installations load an incompatible system libexpat.
    # Check before serving so workbook imports cannot fail midway through a request.
    from xml.etree import ElementTree
    try:
        ElementTree.fromstring('<check/>')
    except ImportError:
        fallback = '/usr/bin/python3'
        if sys.platform == 'darwin' and Path(sys.executable).resolve() != Path(fallback).resolve():
            check = subprocess.run([fallback, '-c', 'from xml.etree import ElementTree; ElementTree.fromstring("<check/>")'],
                                   capture_output=True)
            if check.returncode == 0:
                print('Using macOS system Python because the current XML parser is unavailable.', flush=True)
                os.execv(fallback, [fallback, str(Path(__file__).resolve()), *sys.argv[1:]])
        raise SystemExit('Python’s XML parser is unavailable. Install a working Python or use /usr/bin/python3 services/local/server.py.')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=int(os.environ.get('PORT', 8787)), help='Railway and Render set PORT')
    parser.add_argument('--host', default='127.0.0.1', help='0.0.0.0 inside Docker; keep 127.0.0.1 on a laptop')
    parser.add_argument('--state-dir', type=Path, default=Path.home() / '.config/cubboard-dashboard')
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.state = State(args.state_dir)
    auto_connect_tesseract(server.state)
    print(f'Private dashboard: http://127.0.0.1:{server.server_port}/#student', flush=True)
    print('Open Settings to connect Canvas and the Cubbie chat. No sample data is loaded.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.state.tesseract.disconnect()
        server.server_close()


if __name__ == '__main__':
    main()
