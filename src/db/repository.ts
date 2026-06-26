import type Database from "better-sqlite3";
import type { DailyLandWeather, DailyMarineWeather, GeocodeResult } from "../openMeteo/client.js";

export interface CityRow {
  id: number;
  query_name: string;
  name: string;
  country: string | null;
  latitude: number;
  longitude: number;
  timezone: string;
  created_at: string;
}

export interface DailyForecastRow {
  id: number;
  city_id: number;
  date: string;
  temp_max: number;
  temp_min: number;
  precipitation_sum: number;
  snowfall_sum: number;
  wind_speed_max: number;
  wind_gusts_max: number;
  weather_code: number;
  wave_height_max: number | null;
  wave_period_max: number | null;
  fetched_at: string;
}

export function normalizeCityQuery(query: string): string {
  return query.trim().toLowerCase();
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Error && "code" in err && (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

export class WeatherRepository {
  private readonly insertCityStmt: Database.Statement;
  private readonly upsertForecastStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertCityStmt = db.prepare(
      `INSERT INTO cities (query_name, name, country, latitude, longitude, timezone, created_at)
       VALUES (@query_name, @name, @country, @latitude, @longitude, @timezone, @created_at)`,
    );

    this.upsertForecastStmt = db.prepare(`
      INSERT INTO daily_forecasts (
        city_id, date, temp_max, temp_min, precipitation_sum, snowfall_sum,
        wind_speed_max, wind_gusts_max, weather_code, wave_height_max, wave_period_max, fetched_at
      ) VALUES (
        @city_id, @date, @temp_max, @temp_min, @precipitation_sum, @snowfall_sum,
        @wind_speed_max, @wind_gusts_max, @weather_code, @wave_height_max, @wave_period_max, @fetched_at
      )
      ON CONFLICT(city_id, date) DO UPDATE SET
        temp_max = excluded.temp_max,
        temp_min = excluded.temp_min,
        precipitation_sum = excluded.precipitation_sum,
        snowfall_sum = excluded.snowfall_sum,
        wind_speed_max = excluded.wind_speed_max,
        wind_gusts_max = excluded.wind_gusts_max,
        weather_code = excluded.weather_code,
        wave_height_max = excluded.wave_height_max,
        wave_period_max = excluded.wave_period_max,
        fetched_at = excluded.fetched_at
    `);
  }

  findCityByQuery(query: string): CityRow | undefined {
    return this.db.prepare("SELECT * FROM cities WHERE query_name = ?").get(normalizeCityQuery(query)) as
      | CityRow
      | undefined;
  }

  findCityById(id: number): CityRow | undefined {
    return this.db.prepare("SELECT * FROM cities WHERE id = ?").get(id) as CityRow | undefined;
  }

  listCities(): CityRow[] {
    return this.db.prepare("SELECT * FROM cities ORDER BY name ASC").all() as CityRow[];
  }

  insertCity(query: string, geo: GeocodeResult): CityRow {
    const queryName = normalizeCityQuery(query);
    try {
      const result = this.insertCityStmt.run({
        query_name: queryName,
        name: geo.name,
        country: geo.country,
        latitude: geo.latitude,
        longitude: geo.longitude,
        timezone: geo.timezone,
        created_at: new Date().toISOString(),
      });
      return this.findCityById(result.lastInsertRowid as number)!;
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        const existing = this.findCityByQuery(queryName);
        if (existing) return existing;
      }
      throw err;
    }
  }

  getForecastRows(cityId: number): DailyForecastRow[] {
    return this.db
      .prepare("SELECT * FROM daily_forecasts WHERE city_id = ? ORDER BY date ASC")
      .all(cityId) as DailyForecastRow[];
  }

  upsertForecastDays(
    cityId: number,
    landDays: DailyLandWeather[],
    marineDays: DailyMarineWeather[] | null,
  ): void {
    const fetchedAt = new Date().toISOString();
    const marineByDate = new Map((marineDays ?? []).map((d) => [d.date, d]));

    const tx = this.db.transaction((days: DailyLandWeather[]) => {
      for (const day of days) {
        const marine = marineByDate.get(day.date);
        this.upsertForecastStmt.run({
          city_id: cityId,
          date: day.date,
          temp_max: day.tempMax,
          temp_min: day.tempMin,
          precipitation_sum: day.precipitationSum,
          snowfall_sum: day.snowfallSum,
          wind_speed_max: day.windSpeedMax,
          wind_gusts_max: day.windGustsMax,
          weather_code: day.weatherCode,
          wave_height_max: marine?.waveHeightMax ?? null,
          wave_period_max: marine?.wavePeriodMax ?? null,
          fetched_at: fetchedAt,
        });
      }
    });

    tx(landDays);
  }
}
