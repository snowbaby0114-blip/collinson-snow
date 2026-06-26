import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../db/client.js";
import { WeatherRepository } from "../db/repository.js";
import type {
  DailyLandWeather,
  DailyMarineWeather,
  GeocodeResult,
  WeatherDataSource,
} from "../openMeteo/client.js";
import { CityNotFoundError, UpstreamWeatherError } from "../openMeteo/client.js";
import { WeatherService } from "./refresh.js";

const GEO: GeocodeResult = {
  name: "Lisbon",
  country: "Portugal",
  latitude: 38.7223,
  longitude: -9.1393,
  timezone: "UTC",
};

function landDays(tempMax = 22): DailyLandWeather[] {
  return Array.from({ length: 7 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    tempMax,
    tempMin: 15,
    precipitationSum: 0,
    snowfallSum: 0,
    windSpeedMax: 10,
    windGustsMax: 20,
    weatherCode: 0,
  }));
}

class FakeOpenMeteo implements WeatherDataSource {
  geocodeCity = vi.fn(async (_query: string): Promise<GeocodeResult> => GEO);
  fetchLandForecast = vi.fn(async (): Promise<DailyLandWeather[]> => landDays());
  fetchMarineForecast = vi.fn(async (): Promise<DailyMarineWeather[] | null> => null);
}

describe("WeatherService", () => {
  let db: Database.Database;
  let repository: WeatherRepository;
  let openMeteo: FakeOpenMeteo;
  let service: WeatherService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    db = createDatabase(":memory:");
    repository = new WeatherRepository(db);
    openMeteo = new FakeOpenMeteo();
    service = new WeatherService(repository, openMeteo);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("geocodes and fetches forecast for a brand-new city", async () => {
    const bundle = await service.getCityForecast("Lisbon");

    expect(openMeteo.geocodeCity).toHaveBeenCalledTimes(1);
    expect(openMeteo.fetchLandForecast).toHaveBeenCalledTimes(1);
    expect(bundle.city.name).toBe("Lisbon");
    expect(bundle.days).toHaveLength(7);
  });

  it("serves a second request from the cache without calling Open-Meteo again", async () => {
    await service.getCityForecast("Lisbon");
    await service.getCityForecast("Lisbon");

    expect(openMeteo.geocodeCity).toHaveBeenCalledTimes(1);
    expect(openMeteo.fetchLandForecast).toHaveBeenCalledTimes(1);
  });

  it("refetches once cached data is older than the staleness window", async () => {
    service = new WeatherService(repository, openMeteo, { staleAfterMs: 60_000 });
    await service.getCityForecast("Lisbon");

    vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));
    await service.getCityForecast("Lisbon");

    expect(openMeteo.fetchLandForecast).toHaveBeenCalledTimes(2);
  });

  it("forceRefresh bypasses a still-fresh cache", async () => {
    await service.getCityForecast("Lisbon");
    await service.getCityForecast("Lisbon", { forceRefresh: true });

    expect(openMeteo.fetchLandForecast).toHaveBeenCalledTimes(2);
  });

  it("does not geocode again on a second lookup of the same city", async () => {
    await service.getCityForecast("Lisbon");
    await service.getCityForecast("lisbon");

    expect(openMeteo.geocodeCity).toHaveBeenCalledTimes(1);
  });

  it("propagates CityNotFoundError for an unresolvable city", async () => {
    openMeteo.geocodeCity = vi.fn(async () => {
      throw new CityNotFoundError("Nowhereville");
    });
    service = new WeatherService(repository, openMeteo);

    await expect(service.getCityForecast("Nowhereville")).rejects.toBeInstanceOf(CityNotFoundError);
  });

  it("marks surfing data unavailable when the marine API returns null", async () => {
    const bundle = await service.getCityForecast("Lisbon");
    expect(bundle.hasSurfData).toBe(false);
  });

  it("marks surfing data available when the marine API returns wave heights", async () => {
    openMeteo.fetchMarineForecast = vi.fn(async () =>
      landDays().map((d) => ({ date: d.date, waveHeightMax: 1.2, wavePeriodMax: 8 })),
    );
    service = new WeatherService(repository, openMeteo);

    const bundle = await service.getCityForecast("Lisbon");
    expect(bundle.hasSurfData).toBe(true);
  });

  it("degrades gracefully and still returns land forecast when only the marine API fails", async () => {
    openMeteo.fetchMarineForecast = vi.fn(async () => {
      throw new UpstreamWeatherError("marine API is down");
    });
    service = new WeatherService(repository, openMeteo);

    const bundle = await service.getCityForecast("Lisbon");
    expect(bundle.days).toHaveLength(7);
    expect(bundle.hasSurfData).toBe(false);
  });

  it("fails the whole request when the land forecast API fails", async () => {
    openMeteo.fetchLandForecast = vi.fn(async () => {
      throw new UpstreamWeatherError("forecast API is down");
    });
    service = new WeatherService(repository, openMeteo);

    await expect(service.getCityForecast("Lisbon")).rejects.toBeInstanceOf(UpstreamWeatherError);
  });

  it("does not duplicate a city row when two requests race on the same new city", async () => {
    let releaseGeocode: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGeocode = resolve;
    });

    openMeteo.geocodeCity = vi.fn(async () => {
      await gate;
      return GEO;
    });
    service = new WeatherService(repository, openMeteo);

    const first = service.getCityForecast("Lisbon");
    const second = service.getCityForecast("Lisbon");
    releaseGeocode();

    await Promise.all([first, second]);

    expect(repository.listCities()).toHaveLength(1);
  });

  it("coalesces concurrent requests for the same uncached city into a single upstream fetch", async () => {
    let releaseGeocode: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGeocode = resolve;
    });

    openMeteo.geocodeCity = vi.fn(async () => {
      await gate;
      return GEO;
    });
    service = new WeatherService(repository, openMeteo);

    const requests = Promise.all([
      service.getCityForecast("Lisbon"),
      service.getCityForecast("Lisbon"),
      service.getCityForecast("lisbon "),
      service.getCityForecast("Lisbon"),
      service.getCityForecast("Lisbon"),
    ]);
    releaseGeocode();
    await requests;

    expect(openMeteo.geocodeCity).toHaveBeenCalledTimes(1);
    expect(openMeteo.fetchLandForecast).toHaveBeenCalledTimes(1);
  });

  it("does not coalesce requests for genuinely different cities", async () => {
    const other = { ...GEO, name: "Porto" };
    openMeteo.geocodeCity = vi.fn(async (query: string) => (query === "Porto" ? other : GEO));
    service = new WeatherService(repository, openMeteo);

    await Promise.all([service.getCityForecast("Lisbon"), service.getCityForecast("Porto")]);

    expect(openMeteo.geocodeCity).toHaveBeenCalledTimes(2);
    expect(repository.listCities()).toHaveLength(2);
  });

  it("allows a later request to refetch after an earlier coalesced request finishes", async () => {
    await service.getCityForecast("Lisbon");
    await service.getCityForecast("Lisbon", { forceRefresh: true });

    expect(openMeteo.fetchLandForecast).toHaveBeenCalledTimes(2);
  });
});
