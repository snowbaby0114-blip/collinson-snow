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

  it.each([
    [-25, 0],
    [-30, 0],
    [-10, 50],
    [0, 50],
    [5, 0],
    [10, 0],
    [-17.5, 25],
  ] as const)("scores tempMax %i as %i at the ideal-band boundaries (no snow/wind)", (tempMax, expected) => {
    const score = scoreSkiing(day({ tempMax, snowfallSum: 0, windSpeedMax: 0 }));
    expect(score).toBe(expected);
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

  it.each([
    [0.3, 0],
    [0.2, 0],
    [1.0, 60],
    [2.2, 60],
    [3.5, 0],
    [4.0, 0],
  ] as const)(
    "scores waveHeightMax %i as %i at the ideal-band boundaries (period/wind neutral)",
    (waveHeightMax, expected) => {
      const score = scoreSurfing(day({ waveHeightMax, wavePeriodMax: 5, windSpeedMax: 0 }));
      expect(score).toBe(expected);
    },
  );
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

  it.each([
    [0, 100],
    [1, 90],
    [2, 90],
    [3, 90],
    [45, 78],
    [51, 78],
    [61, 78],
    [71, 78],
    [80, 78],
    [53, 65],
    [63, 65],
    [82, 65],
    [95, 53],
    [99, 53],
  ] as const)(
    "scores weather code %i (severity bucket) as %i when temp/wind/precip are neutral",
    (weatherCode, expected) => {
      const score = scoreOutdoorSightseeing(
        day({ tempMax: 20, weatherCode, precipitationSum: 0, windSpeedMax: 0 }),
      );
      expect(score).toBe(expected);
    },
  );
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
