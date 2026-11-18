// The examples shown in docs/maml/. Each one is worked out with the editor's own
// evaluator (mamlDocExamples.test.ts checks the expected text and redraws the
// pictures in docs/maml/img/), so the guide shows exactly what the preview shows.

import { evalNumber, evalString, formatDate, formatWithParas, systemVars, type Value, type Vars } from './maml';

/** The moment every example is drawn at: Tuesday 17 March 2026, 21:05:07. */
export const DOC_NOW = new Date(2026, 2, 17, 21, 5, 7);

/** What the examples read: the phone's own variables plus a weather binder and a few of the layout's own. */
export function docVars(over: Record<string, Value> = {}): Vars {
  return sampleVars(DOC_NOW, over);
}

/** The same sample data at any moment (the guide's Try it page moves the clock and battery). */
export function sampleVars(now: Date, over: Record<string, Value> = {}): Vars {
  const vars = systemVars(1080, 2400, now);
  const extra: Record<string, Value> = {
    // <ContentProviderBinder uri="content://weather/actualWeatherData/1"> with these variable names
    weather_city: 'Your city',
    weather_description: 'Clear',
    weather_temperature: '18℃',
    weather_temp: 18,
    weather_range: '12℃~21℃',
    weather_type: 0,
    // a step counter binder
    steps: 6532,
    steps_goal: 8000,
    // a <Var name="name" type="string" expression="'Alex'"/>
    name: 'Alex',
    ...over,
  };
  for (const [k, v] of Object.entries(extra)) vars.set(k, v);
  return vars;
}

export type DocExample =
  /** <DateTime format="…"/> */
  | { kind: 'date'; code: string; expected: string; note?: string }
  /** <Text textExp="…"/> */
  | { kind: 'expr'; code: string; expected: string; note?: string; vars?: Record<string, Value> }
  /** <Text format="…" paras="…"/> */
  | { kind: 'format'; code: string; paras: string; expected: string; note?: string; vars?: Record<string, Value> }
  /** any number attribute: x, w, alpha, rotation, sweep, visibility… */
  | { kind: 'number'; attr: string; code: string; expected: number; note?: string; vars?: Record<string, Value> };

export function runExample(e: DocExample): string {
  const vars = docVars('vars' in e ? e.vars : undefined);
  switch (e.kind) {
    case 'date':
      return formatDate(e.code, DOC_NOW);
    case 'expr':
      return evalString(e.code, vars);
    case 'format':
      return formatWithParas(e.code, e.paras, vars);
    case 'number':
      return String(+evalNumber(e.code, vars).toFixed(2));
  }
}

export const DATE_EXAMPLES: DocExample[] = [
  { kind: 'date', code: 'HH:mm', expected: '21:05', note: '24-hour clock' },
  { kind: 'date', code: 'hh:mm', expected: '09:05', note: '12-hour, leading zero' },
  { kind: 'date', code: 'h:mm a', expected: '9:05 PM', note: '12-hour with AM/PM' },
  { kind: 'date', code: 'HH:mm:ss', expected: '21:05:07', note: 'with seconds' },
  { kind: 'date', code: 'd/M', expected: '17/3', note: 'day/month, no zeros' },
  { kind: 'date', code: 'd/M EE', expected: '17/3 Tue', note: 'day/month + short weekday' },
  { kind: 'date', code: 'dd/MM', expected: '17/03', note: 'zero-padded' },
  { kind: 'date', code: 'M/d', expected: '3/17', note: 'US order' },
  { kind: 'date', code: 'EEEE', expected: 'Tuesday', note: 'full weekday' },
  { kind: 'date', code: 'EEE, d MMM', expected: 'Tue, 17 Mar', note: 'short date' },
  { kind: 'date', code: 'd MMMM yyyy', expected: '17 March 2026', note: 'long date' },
  { kind: 'date', code: 'yyyy-MM-dd', expected: '2026-03-17', note: 'ISO date' },
  { kind: 'date', code: 'MM/dd/yy', expected: '03/17/26', note: 'two-digit year' },
  { kind: 'date', code: "'Today is' EEEE", expected: 'Today is Tuesday', note: "literal words in '…'" },
];

export const EXPR_EXAMPLES: DocExample[] = [
  { kind: 'expr', code: "@weather_description+' '+@weather_temperature", expected: 'Clear 18℃', note: 'join two strings with a space' },
  { kind: 'expr', code: "#weather_temp+'°'", expected: '18°', note: 'number + text becomes text' },
  { kind: 'expr', code: "@weather_city+' · '+#weather_temp+'°'", expected: 'Your city · 18°', note: 'mix strings and numbers' },
  { kind: 'expr', code: "#battery_level+'%'", expected: '82%', note: 'battery percent' },
  { kind: 'expr', code: "'Hi, '+@name", expected: 'Hi, Alex', note: 'your own string variable' },
  { kind: 'expr', code: "ifelse(#hour24{12,'Good morning',#hour24{18,'Good afternoon','Good evening')", expected: 'Good evening', note: 'pick text by the hour' },
  { kind: 'expr', code: "ifelse(eq(#battery_state,1),'Charging',#battery_level+'%')", expected: '82%', note: 'charging or percent' },
  { kind: 'expr', code: "ifelse(#sms_unread_count}0,#sms_unread_count+' new','No messages')", expected: 'No messages', note: 'unread counter' },
  { kind: 'expr', code: "formatDate('EEEE',#time)", expected: 'Tuesday', note: 'a date inside a formula' },
  { kind: 'expr', code: "formatDate('d/M EE',#time)+'  '+@weather_temperature", expected: '17/3 Tue  18℃', note: 'date and weather on one line' },
  { kind: 'expr', code: 'strToUpperCase(@weather_city)', expected: 'YOUR CITY', note: 'upper case' },
  { kind: 'expr', code: 'substr(@weather_description,0,3)', expected: 'Cle', note: 'first three letters' },
  { kind: 'expr', code: "ifelse(#minute{10,'0'+#minute,#minute)", expected: '05', note: 'leading zero by hand' },
  { kind: 'expr', code: "#hour12+':'+ifelse(#minute{10,'0','')+#minute+ifelse(#ampm,' PM',' AM')", expected: '9:05 PM', note: 'a 12-hour clock from parts' },
  { kind: 'expr', code: "int(#steps*100/#steps_goal)+'% of goal'", expected: '81% of goal', note: 'arithmetic, then text' },
];

