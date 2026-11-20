import { useState } from 'react';
import { ArrowUp, FileCode2, Sparkles, X } from 'lucide-react';
import { providerPreset } from '../../lib/aiProviders';
import { askAssistant, useAssistant } from '../../state/assistant';
import { setState } from '../../state/store';

export interface CodeReference {
  path: string;
  startLine: number;
  endLine: number;
  code: string;
  language: string;
  readOnly: boolean;
}

function promptWithReference(reference: CodeReference, request: string) {
  const lines = reference.startLine === reference.endLine ? `line ${reference.startLine}` : `lines ${reference.startLine}–${reference.endLine}`;
  const sourceType = reference.readOnly ? 'read-only reference file' : 'working file';
  const longestFence = Math.max(0, ...Array.from(reference.code.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longestFence + 1));
  return [
    `Use this code from the ${sourceType} ${JSON.stringify(reference.path)} (${lines}) as context for my request:`,
    '',
    `${fence}${reference.language}`,
    reference.code,
    fence,
    '',
    request.trim(),
  ].join('\n');
}

export function CodePrompt({ reference, onClose }: { reference: CodeReference; onClose: () => void }) {
  const [request, setRequest] = useState('');
  const running = useAssistant((s) => s.running);
  const settings = useAssistant((s) => s.settings);
  const active = settings?.active ?? '';
  const preset = providerPreset(active);
  const model = settings?.providers[active]?.model;
  const lines = reference.startLine === reference.endLine ? `Line ${reference.startLine}` : `Lines ${reference.startLine}–${reference.endLine}`;
  const preview = reference.code.length > 2400 ? `${reference.code.slice(0, 2400)}\n…` : reference.code;

  const submit = () => {
    const content = request.trim();
    if (!content || running) return;
    if (askAssistant(promptWithReference(reference, content))) onClose();
  };

  return (
    <div className="code-ai-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        className="code-ai-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Ask AI about this code"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="code-ai-head">
          <Sparkles aria-hidden="true" />
          <strong>Ask AI about this code</strong>
          <span className="grow" />
          <button className="tb-icon" type="button" aria-label="Close" title="Close" onClick={onClose}><X /></button>
        </header>
        <div className="code-ai-reference">
          <div className="code-ai-reference-head">
            <FileCode2 aria-hidden="true" />
            <span className="code-ai-path" title={reference.path}>{reference.path}</span>
            <span className="code-ai-lines">{lines}</span>
          </div>
          <pre><code>{preview || '(blank line)'}</code></pre>
          {reference.code.length > preview.length && <div className="code-ai-truncated">Preview shortened; the full selection will be included.</div>}
        </div>
        <form
          className="code-ai-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <textarea
            autoFocus
            rows={2}
            value={request}
            placeholder="What would you like me to do with this code?"
            aria-label="What would you like the AI to do with this code?"
            onChange={(event) => setRequest(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="code-ai-foot">
            <span className="code-ai-assistant"><Sparkles aria-hidden="true" /> Mi Theme Studio Assistant</span>
            <button className="code-ai-model" type="button" title="Change AI provider or model" onClick={() => setState({ dialog: { type: 'settings', section: 'ai' } })}>
              {model || 'Set up AI'}{preset && ` · ${preset.label.replace(/ \(.*\)$/, '')}`}
            </button>
            <span className="code-ai-hint">Enter to send · Shift+Enter for a new line</span>
            <button className="btn btn-primary btn-icon code-ai-send" type="submit" aria-label="Send to AI" title={running ? 'The assistant is responding' : 'Send to AI'} disabled={!request.trim() || running}>
              <ArrowUp />
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
