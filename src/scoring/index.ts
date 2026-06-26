import type { DailyForecastRow } from "../db/repository.js";

export type Rating = "Excellent" | "Good" | "Fair" | "Poor" | "Very Poor";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function triangular(value: number, low: number, idealLow: number, idealHigh: number, high: number): number {
  if (value <= low || value >= high) return 0;
  if (value >= idealLow && value <= idealHigh) return 100;
  if (value < idealLow) return ((value - low) / (idealLow - low)) * 100;
  return ((high - value) / (high - idealHigh)) * 100;
}

function weatherSeverity(code: number): 0 | 1 | 2 | 3 | 4 {
  if (code === 0) return 0;
  if ([1, 2, 3].includes(code)) return 1;
  if ([45, 48, 51, 56, 61, 66, 71, 77, 80, 85].includes(code)) return 2;
  if ([53, 55, 57, 63, 67, 73, 82, 86].includes(code)) return 3;
  return 4;
}

const SEVERITY_SCORE = [100, 80, 55, 30, 5] as const;

export function ratingForScore(score: number): Rating {
  if (score >= 80) return "Excellent";
  if (score >= 60) return "Good";
  if (score >= 40) return "Fair";
  if (score >= 20) return "Poor";
  return "Very Poor";
}

export interface DayInput {
  tempMax: number;
  tempMin: number;
  precipitationSum: number;
  snowfallSum: number;
  windSpeedMax: number;
  weatherCode: number;
  waveHeightMax: number | null;
  wavePeriodMax: number | null;
}

export function dayInputFromRow(row: DailyForecastRow): DayInput {
  return {
    tempMax: row.temp_max,
    tempMin: row.temp_min,
    precipitationSum: row.precipitation_sum,
    snowfallSum: row.snowfall_sum,
    windSpeedMax: row.wind_speed_max,
    weatherCode: row.weather_code,
    waveHeightMax: row.wave_height_max,
    wavePeriodMax: row.wave_period_max,
  };
}

export function scoreSkiing(day: DayInput): number {
  const tempScore = triangular(day.tempMax, -25, -10, 0, 5);
  const snowScore = clamp(day.snowfallSum / 8, 0, 1) * 100;
  const windPenalty = clamp((day.windSpeedMax - 35) / 25, 0, 1) * 40;

  return Math.round(clamp(0.5 * tempScore + 0.5 * snowScore - windPenalty, 0, 100));
}

export function scoreSurfing(day: DayInput): number {
  if (day.waveHeightMax === null) return 0;

  const waveScore = triangular(day.waveHeightMax, 0.3, 1.0, 2.2, 3.5);
  const periodScore = clamp(((day.wavePeriodMax ?? 5) - 5) / 7, 0, 1) * 100;
  const windPenalty = clamp((day.windSpeedMax - 20) / 30, 0, 1) * 35;

  return Math.round(clamp(0.6 * waveScore + 0.4 * periodScore - windPenalty, 0, 100));
}

export function scoreOutdoorSightseeing(day: DayInput): number {
  const tempScore = triangular(day.tempMax, 0, 16, 26, 36);
  const skyScore = SEVERITY_SCORE[weatherSeverity(day.weatherCode)];
  const precipPenalty = clamp(day.precipitationSum / 15, 0, 1) * 60;
  const windPenalty = clamp((day.windSpeedMax - 20) / 40, 0, 1) * 20;

  return Math.round(clamp(0.5 * tempScore + 0.5 * skyScore - precipPenalty - windPenalty, 0, 100));
}

export function scoreIndoorSightseeing(day: DayInput): number {
  const outdoorScore = scoreOutdoorSightseeing(day);
  const baseline = 75;
  const badWeatherBonus = (100 - outdoorScore) * 0.3;
  const severeTravelPenalty =
    weatherSeverity(day.weatherCode) === 4 ? clamp((day.windSpeedMax - 50) / 30, 0, 1) * 40 : 0;

  return Math.round(clamp(baseline + badWeatherBonus - severeTravelPenalty, 0, 100));
}
