import { config } from '../config';

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;

function emit(level: Level, msg: string, extra?: unknown) {
  if (levels[level] < levels[config.logLevel]) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra !== undefined) out(line, extra instanceof Error ? extra.stack ?? extra.message : extra);
  else out(line);
}

export const log = {
  debug: (m: string, e?: unknown) => emit('debug', m, e),
  info: (m: string, e?: unknown) => emit('info', m, e),
  warn: (m: string, e?: unknown) => emit('warn', m, e),
  error: (m: string, e?: unknown) => emit('error', m, e),
};
