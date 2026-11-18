# Variables

[← Guide](README.md)

A variable is a named value that formulas read: `#battery_level`, `@weather_city`. Some come from the phone, some from data sources you declare (weather, steps), and some you make yourself.

## From the phone

These exist in every lock screen; nothing to declare.

### Time and date

| Variable | Value | At 21:05:07, Tue 17 Mar 2026 |
| --- | --- | --- |
| `#hour24` | hour, 0–23 | 21 |
| `#hour12` | hour, 1–12 | 9 |
| `#minute` | 0–59 | 5 |
| `#second` | 0–59 | 7 |
| `#ampm` | 0 = AM, 1 = PM | 1 |
| `#year` | | 2026 |
| `#month` | **0–11** (January = 0) | 2 |
| `#date` | day of month, 1–31 | 17 |
| `#day_of_week` | **1 = Sunday** … 7 = Saturday | 3 |
| `#time` | now, in milliseconds since 1970 (for `formatDate` and timing) | |
| `#time_format` | the phone's setting: 1 = 24-hour, 0 = 12-hour | |
| `@next_alarm_time` | next alarm as text, empty when none (the preview: empty) | |

Note the two traps: `#month` starts at 0 (use `#month+1` for the number people expect) and `#day_of_week` starts at Sunday = 1. For names, `DateTime` with `MMMM` / `EEEE` is easier.

### Battery

| Variable | Value |
| --- | --- |
| `#battery_level` | 0–100 (the preview: 82) |
| `#battery_state` | 0 = normal, 1 = charging, 2 = low, 3 = full (the preview: 0, or 1 with the **Charging** button) |

### Screen

| Variable | Value |
| --- | --- |
| `#screen_width`, `#screen_height` | layout size in px (1080 wide; height follows the phone, e.g. 2400) |
| `#raw_screen_width`, `#raw_screen_height` | the real panel size |
| `#frame_rate` | current drawing rate |

### Notifications and music

| Variable | Value |
| --- | --- |
| `#sms_unread_count` | unread messages (the preview: 0) |
| `#call_missed_count` | missed calls (the preview: 0) |
| `#music_state` | 1 while music plays (the preview: 0) |

### Pieces and touch

Named pieces expose values as `#name.field`, for example `#clock_img.bmp_width` (picture width), `#unlocker.move_x` / `#unlocker.move_y` (how far the unlock swipe has moved), and `#touch_x`, `#touch_y` (last touch). The preview shows the resting state: nothing touched, nothing moved.

## Weather

Weather comes from the Weather app through a **content provider binder**. You declare which columns you want and the names to keep them under:

```xml
<VariableBinders>
    <ContentProviderBinder name="weather" uri="content://weather/actualWeatherData/1"
        columns="city_name,description,temperature,temperature_range,weather_type"
        countName="has_weather">
        <Variable name="weather_city" type="string" column="city_name"/>
        <Variable name="weather_description" type="string" column="description"/>
        <Variable name="weather_temperature" type="string" column="temperature"/>
        <Variable name="weather_temp" type="int" column="temperature"/>
        <Variable name="weather_range" type="string" column="temperature_range"/>
        <Variable name="weather_type" type="int" column="weather_type"/>
    </ContentProviderBinder>
</VariableBinders>
```

- `<VariableBinders>` sits directly inside `<Lockscreen>`.
- **`name="…"` on each `<Variable>` is the name you use in formulas.** `@weather_description` exists because a `<Variable name="weather_description">` says so. Any name works; the Inventory's weather widget uses `mts_weather_desc`, `mts_weather_temp` and so on.
- `type="string"` keeps the text as the app gives it (`18℃`); `type="int"` keeps only the number (`18`).
- `countName="has_weather"` is 1 when there is weather data and 0 before it arrives or without the Weather app. Use it to hide the line until then: `visibility="#has_weather"`.

Then:

| Formula | Shows |
| --- | --- |
| `@weather_description+' '+@weather_temperature` | Clear 18℃ |
| `#weather_temp+'°'` | 18° |
| `@weather_city+' · '+#weather_temp+'°'` | Your city · 18° |
| `strToUpperCase(@weather_city)` | YOUR CITY |

Columns the editor knows and fills with sample values in the preview:

