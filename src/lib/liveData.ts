// Real data for the Try it playground, only when the user switches Live on:
// the approximate city from the IP address (ipwho.is, falling back to ipapi.co)
// and its weather (Open-Meteo). No keys, nothing else is sent. The results are
// turned into the same columns the Weather app's provider gives a lock screen.

import type { Value } from './maml';
import type { PhoneLiveState } from './types';

export interface LiveData {
  city: string;
  country: string;
  temp: number;
  apparent: number;
  min: number;
  max: number;
  humidity: number;
  windKmh: number;
  code: number;
  description: string;
  /** Next days: highs, lows and WMO codes. */
  days: { max: number; min: number; code: number }[];
  fetchedAt: number;
}

/** WMO weather code → words. */
export function weatherWords(code: number): string {
  if (code === 0) return 'Clear';
  if (code === 1) return 'Mostly clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Cloudy';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if (code >= 61 && code <= 67) return 'Rain';
  if (code >= 71 && code <= 77) return 'Snow';
  if (code >= 80 && code <= 82) return 'Showers';
  if (code === 85 || code === 86) return 'Snow showers';
  if (code >= 95) return 'Thunderstorm';
  return 'Cloudy';
}

/** A rough condition number for icon pictures (0 clear, 1 cloudy, 2 rain, 3 snow, 4 storm, 5 fog). */
export function weatherType(code: number): number {
  if (code === 0 || code === 1) return 0;
  if (code === 45 || code === 48) return 5;
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 2;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 3;
  if (code >= 95) return 4;
  return 1;
}

/** Wind speed in km/h → Beaufort level, as the Weather app reports it. */
export function windLevel(kmh: number): number {
  const limits = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
  const i = limits.findIndex((l) => kmh < l);
  return i === -1 ? 12 : i;
}

const r = (n: number) => Math.round(n);

/** The columns a ContentProviderBinder on content://weather/… would read. */
export function liveColumns(d: LiveData): Record<string, string[]> {
  const days = d.days.length ? d.days : [{ max: d.max, min: d.min, code: d.code }];
  return {
    city_name: [d.city],
    description: [d.description],
    temperature: [`${r(d.temp)}℃`],
    temperature_range: [`${r(d.min)}℃~${r(d.max)}℃`],
    somatosensory: [`${r(d.apparent)}℃`],
    humidity: [String(r(d.humidity))],
    wind: [String(windLevel(d.windKmh))],
    weather_type: days.map((x, i) => String(weatherType(i === 0 ? d.code : x.code))),
    tmphighs: days.map((x) => String(r(x.max))),
    tmplows: days.map((x) => String(r(x.min))),
    forecast_type: days.map((x) => String(weatherType(x.code))),
    weathernamesfrom: days.map((x) => weatherWords(x.code)),
  };
}

/** The playground's own weather variables (@weather_description and friends). */
export function liveVars(d: LiveData): Record<string, Value> {
  return {
    weather_description: d.description,
    weather_temperature: `${r(d.temp)}℃`,
    weather_temp: r(d.temp),
    weather_city: d.city,
    weather_range: `${r(d.min)}℃~${r(d.max)}℃`,
    weather_type: weatherType(d.code),
  };
}

interface Place {
  city: string;
  country: string;
  lat: number;
  lon: number;
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

export function placeFromIpwho(j: unknown): Place | null {
  const o = j as { success?: boolean; city?: string; country?: string; latitude?: number; longitude?: number };
  if (!o || o.success === false || typeof o.latitude !== 'number' || typeof o.longitude !== 'number') return null;
  return { city: o.city || 'Your city', country: o.country ?? '', lat: o.latitude, lon: o.longitude };
}

export function placeFromIpapi(j: unknown): Place | null {
  const o = j as { error?: boolean; city?: string; country_name?: string; latitude?: number; longitude?: number };
  if (!o || o.error || typeof o.latitude !== 'number' || typeof o.longitude !== 'number') return null;
  return { city: o.city || 'Your city', country: o.country_name ?? '', lat: o.latitude, lon: o.longitude };
}

export function weatherFromOpenMeteo(place: Place, j: unknown, now = Date.now()): LiveData {
  const o = j as {
    current?: { temperature_2m?: number; apparent_temperature?: number; relative_humidity_2m?: number; weather_code?: number; wind_speed_10m?: number };
    daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[]; weather_code?: number[] };
  };
  const c = o?.current;
  if (!c || typeof c.temperature_2m !== 'number') throw new Error('No current weather in the answer');
  const daily = o.daily ?? {};
  const days = (daily.temperature_2m_max ?? []).map((max, i) => ({ max, min: daily.temperature_2m_min?.[i] ?? max, code: daily.weather_code?.[i] ?? 3 }));
  const code = c.weather_code ?? 3;
  return {
    city: place.city,
    country: place.country,
    temp: c.temperature_2m,
    apparent: c.apparent_temperature ?? c.temperature_2m,
    min: days[0]?.min ?? c.temperature_2m,
    max: days[0]?.max ?? c.temperature_2m,
    humidity: c.relative_humidity_2m ?? 0,
    windKmh: c.wind_speed_10m ?? 0,
    code,
    description: weatherWords(code),
    days: days.slice(0, 5),
    fetchedAt: now,
  };
}

