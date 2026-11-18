import { describe, expect, it } from 'vitest';
import { systemVars } from './maml';
import { formulaProblems, tokenAt } from './mamlHelp';

const vars = systemVars(1080, 2400, new Date(2026, 2, 17, 21, 5, 7));
vars.set('city', 'Lisbon');

describe('formula help', () => {
  it('finds what is being typed', () => {
    expect(tokenAt('#batt', 5)).toEqual({ kind: 'var', sigil: '#', prefix: 'batt', start: 0 });
    expect(tokenAt("@a+' '+@", 8)).toEqual({ kind: 'var', sigil: '@', prefix: '', start: 7 });
    expect(tokenAt('ife', 3)).toEqual({ kind: 'fn', sigil: '', prefix: 'ife', start: 0 });
    expect(tokenAt("'#inside", 8)).toBeNull();
    expect(tokenAt('#a+i', 4)).toBeNull();
  });

  it('points out common mistakes', () => {
    expect(formulaProblems('#hour24<12', vars)[0]).toMatch(/\{ for less than/);
    expect(formulaProblems('#a&&#b', vars).some((p) => p.includes('**'))).toBe(true);
    expect(formulaProblems('"x"', vars)[0]).toMatch(/single quotes/);
    expect(formulaProblems('ifelse(#ampm,1', vars)).toContain('A bracket is not closed.');
    expect(formulaProblems('#nope+1', vars)[0]).toMatch(/isn’t a variable/);
    expect(formulaProblems('#city', vars)[0]).toMatch(/read it with @city/);
    expect(formulaProblems("ifelse(#hour24{12,'a<b','c')", vars)).toEqual([]);
  });
});
