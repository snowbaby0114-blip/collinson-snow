import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "./client.js";
import { normalizeCityQuery, WeatherRepository } from "./repository.js";

const SAMPLE_GEO = {
  name: "Lisbon",
  country: "Portugal",
  latitude: 38.7223,
  longitude: -9.1393,
  timezone: "Europe/Lisbon",
};

function sampleLandDay(date: string) {
  return {
    date,
    tempMax: 22,
    tempMin: 15,
    precipitationSum: 0,
    snowfallSum: 0,
    windSpeedMax: 10,
    windGustsMax: 20,
    weatherCode: 0,
  };
}

describe("WeatherRepository", () => {
  let db: Database.Database;
  let repo: WeatherRepository;

  beforeEach(() => {
    db = createDatabase(":memory:");
    repo = new WeatherRepository(db);
  });

  it("normalizes the query name so casing/whitespace share a cache entry", () => {
    expect(normalizeCityQuery("  Lisbon ")).toBe("lisbon");
    const city = repo.insertCity("  Lisbon ", SAMPLE_GEO);
    expect(repo.findCityByQuery("LISBON")).toEqual(city);
  });

  it("returns undefined for a city that hasn't been looked up", () => {
    expect(repo.findCityByQuery("Nowhere")).toBeUndefined();
  });

  it("survives a concurrent insert race without throwing", () => {
    const first = repo.insertCity("Lisbon", SAMPLE_GEO);
    const second = repo.insertCity("Lisbon", SAMPLE_GEO);
    expect(second.id).toBe(first.id);
    expect(repo.listCities()).toHaveLength(1);
  });

  it("upserts forecast days idempotently on (city_id, date)", () => {
    const city = repo.insertCity("Lisbon", SAMPLE_GEO);
    repo.upsertForecastDays(city.id, [sampleLandDay("2026-01-01")], null);
    repo.upsertForecastDays(city.id, [{ ...sampleLandDay("2026-01-01"), tempMax: 30 }], null);

    const rows = repo.getForecastRows(city.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].temp_max).toBe(30);
  });

  it("returns forecast rows ordered by date", () => {
    const city = repo.insertCity("Lisbon", SAMPLE_GEO);
    repo.upsertForecastDays(
      city.id,
      [sampleLandDay("2026-01-03"), sampleLandDay("2026-01-01"), sampleLandDay("2026-01-02")],
      null,
    );

    expect(repo.getForecastRows(city.id).map((r) => r.date)).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
    ]);
  });

  it("stores null wave data for non-coastal locations", () => {
    const city = repo.insertCity("Lisbon", SAMPLE_GEO);
    repo.upsertForecastDays(city.id, [sampleLandDay("2026-01-01")], null);

    const [row] = repo.getForecastRows(city.id);
    expect(row.wave_height_max).toBeNull();
    expect(row.wave_period_max).toBeNull();
  });

  it("stores marine data when present", () => {
    const city = repo.insertCity("Lisbon", SAMPLE_GEO);
    repo.upsertForecastDays(
      city.id,
      [sampleLandDay("2026-01-01")],
      [{ date: "2026-01-01", waveHeightMax: 1.4, wavePeriodMax: 9 }],
    );

    const [row] = repo.getForecastRows(city.id);
    expect(row.wave_height_max).toBe(1.4);
    expect(row.wave_period_max).toBe(9);
  });
});
