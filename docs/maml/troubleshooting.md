# Troubleshooting

[← Guide](README.md)

## It shows `0`

- **A text variable read with `#`.** `#weather_description` turns the text into a number, which is 0. Use `@weather_description`.
- **The variable doesn't exist.** Names are case-sensitive and must match a `<Variable name="…">`, `<Var name="…">` or a [phone variable](variables.md#from-the-phone) exactly. Unknown variables read as 0.
- **An unknown function.** The preview treats functions it doesn't know as 0 (see [Functions](expressions.md#functions)); the phone may still draw it.
- **Text joined without quotes.** `@weather_description+ +@weather_temperature` is broken; the space has to be quoted: `+' '+`.

## It's blank

- **The data hasn't arrived.** Weather and steps need their binder, and the app on the phone. Before the data comes the variables are empty; hide the piece until then with `visibility="#has_weather"` (the binder's `countName`).
- **Try it says “Sample weather.”** In Guide → Try it, turn **Live** on. It uses the connected phone's Weather app data when available; otherwise it needs an internet connection for its approximate IP-based city and Open-Meteo lookup. Use the refresh button to retry. The lock-screen canvas uses sample weather; Live is a Try it preview option.
- **`visibility` is 0, or `alpha` is 0.** Select the piece in the **Pieces** list and look at **Visibility**.
- **It's covered.** Pieces later in the file are drawn on top. Pick it from the **Pieces** list, or move it after the covering piece in the code.
- **It's off screen.** Check **X**/**Y**; a formula's current value is shown next to the label.
- **The colour is invisible.** `#00ffffff` has opacity `00`. See [colours](layout.md#colours).

## The XML editor says the file is broken

- **`<` or `>` inside an attribute.** Write `{` for less than and `}` for greater than: `#hour24{12`, not `#hour24<12`.
- **`&&`.** Write `**` for and: `#a**#b`.
- **Double quotes inside the attribute.** The attribute is in double quotes, so text inside a formula uses single quotes: `textExp="'Hi, '+@name"`.
- **An attribute written twice.** The phone keeps the last one; strict XML refuses the file. The editor reads such files anyway, but fix them in the code.

## The number has too many decimals

`#steps*100/#steps_goal` is 81.65. Wrap it: `int(…)` → 81, `round(…)` → 82, or print it with `format="%d"`.

## The month or weekday is off by one

`#month` counts from **0** (March = 2) and `#day_of_week` from **1 = Sunday**. Use `#month+1`, or a `DateTime` with `MMMM` / `EEEE`.

## Text is joined when I wanted a sum (or the other way round)

`+` joins as soon as one side is text, reading left to right: `'Total '+#a+#b` gives `Total 12` for 1 and 2. Bracket the sum: `'Total '+(#a+#b)` → `Total 3`. Variables declared `type="string"` are text even when they hold digits; use `#` to read them as numbers.

## The preview and the phone disagree

The preview is a still approximation of the phone's renderer. Known differences:

| On the phone | In the preview |
| --- | --- |
| Real time, battery, notifications, music | Frozen sample: battery 82%, nothing unread, no music; the clock is your PC's |
| Real weather and steps in the still lock-screen preview | Sample values (*Your city*, *Clear*, *18℃*, 6532 steps). Guide → Try it can use Live phone data or an online weather lookup. |
| Weekday/month names in the phone's language | English |
| Chinese lunar date letters (`N`, `e`) | Empty |
| Colour formulas (`@var`, `argb(…)`) | Drawn white |
| `%.1f` rounds | The value as is |
| Touch, swipes, unlocking, `marqueeSpeed` | Not simulated (use the **Page** buttons for multi-page lock screens) |
| `rand()` | Always 0.5 |
| Video, some special elements | Listed in a yellow *… not drawn here* badge |

To see the real thing, connect the phone and use **Try on phone** (see the main [README](../../README.md#phone)).

## Where do I find the variable names a theme uses?

Select a piece and look at **All settings**, or **Show in code**. Binder variables are at the top of `manifest.xml` inside `<VariableBinders>`; `<Var>`s are usually near the top too.
