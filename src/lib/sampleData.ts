// What the phone's content providers return, for previews: weather columns
// (the Weather app) and Mi Fitness steps, by column name. Live data from the
// Guide's Try it page replaces the weather ones (see liveData.ts).

export const SAMPLE_COLUMNS: Record<string, string[]> = {
  city_name: ['Your city'],
  weather_type: ['0', '0', '1', '1', '2'],
  description: ['Clear'],
  temperature: ['18℃'],
  temperature_range: ['12℃~21℃'],
  tmphighs: ['21', '22', '19', '20', '23'],
  tmplows: ['12', '13', '11', '12', '14'],
  forecast_type: ['0', '1', '1', '2', '0'],
  weathernamesfrom: ['Clear', 'Cloudy', 'Cloudy', 'Rain', 'Clear'],
  aqilevel: ['60'],
  humidity: ['55'],
  wind: ['3'],
  pressure: ['1013'],
  temperature_unit: ['1'],
  somatosensory: ['17℃'],
  // Mi Fitness steps
  steps: ['6532'],
  goal: ['8000'],
};
