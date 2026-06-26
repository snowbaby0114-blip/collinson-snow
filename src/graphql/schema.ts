export const typeDefs = `
  enum Activity {
    SKIING
    SURFING
    OUTDOOR_SIGHTSEEING
    INDOOR_SIGHTSEEING
  }

  type City {
    name: String!
    country: String
    latitude: Float!
    longitude: Float!
    timezone: String!
  }

  type DailyConditions {
    date: String!
    tempMaxC: Float!
    tempMinC: Float!
    precipitationMm: Float!
    snowfallCm: Float!
    windSpeedMaxKmh: Float!
    weatherCode: Int!
    waveHeightM: Float
    wavePeriodS: Float
  }

  type ActivityDayScore {
    date: String!
    score: Int!
    rating: String!
  }

  type ActivityRanking {
    activity: Activity!
    weeklyScore: Int!
    rating: String!
    dailyScores: [ActivityDayScore!]!
  }

  type CityForecast {
    city: City!
    generatedAt: String!
    notes: [String!]!
    days: [DailyConditions!]!
    rankings: [ActivityRanking!]!
  }

  type Query {
    """
    Look up the next 7 days of weather for a city/town and rank it for
    Skiing, Surfing, Outdoor Sightseeing and Indoor Sightseeing.
    Data is persisted and only re-fetched from Open-Meteo when stale.
    """
    forecast(city: String!): CityForecast!

    "Cities previously looked up, with their cached forecast data."
    cities: [City!]!
  }

  type Mutation {
    "Force a refresh from Open-Meteo, bypassing the staleness cache."
    refreshForecast(city: String!): CityForecast!
  }
`;
