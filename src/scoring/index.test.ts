import { describe, expect, it } from "vitest";
import {
  type DayInput,
  ratingForScore,
  scoreIndoorSightseeing,
  scoreOutdoorSightseeing,
  scoreSkiing,
  scoreSurfing,
} from "./index.js";

function day(overrides: Partial<DayInput>): DayInput {
  return {
    tempMax: 20,
    tempMin: 10,
    precipitationSum: 0,
    snowfallSum: 0,
    windSpeedMax: 10,
    weatherCode: 0,
    waveHeightMax: null,
    wavePeriodMax: null,
    ...overrides,
  };
}

describe("scoreSkiing", () => {
  it("scores cold days with fresh powder highly", () => {
    const score = scoreSkiing(day({ tempMax: -5, snowfallSum: 10, windSpeedMax: 10 }));
    expect(score).toBeGreaterThanOrEqual(80);
  });

  it("scores a warm, snowless day near zero", () => {
    const score = scoreSkiing(day({ tempMax: 20, snowfallSum: 0, windSpeedMax: 10 }));
    expect(score).toBeLessThan(20);
  });

  it("penalises high wind even on an otherwise great ski day", () => {
    const calm = scoreSkiing(day({ tempMax: -5, snowfallSum: 10, windSpeedMax: 10 }));
    const windy = scoreSkiing(day({ tempMax: -5, snowfallSum: 10, windSpeedMax: 70 }));
    expect(windy).toBeLessThan(calm);
  });
});

describe("scoreSurfing", () => {
  it("returns 0 when there is no marine data (landlocked)", () => {
    expect(scoreSurfing(day({ waveHeightMax: null }))).toBe(0);
  });

  it("scores a clean mid-size swell highly", () => {
    const score = scoreSurfing(day({ waveHeightMax: 1.5, wavePeriodMax: 10, windSpeedMax: 10 }));
    expect(score).toBeGreaterThanOrEqual(80);
  });

  it("scores a flat, glassy day near zero", () => {
    const score = scoreSurfing(day({ waveHeightMax: 0.1, wavePeriodMax: 4, windSpeedMax: 5 }));
    expect(score).toBeLessThan(10);
  });
});

describe("scoreOutdoorSightseeing", () => {
  it("scores a mild, clear, calm day highly", () => {
    const score = scoreOutdoorSightseeing(
      day({ tempMax: 22, weatherCode: 0, precipitationSum: 0, windSpeedMax: 5 }),
    );
    expect(score).toBeGreaterThanOrEqual(80);
  });

  it("scores a heavy-rain day poorly", () => {
    const score = scoreOutdoorSightseeing(day({ tempMax: 18, weatherCode: 65, precipitationSum: 25 }));
    expect(score).toBeLessThan(20);
  });
});

describe("scoreIndoorSightseeing", () => {
  it("rates higher on a rainy day than on a perfect outdoor day", () => {
    const rainyDay = day({ tempMax: 12, weatherCode: 65, precipitationSum: 20 });
    const sunnyDay = day({ tempMax: 22, weatherCode: 0, precipitationSum: 0 });
    expect(scoreIndoorSightseeing(rainyDay)).toBeGreaterThan(scoreIndoorSightseeing(sunnyDay));
  });

  it("still rates reasonably on a perfect day (weather-resilient activity)", () => {
    const score = scoreIndoorSightseeing(day({ tempMax: 22, weatherCode: 0, precipitationSum: 0 }));
    expect(score).toBeGreaterThanOrEqual(60);
  });

  it("drops for a dangerous storm with extreme wind", () => {
    const score = scoreIndoorSightseeing(day({ weatherCode: 99, windSpeedMax: 80 }));
    expect(score).toBeLessThan(scoreIndoorSightseeing(day({ weatherCode: 0, windSpeedMax: 5 })));
  });
});

describe("ratingForScore", () => {
  it.each([
    [95, "Excellent"],
    [70, "Good"],
    [50, "Fair"],
    [25, "Poor"],
    [5, "Very Poor"],
  ] as const)("maps %i to %s", (score, expected) => {
    expect(ratingForScore(score)).toBe(expected);
  });
});
