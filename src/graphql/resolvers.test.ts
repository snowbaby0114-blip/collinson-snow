import { createSchema, createYoga } from "graphql-yoga";
import { describe, expect, it, vi } from "vitest";
import type { CityRow, DailyForecastRow, WeatherRepository } from "../db/repository.js";
import { CityNotFoundError } from "../openMeteo/client.js";
import type { CityForecastBundle, WeatherService } from "../weather/refresh.js";
import { resolvers, type GraphQLContext } from "./resolvers.js";
import { typeDefs } from "./schema.js";

const schema = createSchema({ typeDefs, resolvers });

const CITY: CityRow = {
  id: 1,
  query_name: "lisbon",
  name: "Lisbon",
  country: "Portugal",
  latitude: 38.7223,
  longitude: -9.1393,
  timezone: "Europe/Lisbon",
  created_at: "2026-01-01T00:00:00.000Z",
};

function day(overrides: Partial<DailyForecastRow> = {}): DailyForecastRow {
  return {
    id: 1,
    city_id: 1,
    date: "2026-01-01",
    temp_max: 20,
    temp_min: 10,
    precipitation_sum: 0,
    snowfall_sum: 0,
    wind_speed_max: 10,
    wind_gusts_max: 15,
    weather_code: 0,
    wave_height_max: null,
    wave_period_max: null,
    fetched_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function contextWith(options: {
  getCityForecast?: (...args: unknown[]) => unknown;
  listCities?: (...args: unknown[]) => unknown;
}): GraphQLContext {
  const weatherService = { getCityForecast: options.getCityForecast ?? vi.fn() };
  const repository = { listCities: options.listCities ?? vi.fn() };
  return {
    weatherService: weatherService as unknown as WeatherService,
    repository: repository as unknown as WeatherRepository,
  };
}

interface GraphQLJsonResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

// Drives the schema through graphql-yoga's own fetch() rather than calling the `graphql`
// package directly — Vitest otherwise loads a second module instance of `graphql`, and
// graphql-js's internal instanceof checks reject a GraphQLSchema built from a different one.
async function execute(
  query: string,
  contextValue: GraphQLContext,
  variables?: Record<string, unknown>,
): Promise<GraphQLJsonResponse> {
  const yoga = createYoga<object, GraphQLContext>({ schema, context: () => contextValue });
  const response = await yoga.fetch("http://yoga/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return (await response.json()) as GraphQLJsonResponse;
}

const FORECAST_QUERY = `
  query Forecast($city: String!) {
    forecast(city: $city) {
      city { name country latitude longitude timezone }
      notes
      rankings { activity weeklyScore rating dailyScores { date score rating } }
    }
  }
`;

const REFRESH_MUTATION = `
  mutation Refresh($city: String!) {
    refreshForecast(city: $city) {
      city { name }
      notes
    }
  }
`;

const CITIES_QUERY = `
  query {
    cities { name country latitude longitude timezone }
  }
`;

describe("Query.forecast", () => {
  it("returns the expected shape on success", async () => {
    const bundle: CityForecastBundle = { city: CITY, days: [day()], hasSurfData: true };
    const getCityForecast = vi.fn(async () => bundle);
    const result = await execute(FORECAST_QUERY, contextWith({ getCityForecast }), { city: "Lisbon" });

    expect(result.errors).toBeUndefined();
    expect(result.data?.forecast).toMatchObject({
      city: {
        name: "Lisbon",
        country: "Portugal",
        latitude: 38.7223,
        longitude: -9.1393,
        timezone: "Europe/Lisbon",
      },
      notes: [],
    });
    expect(getCityForecast).toHaveBeenCalledWith("Lisbon");
  });

  it("sorts rankings descending by weeklyScore", async () => {
    const bundle: CityForecastBundle = { city: CITY, days: [day()], hasSurfData: false };
    const result = await execute(
      FORECAST_QUERY,
      contextWith({ getCityForecast: vi.fn(async () => bundle) }),
      { city: "Lisbon" },
    );

    const forecast = result.data?.forecast as { rankings: Array<{ weeklyScore: number }> };
    const scores = forecast.rankings.map((r) => r.weeklyScore);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("includes a surf note when hasSurfData is false", async () => {
    const bundle: CityForecastBundle = { city: CITY, days: [day()], hasSurfData: false };
    const result = await execute(
      FORECAST_QUERY,
      contextWith({ getCityForecast: vi.fn(async () => bundle) }),
      { city: "Denver" },
    );
    const forecast = result.data?.forecast as { notes: string[] };
    expect(forecast.notes).toHaveLength(1);
  });

  it("omits the surf note when hasSurfData is true", async () => {
    const bundle: CityForecastBundle = { city: CITY, days: [day()], hasSurfData: true };
    const result = await execute(
      FORECAST_QUERY,
      contextWith({ getCityForecast: vi.fn(async () => bundle) }),
      { city: "Lisbon" },
    );
    const forecast = result.data?.forecast as { notes: string[] };
    expect(forecast.notes).toHaveLength(0);
  });

  it("rejects an empty city with BAD_USER_INPUT", async () => {
    const result = await execute(FORECAST_QUERY, contextWith({}), { city: "" });
    expect(result.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
  });

  it("rejects a whitespace-only city with BAD_USER_INPUT", async () => {
    const result = await execute(FORECAST_QUERY, contextWith({}), { city: "   " });
    expect(result.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
  });

  it("maps CityNotFoundError to NOT_FOUND", async () => {
    const getCityForecast = vi.fn(async () => {
      throw new CityNotFoundError("Nowhereville");
    });
    const result = await execute(FORECAST_QUERY, contextWith({ getCityForecast }), {
      city: "Nowhereville",
    });
    expect(result.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });

  it("maps a generic Error to UPSTREAM_ERROR, preserving the message", async () => {
    const getCityForecast = vi.fn(async () => {
      throw new Error("network exploded");
    });
    const result = await execute(FORECAST_QUERY, contextWith({ getCityForecast }), { city: "Lisbon" });
    expect(result.errors?.[0]?.extensions?.code).toBe("UPSTREAM_ERROR");
    expect(result.errors?.[0]?.message).toContain("network exploded");
  });

  it("maps a non-Error throw to UPSTREAM_ERROR without the literal 'undefined'", async () => {
    const getCityForecast = vi.fn(async () => {
      throw "raw string failure";
    });
    const result = await execute(FORECAST_QUERY, contextWith({ getCityForecast }), { city: "Lisbon" });
    expect(result.errors?.[0]?.extensions?.code).toBe("UPSTREAM_ERROR");
    expect(result.errors?.[0]?.message).toContain("raw string failure");
    expect(result.errors?.[0]?.message).not.toContain("undefined");
  });
});

describe("Mutation.refreshForecast", () => {
  it("forces a refresh by passing forceRefresh: true", async () => {
    const bundle: CityForecastBundle = { city: CITY, days: [day()], hasSurfData: true };
    const getCityForecast = vi.fn(async () => bundle);
    await execute(REFRESH_MUTATION, contextWith({ getCityForecast }), { city: "Lisbon" });
    expect(getCityForecast).toHaveBeenCalledWith("Lisbon", { forceRefresh: true });
  });

  it("rejects an empty city with BAD_USER_INPUT", async () => {
    const result = await execute(REFRESH_MUTATION, contextWith({}), { city: "" });
    expect(result.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
  });

  it("maps CityNotFoundError to NOT_FOUND", async () => {
    const getCityForecast = vi.fn(async () => {
      throw new CityNotFoundError("Nowhereville");
    });
    const result = await execute(REFRESH_MUTATION, contextWith({ getCityForecast }), {
      city: "Nowhereville",
    });
    expect(result.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });

  it("maps a generic Error to UPSTREAM_ERROR", async () => {
    const getCityForecast = vi.fn(async () => {
      throw new Error("boom");
    });
    const result = await execute(REFRESH_MUTATION, contextWith({ getCityForecast }), { city: "Lisbon" });
    expect(result.errors?.[0]?.extensions?.code).toBe("UPSTREAM_ERROR");
  });
});

describe("Query.cities", () => {
  it("maps repository rows to the City shape", async () => {
    const listCities = vi.fn(() => [CITY]);
    const result = await execute(CITIES_QUERY, contextWith({ listCities }));
    expect(result.errors).toBeUndefined();
    expect(result.data?.cities).toEqual([
      {
        name: "Lisbon",
        country: "Portugal",
        latitude: 38.7223,
        longitude: -9.1393,
        timezone: "Europe/Lisbon",
      },
    ]);
  });

  it("returns an empty array when there are no cities", async () => {
    const result = await execute(CITIES_QUERY, contextWith({ listCities: vi.fn(() => []) }));
    expect(result.data?.cities).toEqual([]);
  });

  it("catches a repository failure and surfaces UPSTREAM_ERROR", async () => {
    const listCities = vi.fn(() => {
      throw new Error("db is locked");
    });
    const result = await execute(CITIES_QUERY, contextWith({ listCities }));
    expect(result.errors?.[0]?.extensions?.code).toBe("UPSTREAM_ERROR");
  });
});
