"""Read-only personal Canvas API connection. Tokens stay in process memory."""
import json
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class ConnectionError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Canvas:
    def __init__(self, base, token):
        parsed = urlsplit(base)
        host = parsed.hostname or ''
        if (parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443)
                or parsed.path not in ('', '/') or parsed.query or parsed.fragment
                or not (host == 'canvas.asu.edu' or host.endswith('.instructure.com'))):
            raise ConnectionError('Use https://canvas.asu.edu or your institution’s HTTPS instructure.com origin.')
        if not isinstance(token, str) or not token.strip() or len(token) > 4096 or any(c.isspace() for c in token.strip()):
            raise ConnectionError('Enter your personal Canvas test token.')
        self.base, self.token = base.rstrip('/'), token.strip()
        self.origin = urlsplit(self.base).netloc
        self.opener = build_opener(NoRedirect())

    def get(self, path):
        url = self.base + path if path.startswith('/api/v1/') else path
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or parsed.netloc != self.origin or not parsed.path.startswith('/api/v1/'):
            raise ConnectionError('Stopped a Canvas link that leaves the connected API origin.')
        try:
            request = Request(url, headers={'Authorization': 'Bearer ' + self.token, 'Accept': 'application/json'}, method='GET')
            with self.opener.open(request, timeout=25) as response:
                return json.load(response), response.headers.get('Link', '')
        except HTTPError as exc:
            if exc.code == 401:
                raise ConnectionError('Canvas rejected the token. Check its expiration and Canvas domain (401).') from None
            if exc.code == 403:
                raise ConnectionError('Canvas denied access. Check this account’s course permissions (403).') from None
            if 300 <= exc.code < 400:
                raise ConnectionError('Canvas redirected to sign-in. Confirm ASU’s Canvas API hostname; no token was forwarded.') from None
            raise ConnectionError(f'Canvas returned HTTP {exc.code}.') from None
        except (URLError, TimeoutError):
            raise ConnectionError('Could not reach Canvas. Check your network and try again.') from None
        except (ValueError, UnicodeError):
            raise ConnectionError('Canvas returned a sign-in page or invalid JSON instead of API data.') from None

    def pages(self, path):
        rows, seen = [], set()
        while path:
            if path in seen or len(seen) >= 50:
                raise ConnectionError('Canvas pagination could not be completed; existing board data was preserved.')
            seen.add(path)
            data, links = self.get(path)
            if not isinstance(data, list):
                raise ConnectionError('Canvas returned an unexpected list response.')
            rows.extend(data)
            match = re.search(r'<([^>]+)>;\s*rel="next"', links)
            path = match.group(1) if match else None
        return rows

    def courses(self):
        rows = self.pages('/api/v1/courses?per_page=100&enrollment_state=active&include[]=enrollments')
        result = []
        for course in rows:
            roles = [str(e.get('type', e.get('role', ''))).lower() for e in course.get('enrollments', [])]
            if any(role in ('ta', 'teacher', 'taenrollment', 'teacherenrollment') for role in roles):
                view = 'grader'
            elif any(role in ('student', 'studentenrollment') for role in roles):
                view = 'student'
            else:
                view = 'skip'
            result.append({'id': course['id'], 'name': course.get('name') or course.get('course_code') or str(course['id']),
                           'roles': roles, 'view': view})
        return result

    def assignments(self, course):
        query = urlencode({'per_page': 100, 'include[]': 'submission' if course['view'] == 'student' else 'all_dates'})
        return self.pages(f'/api/v1/courses/{course["id"]}/assignments?{query}')


def whole(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def assignment_task(course, assignment, now):
    """Keep student due dates separate from staff deadlines; never derive actual submissions from grades."""
    grading = course['view'] == 'grader'
    submission = assignment.get('submission') or {}
    submitted = bool(submission.get('submitted_at')) or submission.get('workflow_state') == 'submitted'
    needs = whole(assignment.get('needs_grading_count'))
    due = assignment.get('due_at')
    variants = assignment.get('all_dates') or []
    dates = {d.get('due_at') for d in variants if 'due_at' in d}
    multiple = grading and len(dates) > 1
    if multiple:
        due = None
    task = {
        'id': f'canvas_{course["id"]}_{assignment["id"]}_{course["view"]}', 'source': 'canvas',
        'sourceId': f'canvas:course:{course["id"]}:assignment:{assignment["id"]}:{course["view"]}',
        'title': assignment.get('name') or 'Untitled assignment', 'view': course['view'],
        'kind': 'grading' if grading else 'assignment', 'course': course['name'],
        'status': ('done' if needs == 0 else 'todo') if grading else ('done' if submitted else 'todo'),
        'points': assignment.get('points_possible'), 'dueAt': None if grading else due,
        'dueLabel': 'Grading deadline not specified' if grading else ('No due date' if due is None else None),
        'url': assignment.get('html_url'), 'createdAt': now, 'updatedAt': now,
        'notes': 'Multiple student deadlines; open Canvas for section/student details.' if multiple else None,
    }
    if grading:
        task['grading'] = {'studentDueAt': due, 'gradingDueAt': None, 'needsGrading': needs,
                           'studentsSubmitted': None, 'eligibleStudents': None,
                           'section': 'Visible to your staff account'}
    return task
