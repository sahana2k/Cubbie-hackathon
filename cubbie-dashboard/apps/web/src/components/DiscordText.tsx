import { useState, type ReactNode } from 'react';
import { parseBlocks, type Inline, type Names } from '../lib/discordMarkdown';

function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return <span className={`dm-spoiler${shown ? ' on' : ''}`} role="button" tabIndex={0} title={shown ? undefined : 'Show spoiler'}
    onClick={() => setShown(true)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setShown(true); }}>{children}</span>;
}

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.kind) {
      case 'text': return n.text;
      case 'code': return <code key={i} className="dm-code">{n.text}</code>;
      case 'bold': return <strong key={i}>{renderInline(n.children)}</strong>;
      case 'italic': return <em key={i}>{renderInline(n.children)}</em>;
      case 'underline': return <u key={i}>{renderInline(n.children)}</u>;
      case 'strike': return <s key={i}>{renderInline(n.children)}</s>;
      case 'spoiler': return <Spoiler key={i}>{renderInline(n.children)}</Spoiler>;
      case 'link': return <a key={i} href={n.href} target="_blank" rel="noreferrer">{renderInline(n.children)}</a>;
      case 'mention': return <span key={i} className="dm-mention">{n.text}</span>;
      case 'time': return <time key={i} className="dm-time" title={n.title}>{n.text}</time>;
    }
  });
}

/** Renders Discord message markdown as React elements (never as HTML). */
export function DiscordText({ text, names, className = 'dm' }: { text: string; names: Names; className?: string }) {
  return <div className={className}>{parseBlocks(text, names).map((b, i) => {
    switch (b.kind) {
      case 'gap': return <div key={i} className="dm-gap" />;
      case 'codeblock': return <pre key={i} className="dm-pre"><code>{b.text}</code></pre>;
      case 'heading': return <p key={i} className={`dm-h dm-h${b.level}`}>{renderInline(b.children)}</p>;
      case 'subtext': return <p key={i} className="dm-sub">{renderInline(b.children)}</p>;
      case 'quote': return <blockquote key={i} className="dm-quote">{renderInline(b.children)}</blockquote>;
      case 'bullet': return <p key={i} className="dm-li">{renderInline(b.children)}</p>;
      case 'line': return <p key={i} className="dm-line">{renderInline(b.children)}</p>;
    }
  })}</div>;
}
