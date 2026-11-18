// Code shown in the Guide: formulas and XML coloured like the editor, and a copy button.
import { useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';

const TOKEN = /('[^']*'?)|([#@][\w.]+(?:\[\d+\])?)|([A-Za-z_]\w*)(?=\()|(\d+(?:\.\d+)?)/g;

/** A formula with variables, quoted text, functions and numbers coloured. */
export function Formula({ code }: { code: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of code.matchAll(TOKEN)) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const cls = m[1] ? 'tok-str' : m[2] ? (m[2][0] === '#' ? 'tok-num' : 'tok-text') : m[3] ? 'tok-fn' : 'tok-lit';
    out.push(
      <span key={m.index} className={cls}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return <>{out}</>;
}

/** XML with tags, attribute names and (formula-coloured) values. */
export function XmlCode({ code }: { code: string }) {
  const out: ReactNode[] = [];
  const re = /(<!--[\s\S]*?-->)|(<\/?[\w.:-]+)|([\w.:-]+)(?==")|("[^"]*")|(\/?>)/g;
  let last = 0;
  for (const m of code.matchAll(re)) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const k = m.index;
    if (m[1]) out.push(<span key={k} className="tok-comment">{m[1]}</span>);
    else if (m[2]) out.push(<span key={k} className="tok-tag">{m[2]}</span>);
    else if (m[3]) out.push(<span key={k} className="tok-attr">{m[3]}</span>);
    else if (m[4])
      out.push(
        <span key={k} className="tok-value">
          "<Formula code={m[4].slice(1, -1)} />"
        </span>,
      );
    else out.push(<span key={k} className="tok-tag">{m[5]}</span>);
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return <>{out}</>;
}

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="tb-icon gd-copy"
      title={done ? 'Copied' : 'Copy'}
      aria-label="Copy code"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      {done ? <Check /> : <Copy />}
    </button>
  );
}
