import { describe, expect, it } from 'vitest';
import { evalNumber, evalString, formatDate, systemVars } from './maml';

const now = new Date(2026, 10, 17, 14, 5, 9); // Tue 17 Nov 2026, 14:05:09
const vars = systemVars(1080, 2400, now);
vars.set('aqi', 120);
vars.set('typeID', 30);
vars.set('city', 'Oslo');

describe('MAML expressions', () => {
  it('does arithmetic with variables and precedence', () => {
    expect(evalNumber('#screen_width/2 + 10*2', vars)).toBe(560);
    expect(evalNumber('-(#screen_height - 400) % 7', vars)).toBe(-(2000 % 7));
  });
  it('builds image names the way manifests do', () => {
    expect(evalString("'hour/hour_'+ int((#hour12)) +'.png'", vars)).toBe('hour/hour_2.png');
    expect(evalString("'week/week_'+ int((#day_of_week-1)) +'.png'", vars)).toBe('week/week_2.png');
  });
  it('reads { } as < > and ** as and', () => {
    expect(evalNumber('#aqi}=100**#aqi{150', vars)).toBe(1);
    expect(evalNumber('#typeID}25||#typeID{0', vars)).toBe(1);
    expect(evalString("ifelse(#aqi}=0**#aqi{50,'Good', #aqi}=100**#aqi{150,'Slightly Polluted', 'N/A')", vars)).toBe('Slightly Polluted');
  });
  it('handles strings, unknown names and bad input without throwing', () => {
    expect(evalString("@city + ', ' + #minute", vars)).toBe('Oslo, 5');
    expect(evalNumber('#never_set + 3', vars)).toBe(3);
    expect(evalNumber('mystery(1,2) + (', vars)).toBe(0);
    expect(evalNumber('10/0', vars)).toBe(0);
  });
  it('formats dates with Java-style patterns', () => {
    expect(formatDate('HH:mm', now)).toBe('14:05');
    expect(formatDate("EEEE, MMM d 'at' hh:mm aa", now)).toBe('Tuesday, Nov 17 at 02:05 PM');
  });
});
