import { createGraphQLError } from "graphql-yoga";
import type { WeatherRepository } from "../db/repository.js";
import { CityNotFoundError } from "../openMeteo/client.js";
import {
  dayInputFromRow,
  ratingForScore,
  scoreIndoorSightseeing,
  scoreOutdoorSightseeing,
  scoreSkiing,
  scoreSurfing,
} from "../scoring/index.js";
import { type CityForecastBundle, type WeatherService } from "../weather/refresh.js";

export interface GraphQLContext {
  weatherService: WeatherService;
  repository: WeatherRepository;
}

const ACTIVITY_SCORERS = {
  SKIING: scoreSkiing,
  SURFING: scoreSurfing,
  OUTDOOR_SIGHTSEEING: scoreOutdoorSightseeing,
  INDOOR_SIGHTSEEING: scoreIndoorSightseeing,
} as const;

type ActivityKey = keyof typeof ACTIVITY_SCORERS;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildCityForecast(bundle: CityForecastBundle) {
  const { city, days, hasSurfData } = bundle;
  const dayInputs = days.map((row) => ({ row, input: dayInputFromRow(row) }));

  const rankings = (Object.keys(ACTIVITY_SCORERS) as ActivityKey[]).map((activity) => {
    const scorer = ACTIVITY_SCORERS[activity];
    const dailyScores = dayInputs.map(({ row, input }) => {
      const score = scorer(input);
      return { date: row.date, score, rating: ratingForScore(score) };
    });
    const weeklyScore = Math.round(
      dailyScores.reduce((sum, d) => sum + d.score, 0) / Math.max(dailyScores.length, 1),
    );

    return { activity, weeklyScore, rating: ratingForScore(weeklyScore), dailyScores };
  });

  rankings.sort((a, b) => b.weeklyScore - a.weeklyScore);

  const notes: string[] = [];
  if (!hasSurfData) {
    notes.push(
      "No marine/wave data available for this location — treated as non-coastal, so surfing scores 0.",
    );
  }

  return {
    city: {
      name: city.name,
      country: city.country,
      latitude: city.latitude,
      longitude: city.longitude,
      timezone: city.timezone,
    },
    generatedAt: new Date().toISOString(),
    notes,
    days: days.map((row) => ({
      date: row.date,
      tempMaxC: row.temp_max,
      tempMinC: row.temp_min,
      precipitationMm: row.precipitation_sum,
      snowfallCm: row.snowfall_sum,
      windSpeedMaxKmh: row.wind_speed_max,
      weatherCode: row.weather_code,
      waveHeightM: row.wave_height_max,
      wavePeriodS: row.wave_period_max,
    })),
    rankings,
  };
}

export const resolvers = {
  Query: {
    forecast: async (_: unknown, args: { city: string }, context: GraphQLContext) => {
      if (!args.city?.trim()) {
        throw createGraphQLError("city must not be empty", { extensions: { code: "BAD_USER_INPUT" } });
      }
      try {
        const bundle = await context.weatherService.getCityForecast(args.city);
        return buildCityForecast(bundle);
      } catch (err) {
        if (err instanceof CityNotFoundError) {
          throw createGraphQLError(err.message, { extensions: { code: "NOT_FOUND" } });
        }
        throw createGraphQLError(`Failed to fetch forecast for "${args.city}": ${errorMessage(err)}`, {
          extensions: { code: "UPSTREAM_ERROR" },
        });
      }
    },
    cities: (_: unknown, __: unknown, context: GraphQLContext) => {
      try {
        return context.repository.listCities().map((c) => ({
          name: c.name,
          country: c.country,
          latitude: c.latitude,
          longitude: c.longitude,
          timezone: c.timezone,
        }));
      } catch (err) {
        throw createGraphQLError(`Failed to list cities: ${errorMessage(err)}`, {
          extensions: { code: "UPSTREAM_ERROR" },
        });
      }
    },
  },
  Mutation: {
    refreshForecast: async (_: unknown, args: { city: string }, context: GraphQLContext) => {
      if (!args.city?.trim()) {
        throw createGraphQLError("city must not be empty", { extensions: { code: "BAD_USER_INPUT" } });
      }
      try {
        const bundle = await context.weatherService.getCityForecast(args.city, { forceRefresh: true });
        return buildCityForecast(bundle);
      } catch (err) {
        if (err instanceof CityNotFoundError) {
          throw createGraphQLError(err.message, { extensions: { code: "NOT_FOUND" } });
        }
        throw createGraphQLError(`Failed to refresh forecast for "${args.city}": ${errorMessage(err)}`, {
          extensions: { code: "UPSTREAM_ERROR" },
        });
      }
    },
  },
};