export const FORMAT_EXAMPLES: DocExample[] = [
  { kind: 'format', code: '%d%%', paras: '#battery_level', expected: '82%', note: '%% prints a percent sign' },
  { kind: 'format', code: '%02d:%02d', paras: '#hour24,#minute', expected: '21:05', note: '%02d pads to two digits' },
  { kind: 'format', code: '%d°', paras: '#weather_temp', expected: '18°', note: 'number with a degree sign' },
  { kind: 'format', code: '%s %s', paras: '@weather_description,@weather_temperature', expected: 'Clear 18℃', note: 'same as the textExp join' },
  { kind: 'format', code: '%d / %d steps', paras: '#steps,#steps_goal', expected: '6532 / 8000 steps', note: 'several slots, in order' },
  { kind: 'format', code: '%s', paras: "ifelse(#ampm,'PM','AM')", expected: 'PM', note: 'a slot can be any formula' },
];

export const NUMBER_EXAMPLES: DocExample[] = [
  { kind: 'number', attr: 'x', code: '#screen_width/2', expected: 540, note: 'centre of the screen (use align="center")' },
  { kind: 'number', attr: 'y', code: '#screen_height-200', expected: 2200, note: '200 px from the bottom' },
  { kind: 'number', attr: 'w', code: '520*#battery_level/100', expected: 426.4, note: 'a bar that fills with the battery' },
  { kind: 'number', attr: 'sweep', code: '360*#battery_level/100', expected: 295.2, note: 'a ring that fills with the battery' },
  { kind: 'number', attr: 'rotation', code: '#second*6', expected: 42, note: 'second hand: 6° per second' },
  { kind: 'number', attr: 'rotation', code: '(#hour12%12)*30+#minute*0.5', expected: 272.5, note: 'hour hand' },
  { kind: 'number', attr: 'alpha', code: 'ifelse(#hour24}=20,150,255)', expected: 150, note: 'dimmer after 8 pm' },
  { kind: 'number', attr: 'visibility', code: 'eq(#battery_state,1)', expected: 0, note: '1 only while charging' },
  { kind: 'number', attr: 'visibility', code: '#battery_level{20', expected: 0, note: 'low battery warning' },
  { kind: 'number', attr: 'visibility', code: '#hour24}=6**#hour24{18', expected: 0, note: 'daytime only (** is AND)' },
  { kind: 'number', attr: 'visibility', code: '#hour24{6||#hour24}=18', expected: 1, note: 'night only (|| is OR)' },
];

export const ALL_DOC_EXAMPLES = [...DATE_EXAMPLES, ...EXPR_EXAMPLES, ...FORMAT_EXAMPLES, ...NUMBER_EXAMPLES];

/**
 * The starter lock screen drawn in the guide (docs/maml/examples/starter/manifest.xml).
 * Kept flat (no groups) so the picture renderer can stay small.
 */
export const STARTER_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<Lockscreen version="1" frameRate="30" screenWidth="1080">
    <VariableBinders>
        <ContentProviderBinder name="weather" uri="content://weather/actualWeatherData/1" columns="city_name,description,temperature" countName="has_weather">
            <Variable name="weather_city" type="string" column="city_name"/>
            <Variable name="weather_description" type="string" column="description"/>
            <Variable name="weather_temperature" type="string" column="temperature"/>
        </ContentProviderBinder>
    </VariableBinders>

    <Var name="greeting" type="string" expression="ifelse(#hour24{12,'Good morning',#hour24{18,'Good afternoon','Good evening')"/>

    <Wallpaper/>
    <Rectangle name="dim" x="0" y="0" w="#screen_width" h="#screen_height" fillColor="#40000000"/>

    <DateTime name="clock" x="#screen_width/2" y="420" align="center" size="230" color="#ffffffff" format="HH:mm"/>
    <DateTime name="date" x="#screen_width/2" y="700" align="center" size="54" color="#ccffffff" format="d/M EE"/>
    <Text name="weather" x="#screen_width/2" y="790" align="center" size="46" color="#ccffffff" textExp="@weather_description+' '+@weather_temperature" visibility="#has_weather"/>
    <Text name="hello" x="#screen_width/2" y="1000" align="center" size="60" bold="true" color="#ffffd27a" textExp="@greeting"/>

    <Rectangle name="bar_track" x="120" y="2050" w="840" h="24" cornerRadius="12" fillColor="#40ffffff"/>
    <Rectangle name="bar_fill" x="120" y="2050" w="840*#battery_level/100" h="24" cornerRadius="12" fillColor="#ffa8e6ff"/>
    <Text name="battery" x="#screen_width/2" y="2110" align="center" size="40" color="#ffffffff" format="%d%%" paras="#battery_level"/>
    <Text name="charging" x="#screen_width/2" y="2170" align="center" size="36" color="#ffa8e6ff" text="Charging" visibility="eq(#battery_state,1)"/>

    <Unlocker name="unlocker">
        <StartPoint x="0" y="1800" w="1080" h="600"/>
        <EndPoint x="0" y="0" w="1080" h="1200"/>
    </Unlocker>
</Lockscreen>
`;
