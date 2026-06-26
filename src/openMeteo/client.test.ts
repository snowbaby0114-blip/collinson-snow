import { describe, expect, it, vi } from "vitest";
import { CityNotFoundError, OpenMeteoClient, UpstreamWeatherError } from "./client.js";

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

function clientWith(fetchImpl: typeof fetch): OpenMeteoClient {
  return new OpenMeteoClient({ fetchImpl, retries: 0 });
}

describe("OpenMeteoClient.geocodeCity", () => {
  it("maps a valid result to GeocodeResult", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        results: [
          {
            name: "Lisbon",
            country: "Portugal",
            latitude: 38.7223,
            longitude: -9.1393,
            timezone: "Europe/Lisbon",
          },
        ],
      }),
    );
    const result = await clientWith(fetchImpl as unknown as typeof fetch).geocodeCity("Lisbon");
    expect(result).toEqual({
      name: "Lisbon",
      country: "Portugal",
      latitude: 38.7223,
      longitude: -9.1393,
      timezone: "Europe/Lisbon",
    });
  });

  it("defaults country to null when absent", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ results: [{ name: "Atlantis", latitude: 0, longitude: 0, timezone: "UTC" }] }),
    );
    const result = await clientWith(fetchImpl as unknown as typeof fetch).geocodeCity("Atlantis");
    expect(result.country).toBeNull();
  });

  it("accepts latitude/longitude of 0 (equator/prime meridian) rather than rejecting as falsy", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ results: [{ name: "Origin", latitude: 0, longitude: 0, timezone: "UTC" }] }),
    );
    const result = await clientWith(fetchImpl as unknown as typeof fetch).geocodeCity("Origin");
    expect(result.latitude).toBe(0);
    expect(result.longitude).toBe(0);
  });

  it("throws CityNotFoundError when results is an empty array", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }));
    await expect(clientWith(fetchImpl as unknown as typeof fetch).geocodeCity("Nowhere")).rejects.toThrow(
      CityNotFoundError,
    );
  });

  it("throws CityNotFoundError when results key is absent entirely", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await expect(clientWith(fetchImpl as unknown as typeof fetch).geocodeCity("Nowhere")).rejects.toThrow(
      CityNotFoundError,
    );
  });

  it("throws UpstreamWeatherError when the result is missing required fields", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [{}] }));
    await expect(clientWith(fetchImpl as unknown as typeof fetch).geocodeCity("Malformed")).rejects.toThrow(
      UpstreamWeatherError,
    );
  });
});

describe("OpenMeteoClient.fetchLandForecast", () => {
  it("maps all daily fields by index into DailyLandWeather[]", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        daily: {
          time: ["2026-01-01", "2026-01-02"],
          temperature_2m_max: [10, 12],
          temperature_2m_min: [2, 3],
          precipitation_sum: [0, 1],
          snowfall_sum: [5, 0],
          windspeed_10m_max: [20, 25],
          windgusts_10m_max: [30, 35],
          weathercode: [0, 61],
        },
      }),
    );
    const days = await clientWith(fetchImpl as unknown as typeof fetch).fetchLandForecast(0, 0);
    expect(days).toEqual([
      {
        date: "2026-01-01",
        tempMax: 10,
        tempMin: 2,
        precipitationSum: 0,
        snowfallSum: 5,
        windSpeedMax: 20,
        windGustsMax: 30,
        weatherCode: 0,
      },
      {
        date: "2026-01-02",
        tempMax: 12,
        tempMin: 3,
        precipitationSum: 1,
        snowfallSum: 0,
        windSpeedMax: 25,
        windGustsMax: 35,
        weatherCode: 61,
      },
    ]);
  });

  it("throws UpstreamWeatherError when a sibling array is shorter than time", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        daily: {
          time: ["2026-01-01", "2026-01-02"],
          temperature_2m_max: [10],
          temperature_2m_min: [2, 3],
          precipitation_sum: [0, 1],
          snowfall_sum: [5, 0],
          windspeed_10m_max: [20, 25],
          windgusts_10m_max: [30, 35],
          weathercode: [0, 61],
        },
      }),
    );
    await expect(clientWith(fetchImpl as unknown as typeof fetch).fetchLandForecast(0, 0)).rejects.toThrow(
      UpstreamWeatherError,
    );
  });
});

describe("OpenMeteoClient.fetchMarineForecast", () => {
  it("maps wave data into DailyMarineWeather[] when present", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        daily: {
          time: ["2026-01-01", "2026-01-02"],
          wave_height_max: [1.2, 1.5],
          wave_period_max: [8, 9],
        },
      }),
    );
    const rows = await clientWith(fetchImpl as unknown as typeof fetch).fetchMarineForecast(0, 0);
    expect(rows).toEqual([
      { date: "2026-01-01", waveHeightMax: 1.2, wavePeriodMax: 8 },
      { date: "2026-01-02", waveHeightMax: 1.5, wavePeriodMax: 9 },
    ]);
  });

  it("returns null when every wave height is null (landlocked)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        daily: {
          time: ["2026-01-01", "2026-01-02"],
          wave_height_max: [null, null],
          wave_period_max: [null, null],
        },
      }),
    );
    const rows = await clientWith(fetchImpl as unknown as typeof fetch).fetchMarineForecast(0, 0);
    expect(rows).toBeNull();
  });

  it("throws UpstreamWeatherError when wave_period_max length mismatches time", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        daily: {
          time: ["2026-01-01", "2026-01-02"],
          wave_height_max: [1.2, 1.5],
          wave_period_max: [8],
        },
      }),
    );
    await expect(clientWith(fetchImpl as unknown as typeof fetch).fetchMarineForecast(0, 0)).rejects.toThrow(
      UpstreamWeatherError,
    );
  });
});
