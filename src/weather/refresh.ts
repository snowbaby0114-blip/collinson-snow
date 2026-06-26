import { normalizeCityQuery } from "../db/repository.js";
import type { CityRow, DailyForecastRow, WeatherRepository } from "../db/repository.js";
import { logger } from "../logger.js";
import type { DailyMarineWeather, WeatherDataSource } from "../openMeteo/client.js";

export interface CityForecastBundle {
  city: CityRow;
  days: DailyForecastRow[];
  hasSurfData: boolean;
}

export interface WeatherServiceOptions {
  staleAfterMs?: number;
  forecastDays?: number;
}

export class WeatherService {
  private readonly staleAfterMs: number;
  private readonly forecastDays: number;
  private readonly inFlight = new Map<string, Promise<CityForecastBundle>>();

  constructor(
    private readonly repository: WeatherRepository,
    private readonly openMeteo: WeatherDataSource,
    options: WeatherServiceOptions = {},
  ) {
    this.staleAfterMs = options.staleAfterMs ?? 3 * 60 * 60 * 1000;
    this.forecastDays = options.forecastDays ?? 7;
  }

  async getCityForecast(
    cityQuery: string,
    options: { forceRefresh?: boolean } = {},
  ): Promise<CityForecastBundle> {
    const key = `${normalizeCityQuery(cityQuery)}:${options.forceRefresh ? "force" : "auto"}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = this.resolveCityForecast(cityQuery, options).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private async resolveCityForecast(
    cityQuery: string,
    options: { forceRefresh?: boolean },
  ): Promise<CityForecastBundle> {
    let city = this.repository.findCityByQuery(cityQuery);

    if (!city) {
      const geo = await this.openMeteo.geocodeCity(cityQuery);
      city = this.repository.insertCity(cityQuery, geo);
      logger.info("geocoded new city", { query: cityQuery, resolved: city.name, country: city.country });
    }

    let rows = this.repository.getForecastRows(city.id);
    const stale = this.isStale(city, rows);

    if (options.forceRefresh || stale) {
      logger.info("refreshing forecast", {
        city: city.name,
        reason: options.forceRefresh ? "forced" : "stale",
      });
      await this.fetchAndPersist(city);
      rows = this.repository.getForecastRows(city.id);
    }

    const today = this.todayInTimezone(city.timezone);
    const days = rows.filter((r) => r.date >= today).slice(0, this.forecastDays);
    const hasSurfData = days.some((d) => d.wave_height_max !== null);

    return { city, days, hasSurfData };
  }

  private todayInTimezone(timezone: string): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
  }

  private isStale(city: CityRow, rows: DailyForecastRow[]): boolean {
    const today = this.todayInTimezone(city.timezone);
    const upcoming = rows.filter((r) => r.date >= today);

    if (upcoming.length < this.forecastDays) return true;

    const oldestFetch = Math.min(...upcoming.map((r) => new Date(r.fetched_at).getTime()));
    return Date.now() - oldestFetch > this.staleAfterMs;
  }

  private async fetchAndPersist(city: CityRow): Promise<void> {
    const [landResult, marineResult] = await Promise.allSettled([
      this.openMeteo.fetchLandForecast(city.latitude, city.longitude),
      this.openMeteo.fetchMarineForecast(city.latitude, city.longitude),
    ]);

    if (landResult.status === "rejected") {
      throw landResult.reason;
    }

    let marineDays: DailyMarineWeather[] | null = null;
    if (marineResult.status === "fulfilled") {
      marineDays = marineResult.value;
    } else {
      logger.warn("marine forecast fetch failed; continuing without surf data", {
        city: city.name,
        error:
          marineResult.reason instanceof Error ? marineResult.reason.message : String(marineResult.reason),
      });
    }

    this.repository.upsertForecastDays(city.id, landResult.value, marineDays);
  }
}
