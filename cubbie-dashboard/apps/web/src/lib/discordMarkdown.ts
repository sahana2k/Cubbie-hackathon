/** Parses the subset of Discord markdown the feed displays: no HTML is produced, so React escapes all text. */
export type Inline =
  | { kind: 'text' | 'code'; text: string }
  | { kind: 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'mention'; text: string }
  | { kind: 'time'; text: string; title: string };
export type Block =
  | { kind: 'line' | 'quote' | 'subtext' | 'bullet'; children: Inline[] }
  | { kind: 'heading'; level: number; children: Inline[] }
  | { kind: 'codeblock'; text: string }
  | { kind: 'gap' };
export type Names = Record<string, string>;

const INLINE = new RegExp([
  '`([^`]+)`',                                   // 1 inline code
  '\\*\\*([\\s\\S]+?)\\*\\*',                    // 2 bold
  '__([\\s\\S]+?)__',                            // 3 underline
  '\\*(?!\\s)([\\s\\S]+?)\\*',                   // 4 italic
  '(?<![\\w])_(?!\\s)([\\s\\S]+?)_(?![\\w])',    // 5 italic (not inside snake_case)
  '~~([\\s\\S]+?)~~',                            // 6 strikethrough
  '\\|\\|([\\s\\S]+?)\\|\\|',                    // 7 spoiler
  '<t:(-?\\d+)(?::([tTdDfFR]))?>',               // 8, 9 timestamp
  '<(@!?|@&|#)(\\d+)>',                          // 10, 11 mention
  '\\[([^\\]]+)\\]\\(<?(https?://[^\\s)>]+)>?\\)', // 12, 13 masked link
  '<?(https?://[^\\s<>]*[^\\s<>.,:;"\')\\]])>?'  // 14 bare link
].join('|'), 'g');

export function formatTimestamp(seconds: number, style = 'f', now = Date.now()) {
  const at = new Date(seconds * 1000);
  const title = at.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' });
  if (style === 'R') {
    const diff = (at.getTime() - now) / 1000;
    const units: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
    const [unit, size] = units.find(([, s]) => Math.abs(diff) >= s) || units[units.length - 1];
    return { text: new Intl.RelativeTimeFormat([], { numeric: 'auto' }).format(Math.round(diff / size), unit), title };
  }
  const options: Record<string, Intl.DateTimeFormatOptions> = {
    t: { timeStyle: 'short' }, T: { timeStyle: 'medium' }, d: { dateStyle: 'short' }, D: { dateStyle: 'long' },
    f: { dateStyle: 'long', timeStyle: 'short' }, F: { dateStyle: 'full', timeStyle: 'short' }
  };
  return { text: at.toLocaleString([], options[style] || options.f), title };
}

export function parseInline(source: string, names: Names = {}, now = Date.now()): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const text = (value: string) => { if (value) out.push({ kind: 'text', text: value }); };
  for (const m of source.matchAll(INLINE)) {
    text(source.slice(last, m.index));
    last = m.index! + m[0].length;
    const nested = (value: string) => parseInline(value, names, now);
    if (m[1] !== undefined) out.push({ kind: 'code', text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: 'bold', children: nested(m[2]) });
    else if (m[3] !== undefined) out.push({ kind: 'underline', children: nested(m[3]) });
    else if (m[4] !== undefined) out.push({ kind: 'italic', children: nested(m[4]) });
    else if (m[5] !== undefined) out.push({ kind: 'italic', children: nested(m[5]) });
    else if (m[6] !== undefined) out.push({ kind: 'strike', children: nested(m[6]) });
    else if (m[7] !== undefined) out.push({ kind: 'spoiler', children: nested(m[7]) });
    else if (m[8] !== undefined) out.push({ kind: 'time', ...formatTimestamp(Number(m[8]), m[9], now) });
    else if (m[11] !== undefined) {
      const prefix = m[10] === '#' ? '#' : m[10] === '@&' ? '@&' : '@';
      const name = names[prefix + m[11]];
      out.push({ kind: 'mention', text: (prefix === '#' ? '#' : '@') + (name || (prefix === '#' ? 'channel' : prefix === '@&' ? 'role' : 'unknown-user')) });
    } else if (m[13] !== undefined) out.push({ kind: 'link', href: m[13], children: nested(m[12]) });
    else out.push({ kind: 'link', href: m[14], children: [{ kind: 'text', text: m[14] }] });
  }
  text(source.slice(last));
  return out;
}

export function parseBlocks(source: string, names: Names = {}, now = Date.now()): Block[] {
  const blocks: Block[] = [];
  const parts = source.split(/```(?:[\w+-]*\n)?([\s\S]*?)```/);
  parts.forEach((part, i) => {
    if (i % 2) { blocks.push({ kind: 'codeblock', text: part.replace(/\n$/, '') }); return; }
    // The newlines touching a code fence belong to the fence, not to a blank line.
    const body = (i > 0 ? part.replace(/^\n/, '') : part).replace(i < parts.length - 1 ? /\n$/ : /$^/, '');
    for (const line of body.split('\n')) {
      let m: RegExpMatchArray | null;
      if (!line.trim()) { if (blocks.length && blocks[blocks.length - 1].kind !== 'gap') blocks.push({ kind: 'gap' }); }
      else if ((m = line.match(/^(#{1,3}) (.+)/))) blocks.push({ kind: 'heading', level: m[1].length, children: parseInline(m[2], names, now) });
      else if ((m = line.match(/^-# (.+)/))) blocks.push({ kind: 'subtext', children: parseInline(m[1], names, now) });
      else if ((m = line.match(/^>>?>? ?(.*)/))) blocks.push({ kind: 'quote', children: parseInline(m[1], names, now) });
      else if ((m = line.match(/^\s*[-*•] (.+)/))) blocks.push({ kind: 'bullet', children: parseInline(m[1], names, now) });
      else blocks.push({ kind: 'line', children: parseInline(line, names, now) });
    }
  });
  while (blocks.length && blocks[blocks.length - 1].kind === 'gap') blocks.pop();
  return blocks;
}
