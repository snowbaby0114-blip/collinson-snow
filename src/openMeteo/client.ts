const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const MARINE_URL = "https://marine-api.open-meteo.com/v1/marine";

export interface GeocodeResult {
  name: string;
  country: string | null;
  latitude: number;
  longitude: number;
  timezone: string;
}

export interface DailyLandWeather {
  date: string;
  tempMax: number;
  tempMin: number;
  precipitationSum: number;
  snowfallSum: number;
  windSpeedMax: number;
  windGustsMax: number;
  weatherCode: number;
}

export interface DailyMarineWeather {
  date: string;
  waveHeightMax: number | null;
  wavePeriodMax: number | null;
}

export class CityNotFoundError extends Error {
  constructor(query: string) {
    super(`No location found for "${query}"`);
    this.name = "CityNotFoundError";
  }
}

export class UpstreamWeatherError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "UpstreamWeatherError";
  }
}

export interface OpenMeteoClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  retryBaseDelayMs?: number;
}

export interface WeatherDataSource {
  geocodeCity(query: string): Promise<GeocodeResult>;
  fetchLandForecast(latitude: number, longitude: number): Promise<DailyLandWeather[]>;
  fetchMarineForecast(latitude: number, longitude: number): Promise<DailyMarineWeather[] | null>;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertEqualLength(expected: number, fields: Record<string, number>): void {
  const mismatched = Object.entries(fields).filter(([, length]) => length !== expected);
  if (mismatched.length > 0) {
    const detail = mismatched.map(([name, length]) => `${name}=${length}`).join(", ");
    throw new UpstreamWeatherError(
      `Open-Meteo daily forecast arrays have mismatched lengths (expected ${expected}): ${detail}`,
    );
  }
}

export class OpenMeteoClient implements WeatherDataSource {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseDelayMs: number;

  constructor(options: OpenMeteoClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.retries = options.retries ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
  }

  private async getJson<T>(url: string): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const res = await this.fetchImpl(url, { signal: controller.signal });
        if (!res.ok) {
          if (isRetryableStatus(res.status) && attempt < this.retries) {
            lastError = new Error(`Open-Meteo request failed (${res.status}): ${url}`);
            await sleep(this.retryBaseDelayMs * 2 ** attempt);
            continue;
          }
          throw new UpstreamWeatherError(`Open-Meteo request failed (${res.status}): ${url}`);
        }
        return (await res.json()) as T;
      } catch (err) {
        if (err instanceof UpstreamWeatherError) throw err;
        lastError = err;
        if (attempt < this.retries) {
          await sleep(this.retryBaseDelayMs * 2 ** attempt);
          continue;
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new UpstreamWeatherError(
      `Open-Meteo request failed after ${this.retries + 1} attempts: ${url}`,
      lastError,
    );
  }

  async geocodeCity(query: string): Promise<GeocodeResult> {
    const url = `${GEOCODING_URL}?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
    const data = await this.getJson<{
      results?: Array<{
        name: string;
        country?: string;
        latitude: number;
        longitude: number;
        timezone: string;
      }>;
    }>(url);

    const result = data.results?.[0];
    if (!result) {
      throw new CityNotFoundError(query);
    }

    if (
      typeof result.name !== "string" ||
      typeof result.latitude !== "number" ||
      typeof result.longitude !== "number" ||
      typeof result.timezone !== "string"
    ) {
      throw new UpstreamWeatherError(
        `Open-Meteo geocoding response for "${query}" is missing required fields`,
      );
    }

    return {
      name: result.name,
      country: result.country ?? null,
      latitude: result.latitude,
      longitude: result.longitude,
      timezone: result.timezone,
    };
  }

  async fetchLandForecast(latitude: number, longitude: number): Promise<DailyLandWeather[]> {
    const params = [
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "snowfall_sum",
      "windspeed_10m_max",
      "windgusts_10m_max",
      "weathercode",
    ].join(",");
    const url = `${FORECAST_URL}?latitude=${latitude}&longitude=${longitude}&daily=${params}&timezone=auto&forecast_days=7`;

    const data = await this.getJson<{
      daily: {
        time: string[];
        temperature_2m_max: number[];
        temperature_2m_min: number[];
        precipitation_sum: number[];
        snowfall_sum: number[];
        windspeed_10m_max: number[];
        windgusts_10m_max: number[];
        weathercode: number[];
      };
    }>(url);

    assertEqualLength(data.daily.time.length, {
      temperature_2m_max: data.daily.temperature_2m_max.length,
      temperature_2m_min: data.daily.temperature_2m_min.length,
      precipitation_sum: data.daily.precipitation_sum.length,
      snowfall_sum: data.daily.snowfall_sum.length,
      windspeed_10m_max: data.daily.windspeed_10m_max.length,
      windgusts_10m_max: data.daily.windgusts_10m_max.length,
      weathercode: data.daily.weathercode.length,
    });

    return data.daily.time.map((date, i) => ({
      date,
      tempMax: data.daily.temperature_2m_max[i],
      tempMin: data.daily.temperature_2m_min[i],
      precipitationSum: data.daily.precipitation_sum[i],
      snowfallSum: data.daily.snowfall_sum[i],
      windSpeedMax: data.daily.windspeed_10m_max[i],
      windGustsMax: data.daily.windgusts_10m_max[i],
      weatherCode: data.daily.weathercode[i],
    }));
  }

  async fetchMarineForecast(latitude: number, longitude: number): Promise<DailyMarineWeather[] | null> {
    const url = `${MARINE_URL}?latitude=${latitude}&longitude=${longitude}&daily=wave_height_max,wave_period_max&timezone=auto&forecast_days=7`;

    const data = await this.getJson<{
      daily: {
        time: string[];
        wave_height_max: Array<number | null>;
        wave_period_max: Array<number | null>;
      };
    }>(url);

    assertEqualLength(data.daily.time.length, {
      wave_height_max: data.daily.wave_height_max.length,
      wave_period_max: data.daily.wave_period_max.length,
    });

    const rows = data.daily.time.map((date, i) => ({
      date,
      waveHeightMax: data.daily.wave_height_max[i],
      wavePeriodMax: data.daily.wave_period_max[i],
    }));

    const hasAnyData = rows.some((r) => r.waveHeightMax !== null);
    return hasAnyData ? rows : null;
  }
}
