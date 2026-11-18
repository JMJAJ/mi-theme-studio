// Keeps docs/maml/ honest: every example's result is what the editor works out,
// every example appears in the guide with that result, and the pictures and the
// starter manifest in docs/maml/ are redrawn from the same data.
// The project has no @types/node; these are the few Node calls the test needs.
// @ts-ignore
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
// @ts-ignore
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATE_EXAMPLES, EXPR_EXAMPLES, FORMAT_EXAMPLES, NUMBER_EXAMPLES, ALL_DOC_EXAMPLES, runExample, STARTER_MANIFEST } from './mamlDocExamples';
import { allDocImages } from './mamlDocImages';

declare const process: { cwd(): string };

const DOCS: string = join(process.cwd(), 'docs', 'maml');
const guide = () =>
  readdirSync(DOCS)
    .filter((f: string) => f.endsWith('.md'))
    .map((f: string) => readFileSync(join(DOCS, f), 'utf8'))
    .join('\n')
    .replace(/&#124;/g, '|');

/** Write only when the content changed, so a clean run leaves the tree untouched. */
function put(path: string, text: string) {
  let old: string | null = null;
  try {
    old = readFileSync(path, 'utf8');
  } catch {
    old = null;
  }
  if (old !== text) writeFileSync(path, text);
}

describe('docs/maml examples', () => {
  it.each(ALL_DOC_EXAMPLES.map((e) => [e.code, e] as const))('%s', (_code, e) => {
    expect(runExample(e)).toBe(String(e.expected));
  });

  it('every example is printed in the guide with its result', () => {
    const text = guide();
    const missing = ALL_DOC_EXAMPLES.filter((e) => !text.includes(e.code) || !text.includes(String(e.expected))).map((e) => e.code);
    expect(missing).toEqual([]);
  });

  it('pictures and the starter manifest are current', () => {
    mkdirSync(join(DOCS, 'img'), { recursive: true });
    mkdirSync(join(DOCS, 'examples', 'starter'), { recursive: true });
    put(join(DOCS, 'examples', 'starter', 'manifest.xml'), STARTER_MANIFEST);
    const images = allDocImages([
      { file: 'date-formats.svg', title: 'Date and time patterns', subtitle: 'DateTime format, drawn at Tuesday 17 March 2026, 21:05:07', examples: DATE_EXAMPLES },
      { file: 'text-formulas.svg', title: 'Text formulas (textExp)', subtitle: 'weather_description = Clear, weather_temperature = 18℃, battery 82%, 21:05', examples: EXPR_EXAMPLES },
      { file: 'format-paras.svg', title: 'format + paras', subtitle: 'Each %d / %s slot takes the next formula from paras', examples: FORMAT_EXAMPLES },
      { file: 'number-formulas.svg', title: 'Formulas in number attributes', subtitle: 'Screen 1080 × 2400, battery 82%, 21:05:07', examples: NUMBER_EXAMPLES },
    ]);
    for (const [file, text] of Object.entries(images)) {
      expect(text.startsWith('<svg')).toBe(true);
      put(join(DOCS, 'img', file), text);
    }
  });
});