const CACHE_KEY = 'mts.try.live.v1';
const CACHE_MS = 30 * 60 * 1000;

/** The last answer, if it is less than half an hour old. */
export function cachedLiveData(): LiveData | null {
  try {
    const d = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as LiveData | null;
    return d && Date.now() - d.fetchedAt < CACHE_MS ? d : null;
  } catch {
    return null;
  }
}

/** Ask for the city and its weather. Throws with a readable message when offline or refused. */
export async function fetchLiveData(signal?: AbortSignal): Promise<LiveData> {
  let place: Place | null = null;
  try {
    place = placeFromIpwho(await getJson('https://ipwho.is/?fields=success,city,country,latitude,longitude', signal));
  } catch {
    place = null;
  }
  if (!place) place = placeFromIpapi(await getJson('https://ipapi.co/json/', signal));
  if (!place) throw new Error('Could not work out a location from this connection');
  const q = new URLSearchParams({
    latitude: place.lat.toFixed(2),
    longitude: place.lon.toFixed(2),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min,weather_code',
    forecast_days: '5',
    timezone: 'auto',
  });
  const data = weatherFromOpenMeteo(place, await getJson(`https://api.open-meteo.com/v1/forecast?${q}`, signal));
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {
    /* storage unavailable */
  }
  return data;
}

// ---- From the connected phone (adb_live_state) -------------------------------

/** The phone's clock now, as a Date whose local fields read like the phone's lock screen. */
export function phoneClock(p: PhoneLiveState, pcNow: number = Date.now()): Date {
  const drift = p.epochMs !== null ? p.epochMs - p.fetchedAtMs : 0;
  const at = new Date(pcNow + drift);
  if (p.tzOffsetMinutes === null) return at;
  const pcZone = -at.getTimezoneOffset();
  return new Date(at.getTime() + (p.tzOffsetMinutes - pcZone) * 60_000);
}

/** Weather columns the phone gave, without empty ones, so sample values fill the gaps. */
export function phoneColumns(p: PhoneLiveState): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(p.weather)) if (v.some((x) => x !== '')) out[k] = v;
  return out;
}

/** True when the phone's Weather app shared something worth drawing. */
export const phoneHasWeather = (p: PhoneLiveState | null) => !!(p && (p.weather.city_name?.[0] || p.weather.temperature?.[0]));

/** Battery, music and weather variables as the phone has them. */
export function phoneVars(p: PhoneLiveState): Record<string, Value> {
  const out: Record<string, Value> = {};
  if (p.batteryLevel !== null) {
    out.battery_level = p.batteryLevel;
    out.battery_state = p.charging ? (p.full || p.batteryLevel >= 100 ? 3 : 1) : 0;
  }
  if (p.musicPlaying !== null) out.music_state = p.musicPlaying ? 1 : 0;
  const w = p.weather;
  const first = (k: string) => w[k]?.[0] || '';
  const withUnit = (t: string) => (/^-?\d+(\.\d+)?$/.test(t) ? `${t}℃` : t);
  if (first('city_name')) out.weather_city = first('city_name');
  if (first('description')) out.weather_description = first('description');
  if (first('temperature')) {
    out.weather_temperature = withUnit(first('temperature'));
    out.weather_temp = Number(first('temperature').replace(/[^\d.-]/g, '')) || 0;
  }
  if (first('temperature_range')) out.weather_range = first('temperature_range');
  if (first('weather_type') && Number.isFinite(Number(first('weather_type')))) out.weather_type = Number(first('weather_type'));
  return out;
}
