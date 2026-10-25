"""Loopback bridge to the bundled Discord agent. Secrets exist only in process memory."""
import json
import os
from pathlib import Path
import queue
import secrets
import shutil
import sqlite3
import subprocess
import threading
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


class Tesseract:
    def __init__(self, root, folder):
        self.root, self.folder = root, folder
        self.process = None
        self.port = None
        self.token = None
        self.lock = threading.RLock()
        self.credentials = None
        try:
            saved = json.loads((self.folder / 'tesseract-settings.json').read_text())
            self.metadata = {k: saved[k] for k in ('guildId', 'provider', 'model', 'baseUrl') if isinstance(saved.get(k), str)}
        except (OSError, ValueError, TypeError, AttributeError):
            self.metadata = {}

    def settings(self):
        with self.lock:
            return {**self.metadata, 'connected': bool(self.process and self.process.poll() is None and self.port),
                    'hasCredentials': self.credentials is not None}

    def disconnect(self):
        with self.lock:
            self._stop()
            self.credentials = None

    def connect(self, data):
        with self.lock:
            previous = self.credentials
            candidate = {**self.metadata, **data}
            for key in ('apiKey', 'botToken'):
                if not candidate.get(key) and previous:
                    candidate[key] = previous[key]
            if previous == candidate and self.settings()['connected']:
                return self.request('/servers')
            try:
                result = self._connect(candidate)
                metadata = {key: candidate.get(key, '') for key in ('guildId', 'provider', 'model', 'baseUrl')}
                path = self.folder / 'tesseract-settings.json'
                temporary = path.with_suffix('.tmp')
                with open(temporary, 'w', opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
                    json.dump(metadata, output)
                os.replace(temporary, path)
                self.metadata = metadata
                self.credentials = candidate
                return result
            except Exception as error:
                # A failed edit must not silently discard the working configuration.
                if previous and not self.settings()['connected']:
                    try:
                        self._connect(previous)
                    except Exception:
                        raise ValueError('The new settings failed and the previous connection could not restart. Your previous settings are retained; retry when the connection is available.') from None
                raise error

    def database_path(self, guild_id):
        """Reuse this workspace's existing bot state instead of silently starting empty."""
        configured = os.environ.get('TESSERACT_DATABASE_PATH')
        if configured:
            path = Path(configured).expanduser().resolve()
            if not path.is_file():
                raise ValueError('TESSERACT_DATABASE_PATH must point to an existing SQLite database.')
            return path
        current = self.folder / ('tesseract-' + guild_id + '.sqlite3')
        legacy = self.root.parent.parent / 'mergemates/data/mergemates.db'
        def has_project(path):
            if not path.is_file():
                return False
            try:
                connection = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)
                try:
                    return connection.execute('SELECT 1 FROM projects WHERE guild_id=? LIMIT 1', (guild_id,)).fetchone() is not None
                finally:
                    connection.close()
            except sqlite3.Error:
                return False
        if has_project(current):
            return current
        if has_project(legacy):
            return legacy.resolve()
        return current

    def _stop(self):
        with self.lock:
            if self.process:
                self.process.terminate()
                try:
                    self.process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
                if self.process.stdout:
                    self.process.stdout.close()
            self.process = self.port = self.token = None

    def ensure_entry(self):
        """Prepare the service even when Python was started without the npm launcher."""
        service = self.root / 'services/tesseract'
        entry = service / 'dist/index.js'
        sources = list((service / 'src').rglob('*.ts'))
        sources += [path for path in (service / 'package.json', service / 'tsconfig.json') if path.is_file()]
        if entry.is_file() and (service / 'node_modules').is_dir() and all(path.stat().st_mtime <= entry.stat().st_mtime for path in sources):
            return entry
        pnpm = shutil.which('pnpm')
        corepack = shutil.which('corepack')
        runner = [pnpm] if pnpm else [corepack, 'pnpm'] if corepack else None
        if not runner:
            raise ValueError('Tesseract needs Node.js and pnpm installed on the dashboard host. Install them, then retry Connect.')
        commands = []
        if not (service / 'node_modules').is_dir():
            commands.append([*runner, 'install', '--frozen-lockfile', '--filter', '@cubbie/tesseract...'])
        commands.append([*runner, '--filter', '@cubbie/tesseract', 'build'])
        for command in commands:
            try:
                result = subprocess.run(command, cwd=self.root, capture_output=True, text=True, timeout=180)
            except (OSError, subprocess.TimeoutExpired):
                raise ValueError('Tesseract preparation could not finish. In this dashboard folder run pnpm install, then pnpm build:tesseract, and retry Connect.') from None
            if result.returncode:
                raise ValueError('Tesseract preparation failed. In this dashboard folder run pnpm install, then pnpm build:tesseract to see the build error, and retry Connect.')
        if not entry.is_file():
            raise ValueError('The Tesseract build did not produce its entry file. Check this checkout with pnpm build:tesseract.')
        return entry

    def _connect(self, data):
        with self.lock:
            for key in ('botToken', 'apiKey', 'model', 'guildId'):
                if not isinstance(data.get(key), str) or not data[key].strip():
                    raise ValueError('Bot token, server ID, provider API key and model are required.')
            if not data['guildId'].isdigit():
                raise ValueError('Use a numeric Discord server ID.')
            if data.get('provider') not in ('anthropic', 'openai', 'gemini', 'groq', 'openrouter', 'custom'):
                raise ValueError('Choose a supported provider.')
            if data['provider'] == 'custom':
                from urllib.parse import urlsplit
                url = urlsplit(data.get('baseUrl', ''))
                if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
                    raise ValueError('Enter an HTTPS API base URL without credentials, query or fragment.')
            entry = self.ensure_entry()
            self._stop()
            self.token = secrets.token_urlsafe(32)
            env = {**os.environ, 'DISCORD_TOKEN': data['botToken'].strip(), 'DISCORD_CLIENT_ID': 'dashboard',
                   'DISCORD_GUILD_ID': data['guildId'], 'LLM_PROVIDER': data['provider'], 'LLM_MODEL': data['model'].strip(),
                   'LLM_API_KEY': data['apiKey'].strip(), 'LLM_BASE_URL': data.get('baseUrl', ''),
                   'DATABASE_PATH': str(self.database_path(data['guildId'])),
                   'TESSERACT_BRIDGE_TOKEN': self.token, 'LOG_LEVEL': 'error', 'PORT': '0'}
            self.process = subprocess.Popen(['node', str(entry)], cwd=entry.parent.parent, env=env,
                                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            ready = queue.Queue()
            process = self.process
            def drain():
                for line in process.stdout:
                    if line.startswith('TESSERACT_READY '):
                        ready.put(int(line.split()[1]))
                    elif line.startswith('TESSERACT_ERROR '):
                        ready.put(line.removeprefix('TESSERACT_ERROR ').strip())
                ready.put(None)
            threading.Thread(target=drain, daemon=True).start()
            try:
                result = ready.get(timeout=45)
                if isinstance(result, str):
                    raise ValueError(result)
                self.port = result
                if not self.port:
                    raise ValueError('Discord connection failed. Check the bot token and enable Message Content and Server Members intents.')
                result = self.request('/servers')
                if not result['servers']:
                    raise ValueError('The bot is not in this server. Invite it using the Discord Developer Portal, then reconnect.')
                return result
            except queue.Empty:
                self._stop()
                raise ValueError('Discord connection timed out. Check the token, intents and network, then retry.')
            except Exception:
                self._stop()
                raise

    def request(self, path):
        with self.lock:
            if not self.process or self.process.poll() is not None or not self.port:
                raise ValueError('Connect your Discord bot and LLM first. Reconnect after restarting the dashboard.')
            request = Request(f'http://127.0.0.1:{self.port}{path}', headers={'Authorization': 'Bearer ' + self.token})
            try:
                with urlopen(request, timeout=25) as response:
                    return json.load(response)
            except HTTPError as error:
                try:
                    message = json.load(error).get('message', 'Discord request failed.')
                except ValueError:
                    message = 'Discord request failed.'
                raise ValueError(message) from None
            except (URLError, TimeoutError):
                raise ValueError('Tesseract is unavailable. Reconnect and try again.') from None
