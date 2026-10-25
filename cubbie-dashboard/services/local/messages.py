"""Read only the chosen one-to-one Cubbie conversation on this Mac."""
import re
import sqlite3
import subprocess
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from canvas import ConnectionError


def handles(value):
    value = value.strip()
    if '@' in value:
        if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', value):
            raise ConnectionError('Enter Cubbie’s exact iMessage email or phone number.')
        return [value.lower()]
    digits = re.sub(r'\D', '', value)
    if not 10 <= len(digits) <= 15:
        raise ConnectionError('Enter Cubbie’s phone number with country code, or its iMessage email.')
    normalized = '+1' + digits if len(digits) == 10 else '+' + digits
    return list(set([value, digits, normalized]))


def body_text(blob):
    if not blob:
        return None
    marker = bytes(blob).find(b'NSString')
    if marker < 0:
        return None
    offset = marker + len(b'NSString') + 5
    if offset >= len(blob):
        return None
    length, offset = blob[offset], offset + 1
    width = 2 if length == 0x81 else 4 if length == 0x82 else 0
    if width:
        if offset + width > len(blob):
            return None
        length = int.from_bytes(blob[offset:offset + width], 'little')
        offset += width
    if offset + length > len(blob):
        return None
    try:
        return bytes(blob[offset:offset + length]).decode('utf-8')
    except UnicodeDecodeError:
        return None