| Column | Sample | Meaning |
| --- | --- | --- |
| `city_name` | Your city | |
| `description` | Clear | condition in words, in the phone's language |
| `temperature` | 18℃ | current temperature with unit |
| `temperature_range` | 12℃~21℃ | today's low~high |
| `weather_type` | 0 | condition as a number, for picking an icon: `srcExp="'weather/'+#weather_type+'.png'"` |
| `somatosensory` | 17℃ | feels like |
| `humidity` | 55 | % |
| `wind` | 3 | wind level |
| `pressure` | 1013 | |
| `aqilevel` | 60 | air quality index |
| `temperature_unit` | 1 | which unit the user picked |
| `tmphighs`, `tmplows` | 21, 22, 19… | daily forecast highs / lows, as a list (`type="int[]"`): `#forecast_high[1]` |
| `forecast_type` | 0, 1, 1… | daily forecast conditions as numbers |
| `weathernamesfrom` | Clear, Cloudy… | daily forecast conditions in words |

## Steps

With Mi Fitness / Mi Health installed:

```xml
<ContentProviderBinder name="steps" uri="content://com.mi.health.provider.main/activity/steps/brief"
    columns="steps,goal" countName="has_steps">
    <Variable name="steps" type="int" column="steps"/>
    <Variable name="steps_goal" type="int" column="goal"/>
</ContentProviderBinder>
```

| Formula | Shows (6532 of 8000) |
| --- | --- |
| `format="%d / %d steps" paras="#steps,#steps_goal"` | 6532 / 8000 steps |
| `int(#steps*100/#steps_goal)+'% of goal'` | 81% of goal |

The preview fills `steps` and `goal` with 6532 and 8000.

## Your own variables

A `<Var>` keeps the result of a formula under a name, so a long formula is written once and reused, and the code stays readable.

```xml
<Var name="greeting" type="string"
     expression="ifelse(#hour24{12,'Good morning',#hour24{18,'Good afternoon','Good evening')"/>
<Var name="night" expression="#hour24{6||#hour24}=18"/>

<Text textExp="@greeting" .../>
<Image src="moon.png" visibility="#night" .../>
<Image src="sun.png" visibility="!#night" .../>
```

- `type="string"` for text, leave it out for numbers.
- Read text ones with `@`, numbers with `#`.
- Put them near the top of the layout, before the pieces that use them.

### Lists: VarArray

To pick a value from a fixed list by a number, for example your own weekday names:

```xml
<VarArray type="string">
    <Vars>
        <Var name="day_name" index="#day_of_week-1"/>
    </Vars>
    <Items>
        <Item value="Sun"/><Item value="Mon"/><Item value="Tue"/><Item value="Wed"/>
        <Item value="Thu"/><Item value="Fri"/><Item value="Sat"/>
    </Items>
</VarArray>
```

`@day_name` is now `Tue` (index 2). Items can also be formulas: `<Item expression="…"/>`.

### Changing a variable on a tap or when the screen wakes

`<VariableCommand>` sets a variable when something happens. On screen wake:

```xml
<ExternalCommands>
    <Trigger action="resume">
        <VariableCommand name="intro_start" expression="#time"/>
    </Trigger>
</ExternalCommands>
```

On a tap, inside a `<Button>`:

```xml
<Var name="page" expression="0"/>
<Button x="0" y="1200" w="1080" h="400">
    <Triggers>
        <Trigger action="up">
            <VariableCommand name="page" expression="1-#page"/>
        </Trigger>
    </Triggers>
</Button>
<Group visibility="eq(#page,0)"> … </Group>
<Group visibility="eq(#page,1)"> … </Group>
```

This is how multi-page lock screens work. The editor finds the variable a `<Button>` changes and that switches groups with `visibility="eq(#page,N)"` (or `#page==N`), and shows one **Page** button per value. A page only counts when its groups hold a real screenful (about 8 pieces or more), so small toggles don't become pages.

The preview runs `init` and `resume` commands as if the screen woke a while ago, and fills weather and steps binders; taps aren't simulated (use the Page buttons).

## Theme settings (config.xml)

A `config.xml` next to `manifest.xml` declares settings people can change in Theme Manager (switches, numbers, choices, text). Each has an `id` that becomes a variable:

```xml
<Config>
    <Group text="Clock">
        <CheckBox id="show_seconds" text="Show seconds" default="0"/>
        <StringInput id="my_name" text="Your name" default="Alex"/>
    </Group>
</Config>
```

```xml
<DateTime formatExp="ifelse(#show_seconds,'HH:mm:ss','HH:mm')" .../>
<Text textExp="'Hi, '+@my_name" .../>
```

`'Hi, '+@name` shows **Hi, Alex**. The preview uses each setting's `default`.

Next: [Position, size and style →](layout.md)
