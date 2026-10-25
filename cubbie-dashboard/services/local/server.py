#!/usr/bin/env python3
"""Personal, loopback-only dashboard with direct Canvas and the selected Cubbie Messages thread."""
import argparse
from contextlib import contextmanager
import json
import mimetypes
import os
import re
from pathlib import Path
import secrets
import sqlite3
import threading
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit
import uuid

from canvas import Canvas, ConnectionError, assignment_task, course_activity, course_defaults, current_term
from messages import Messages

ROOT = Path(__file__).resolve().parents[2]


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


class State:
    def __init__(self, folder):
        self.folder = folder
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.sync_lock = threading.Lock()
        self.session = secrets.token_urlsafe(32)
        self.canvas = None
        self.canvas_error = None
        self.messages_error = None
        try:
            self.config = json.loads((folder / 'connections.json').read_text())
        except (OSError, ValueError):
            self.config = {}
        self.messages = Messages(self.config['handle']) if self.config.get('handle') else None
        path = folder / 'board.sqlite3'
        with database(path) as db:
            db.execute('CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
        os.chmod(path, 0o600)
        self.path = path

    def save_config(self):
        with self.lock:
            path = self.folder / 'connections.json'
            temporary = path.with_suffix('.tmp')
            with open(temporary, 'w', encoding='utf-8', opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
                json.dump(self.config, output)
            os.replace(temporary, path)

    def tasks(self, all_courses=False):
        with database(self.path) as db:
            tasks = [json.loads(row[0]) for row in db.execute('SELECT data FROM tasks ORDER BY id')]
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
        with self.lock, database(self.path) as db:
            for task in tasks:
                existing = db.execute('SELECT data FROM tasks WHERE id=?', (task['id'],)).fetchone()
                if existing:
                    old = json.loads(existing[0])
                    task['createdAt'] = old['createdAt']
                    if preserve_board_status and task['source'] == 'canvas' and task['status'] != 'done':
                        task['status'] = old.get('status', task['status'])
                    task['notes'] = old.get('notes') or task.get('notes')
                db.execute('INSERT OR REPLACE INTO tasks VALUES (?,?)', (task['id'], json.dumps(task)))

    def message_rows(self):
        if not self.messages:
            return []
        try:
            rows = self.messages.rows()
            self.messages_error = None
            return rows
        except ConnectionError as error:
            self.messages_error = str(error)
            return []

    def status(self):
        return {'mode': 'live', 'transport': 'local',
                'imessageRelay': 'online' if self.messages and not self.messages_error else 'offline' if self.messages else 'not_set_up',
                'relayDevice': 'this Mac', 'discord': 'not_linked',
                'canvas': {'connected': self.canvas is not None,
                           'graderAvailable': any(c.get('enrollmentView') == 'grader' or any(r in ('ta', 'teacher', 'taenrollment', 'teacherenrollment') for r in c.get('roles', []))
                                                  for c in self.connections()['courses']
                                                  if self.config.get('includeOtherCourses', False) or c.get('activity') == 'current'), 'lastSync': self.config.get('lastCanvasSync'),
                           'error': self.canvas_error, 'coverageNotes': self.config.get('coverageNotes', [])},
                'imessageError': self.messages_error}

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
            self.send_header('Set-Cookie', f'cubboard_session={self.state.session}; HttpOnly; SameSite=Strict; Path=/')
        self.end_headers()
        self.wfile.write(raw)

    def check_request(self, api=False):
        host = self.headers.get('Host', '')
        valid = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
        if host not in valid:
            raise PermissionError('This dashboard accepts only its local loopback address.')
        if api:
            cookies = SimpleCookie()
            cookies.load(self.headers.get('Cookie', ''))
            cookie = cookies.get('cubboard_session')
            if not cookie or not secrets.compare_digest(cookie.value, self.state.session):
                raise PermissionError('Open the dashboard in your browser before using its local API.')
            origin = self.headers.get('Origin')
            if (origin and origin != 'http://' + host) or (self.command != 'GET' and origin != 'http://' + host):
                raise PermissionError('This request did not originate from the local dashboard.')

    def body(self):
        size = int(self.headers.get('Content-Length', '0'))
        if size < 0 or size > 64_000:
            raise ValueError('Request exceeds the 64 KB limit.')
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            raise ValueError('Use a JSON request.')
        data = json.loads(self.rfile.read(size) or b'{}')
        if not isinstance(data, dict):
            raise ValueError('Expected a JSON object.')
        return data

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
            if path == '/api/local/canvas/connect' and self.command == 'POST':
                client = Canvas(data.get('url', 'https://canvas.asu.edu'), data.get('token', ''))
                identity, _ = client.get('/api/v1/users/self/profile')
                courses = client.courses()
                # A different Canvas user must not see the previous user's imported records.
                if self.state.config.get('canvasUserId') not in (None, identity['id']):
                    with database(self.state.path) as db:
                        for task in self.state.tasks(all_courses=True):
                            if task.get('source') == 'canvas':
                                db.execute('DELETE FROM tasks WHERE id=?', (task['id'],))
                    self.state.config.update(lastCanvasSync=None, coverageNotes=[])
                self.state.canvas = client
                self.state.canvas_error = None
                self.state.config.update(canvasUrl=client.base, canvasUserId=identity['id'],
                                         canvasAccount=identity.get('name'), courses=courses)
                self.state.save_config()
                return self.reply(200, self.state.connections())
            if path == '/api/local/canvas/sync' and self.command == 'POST':
                return self.reply(200, self.state.sync_canvas(data.get('courses'), data.get('includeOtherCourses') is True))
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
                    with database(self.state.path) as db:
                        db.execute('DELETE FROM tasks WHERE id=?', (task_id,))
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
        except (OSError, sqlite3.Error):
            return self.reply(500, {'message': 'The local operation failed. Check file permissions and the local server.'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8787)
    parser.add_argument('--state-dir', type=Path, default=Path.home() / '.config/cubboard-dashboard')
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.state = State(args.state_dir)
    print(f'Private dashboard: http://127.0.0.1:{server.server_port}/#student', flush=True)
    print('Open Settings to connect Canvas and the Cubbie chat. No sample data is loaded.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