class Messages:
    @staticmethod
    def discover(saved=None, path=None):
        """Find a named Cubbie contact/thread using metadata, never unrelated message text."""
        reader = Messages(saved or 'detect@cubbie.ai', path)
        with reader.connect() as db:
            rows = db.execute('''SELECT DISTINCT c.chat_identifier FROM chat c
                WHERE c.style=45 AND EXISTS (SELECT 1 FROM chat_message_join j
                  JOIN message m ON m.ROWID=j.message_id
                  WHERE j.chat_id=c.ROWID AND m.is_from_me=0)
                AND (lower(COALESCE(c.display_name,'')) IN ('cubbie','cubbie ai')
                     OR lower(c.chat_identifier) LIKE '%@cubbie.ai')''').fetchall()
            candidates = {row[0] for row in rows}
            if saved:
                marks = ','.join('?' for _ in reader.handles)
                found = db.execute(f'''SELECT c.chat_identifier FROM chat c WHERE c.style=45
                    AND c.chat_identifier IN ({marks}) AND EXISTS (SELECT 1 FROM chat_message_join j
                    JOIN message m ON m.ROWID=j.message_id WHERE j.chat_id=c.ROWID AND m.is_from_me=0)''', reader.handles).fetchall()
                candidates.update(row[0] for row in found)
        if candidates:
            return sorted(candidates)
        # Contacts resolves a one-to-one thread's display name, which chat.db often omits.
        script = '''tell application "Contacts"
          set foundValues to ""
          repeat with p in (every person whose name contains "Cubbie")
            repeat with n in phones of p
              set foundValues to foundValues & (value of n) & linefeed
            end repeat
            repeat with e in emails of p
              set foundValues to foundValues & (value of e) & linefeed
            end repeat
          end repeat
          return foundValues
        end tell'''
        try:
            result = subprocess.run(['osascript', '-e', script], capture_output=True, text=True, timeout=20)
            contacts = result.stdout.splitlines() if result.returncode == 0 else []
        except (OSError, subprocess.TimeoutExpired):
            contacts = []
        with reader.connect() as db:
            for value in contacts:
                try:
                    variants = handles(value)
                except ConnectionError:
                    continue
                marks = ','.join('?' for _ in variants)
                rows = db.execute(f'''SELECT c.chat_identifier FROM chat c WHERE c.style=45
                    AND c.chat_identifier IN ({marks}) AND EXISTS (SELECT 1 FROM chat_message_join j
                    JOIN message m ON m.ROWID=j.message_id WHERE j.chat_id=c.ROWID AND m.is_from_me=0)''', variants).fetchall()
                candidates.update(row[0] for row in rows)
        return sorted(candidates)

    def __init__(self, handle, path=None):
        self.handle = handle.strip()
        self.handles = handles(handle)
        self.path = Path(path) if path else Path.home() / 'Library/Messages/chat.db'

    @contextmanager
    def connect(self):
        try:
            connection = sqlite3.connect(self.path.resolve().as_uri() + '?mode=ro', uri=True, timeout=3)
            connection.row_factory = sqlite3.Row
            connection.execute('PRAGMA query_only=ON')
        except sqlite3.Error:
            raise ConnectionError('Messages is not readable. Give your terminal Full Disk Access in System Settings → Privacy & Security, then restart the local server.') from None
        try:
            yield connection
        finally:
            connection.close()

    def rows(self, limit=200):
        placeholders = ','.join('?' for _ in self.handles)
        sql = f'''SELECT DISTINCT m.ROWID as rowid, m.guid, m.text, m.attributedBody,
                     m.is_from_me, m.date, m.is_delivered, m.date_read
                  FROM message m JOIN chat_message_join cmj ON cmj.message_id=m.ROWID
                  JOIN chat c ON c.ROWID=cmj.chat_id
                  WHERE c.chat_identifier IN ({placeholders}) AND c.style=45
                    AND COALESCE(m.associated_message_type,0)=0
                  ORDER BY m.ROWID DESC LIMIT ?'''
        try:
            with self.connect() as connection:
                rows = connection.execute(sql, [*self.handles, limit]).fetchall()
                result = []
                for row in reversed(rows):
                    attachments = []
                    files = connection.execute('''SELECT a.ROWID as id,a.filename,a.mime_type,a.transfer_name
                        FROM attachment a JOIN message_attachment_join maj ON maj.attachment_id=a.ROWID
                        WHERE maj.message_id=?''', (row['rowid'],)).fetchall()
                    for file in files:
                        if file['mime_type'] in ('image/png', 'image/jpeg', 'image/gif', 'image/webp'):
                            attachments.append({'name': file['transfer_name'] or 'Image', 'mime': file['mime_type'],
                                                'url': f'/api/chat/attachments/{file["id"]}'})
                    text = (row['text'] or body_text(row['attributedBody']) or '').replace('\ufffc', '').strip()
                    if not text and not attachments:
                        text = '[Message content is not supported by this local reader]'
                    seconds = row['date'] / 1e9 if row['date'] > 1e12 else row['date']
                    result.append({'id': row['guid'], 'guid': row['guid'], 'text': text,
                                   'direction': 'out' if row['is_from_me'] else 'in',
                                   'at': datetime.fromtimestamp(seconds + 978307200, timezone.utc).isoformat(),
                                   'status': ('read' if row['date_read'] else 'delivered' if row['is_delivered'] else 'sent') if row['is_from_me'] else None,
                                   'attachments': attachments})
                return result
        except sqlite3.Error:
            raise ConnectionError('Could not read this Messages database. Check Full Disk Access and that Messages is signed in on this Mac.') from None

    def attachment(self, attachment_id):
        placeholders = ','.join('?' for _ in self.handles)
        with self.connect() as connection:
            row = connection.execute(f'''SELECT a.filename,a.mime_type FROM attachment a
                JOIN message_attachment_join maj ON maj.attachment_id=a.ROWID
                JOIN chat_message_join cmj ON cmj.message_id=maj.message_id
                JOIN chat c ON c.ROWID=cmj.chat_id
                WHERE a.ROWID=? AND c.chat_identifier IN ({placeholders}) AND c.style=45 LIMIT 1''',
                [attachment_id, *self.handles]).fetchone()
        if not row or row['mime_type'] not in ('image/png', 'image/jpeg', 'image/gif', 'image/webp'):
            raise ConnectionError('This image is not part of the connected Cubbie conversation.')
        path = Path(row['filename'] or '').expanduser().resolve()
        allowed = (Path.home() / 'Library/Messages/Attachments').resolve()
        if not path.is_relative_to(allowed) or not path.is_file() or path.stat().st_size > 20_000_000:
            raise ConnectionError('This attachment is not available locally or exceeds the 20 MB image preview limit.')
        return path, row['mime_type']

    def latest_jobs_workbook(self):
        """Newest cubboard-jobs*.xlsx that Cubbie (not you) sent in this one-to-one thread, or None."""
        placeholders = ','.join('?' for _ in self.handles)
        try:
            with self.connect() as connection:
                rows = connection.execute(f'''SELECT a.ROWID as id, a.filename, a.transfer_name, m.date
                    FROM attachment a JOIN message_attachment_join maj ON maj.attachment_id=a.ROWID
                    JOIN message m ON m.ROWID=maj.message_id
                    JOIN chat_message_join cmj ON cmj.message_id=m.ROWID
                    JOIN chat c ON c.ROWID=cmj.chat_id
                    WHERE c.chat_identifier IN ({placeholders}) AND c.style=45 AND m.is_from_me=0
                      AND lower(COALESCE(a.transfer_name, a.filename, '')) LIKE '%cubboard-jobs%.xlsx'
                    ORDER BY m.date DESC, a.ROWID DESC LIMIT 5''', self.handles).fetchall()
        except sqlite3.Error:
            raise ConnectionError('Could not read this Messages database. Check Full Disk Access and that Messages is signed in on this Mac.') from None
        allowed = (Path.home() / 'Library/Messages/Attachments').resolve()
        for row in rows:
            path = Path(row['filename'] or '').expanduser().resolve()
            if path.is_relative_to(allowed) and path.is_file() and path.stat().st_size <= 20_000_000:
                return {'id': row['id'], 'path': path, 'name': row['transfer_name'] or path.name}
        return None

    def send(self, text):
        # Called only from an explicit Send action in the dashboard. Nothing is sent on connect/sync.
        script = '''on run argv
tell application "Messages"
set svc to 1st account whose service type = iMessage
send (item 1 of argv) to participant (item 2 of argv) of svc
end tell
end run'''
        try:
            subprocess.run(['/usr/bin/osascript', '-e', script, text, self.handle],
                           check=True, capture_output=True, timeout=25)
        except (OSError, subprocess.SubprocessError):
            raise ConnectionError('Messages did not confirm sending. Check Automation → Messages permission and inspect the conversation before retrying.') from None
