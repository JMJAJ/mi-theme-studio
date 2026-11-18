import { describe, expect, it } from 'vitest';
import { liveColumns, liveVars, placeFromIpapi, placeFromIpwho, weatherFromOpenMeteo, weatherWords, windLevel } from './liveData';

describe('live data', () => {
  it('reads the location services', () => {
    expect(placeFromIpwho({ success: true, city: 'Lisbon', country: 'Portugal', latitude: 38.7, longitude: -9.1 })).toEqual({ city: 'Lisbon', country: 'Portugal', lat: 38.7, lon: -9.1 });
    expect(placeFromIpwho({ success: false })).toBeNull();
    expect(placeFromIpapi({ city: 'Porto', country_name: 'Portugal', latitude: 41.1, longitude: -8.6 })).toMatchObject({ city: 'Porto' });
  });

  it('turns Open-Meteo into Weather app columns', () => {
    const d = weatherFromOpenMeteo(
      { city: 'Lisbon', country: 'Portugal', lat: 38.7, lon: -9.1 },
      {
        current: { temperature_2m: 17.6, apparent_temperature: 16.2, relative_humidity_2m: 71, weather_code: 61, wind_speed_10m: 14 },
        daily: { temperature_2m_max: [19.4, 21], temperature_2m_min: [12.2, 13], weather_code: [61, 2] },
      },
      0,
    );
    expect(d.description).toBe('Rain');
    const c = liveColumns(d);
    expect(c.city_name).toEqual(['Lisbon']);
    expect(c.temperature).toEqual(['18℃']);
    expect(c.temperature_range).toEqual(['12℃~19℃']);
    expect(c.tmphighs).toEqual(['19', '21']);
    expect(c.weathernamesfrom).toEqual(['Rain', 'Partly cloudy']);
    expect(c.wind).toEqual(['3']);
    expect(liveVars(d)).toMatchObject({ weather_description: 'Rain', weather_temperature: '18℃', weather_temp: 18, weather_city: 'Lisbon' });
  });

  it('names weather codes and wind levels', () => {
    expect(weatherWords(0)).toBe('Clear');
    expect(weatherWords(95)).toBe('Thunderstorm');
    expect(windLevel(0)).toBe(0);
    expect(windLevel(30)).toBe(5);
  });
});
