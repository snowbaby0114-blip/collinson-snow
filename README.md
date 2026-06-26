# Weather Activity Ranker

A GraphQL service that takes a city or town and ranks the next 7 days for **Skiing**,
**Surfing**, **Outdoor Sightseeing** and **Indoor Sightseeing**, using weather data from
[Open-Meteo](https://open-meteo.com/).

See [DECISIONS.md](./DECISIONS.md) for the design plan, trade-offs, open questions and
assumptions made along the way.

## Stack

- **Node.js 20+ / TypeScript**
- **GraphQL** via [graphql-yoga](https://the-guild.dev/graphql/yoga-server)
- **SQLite** via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — a single
  file database is the right amount of storage for "one row per city per day"; no server
  to run, ships a prebuilt native binary for common platforms (no compiler needed).
- **Vitest** for unit + integration tests, **ESLint**/**Prettier** for lint and formatting,
  a GitHub Actions workflow ([.github/workflows/ci.yml](./.github/workflows/ci.yml)) running
  all of the above on every push/PR.
- No API key needed — Open-Meteo's geocoding, forecast and marine APIs are all free/open.

## Running it

```bash
npm install
npm run dev           # starts the GraphQL server at http://localhost:4000/graphql, with reload
# or
npm start             # same, without watch mode
npm test              # unit + integration tests
npm run lint          # ESLint
npm run format:check  # Prettier check (npm run format to auto-fix)
npm run build         # type-checks and compiles to dist/
```

The SQLite file is created on first run at `data/weather.sqlite` (override with the
`DATABASE_PATH` env var). `PORT` defaults to `4000`.

Open `http://localhost:4000/graphql` in a browser for the interactive GraphiQL explorer.

## Example query

```graphql
query {
  forecast(city: "Lisbon") {
    city {
      name
      country
      timezone
    }
    notes
    rankings {
      activity
      weeklyScore
      rating
      dailyScores {
        date
        score
        rating
      }
    }
  }
}
```

`rankings` is sorted best-to-worst, so `rankings[0]` is the best activity for that city
over the coming week. There's also a `cities` query to list everything looked up so far,
and a `refreshForecast(city: String!)` mutation to force a refetch from Open-Meteo,
bypassing the staleness cache.

## How it works

1. **Resolve the city** — Open-Meteo's geocoding API turns a free-text name into
   coordinates + timezone. The result is cached in the `cities` table so the same name
   isn't re-geocoded every time.
2. **Persist, don't refetch** — each city has up to 7 rows in `daily_forecasts` (one per
   date). A request only calls out to Open-Meteo if data for the next 7 days is missing
   or older than 3 hours (Open-Meteo reruns its forecast model multiple times a day, so
   this keeps data fresh without hammering the API on every request).
3. **Score, don't store, the rankings** — activity scores are computed from the raw
   persisted weather columns on every request. That keeps the scoring formulas free to
   change without a migration or a backfill job.
4. **Surfing on non-coastal locations** — Open-Meteo's marine API returns `null` wave
   data for landlocked coordinates rather than an error. Surfing scores 0 in that case,
   and a human-readable note is added to the response explaining why.

## Architecture

```
OpenMeteoClient (implements WeatherDataSource)   WeatherRepository
        │  geocode / forecast / marine                │  SQLite reads & writes
        └───────────────┬───────────────────────────────┘
                         ▼
                  WeatherService
           (staleness check, refresh, scoring inputs)
                         ▼
              GraphQL context → resolvers
```

`WeatherService` depends on the `WeatherDataSource` _interface_, not the concrete
`OpenMeteoClient` — so tests inject a fake data source against a real in-memory SQLite
database, exercising the actual staleness/refresh/race-condition logic without any
network calls (see `src/weather/refresh.test.ts`). `WeatherRepository` and the
`WeatherService` instance are constructed once in [src/index.ts](./src/index.ts) and
passed into every resolver via the Yoga `context()` factory, rather than imported as
module-level singletons — so resolvers are pure functions of their arguments and context.

Resilience and correctness details that came out of testing this seriously rather than
just demoing it once:

- **Outbound requests have a timeout (10s) and retry with backoff** (2 retries, 429/5xx
  only) — `src/openMeteo/client.ts`. Without this, a slow Open-Meteo response would hang
  the GraphQL request indefinitely.
- **"Landlocked" and "marine API is down" are different failure modes.** The client
  returns `null` only when Open-Meteo responds successfully with empty wave data; a
  genuine request failure throws `UpstreamWeatherError` instead. `WeatherService` catches
  that specifically and logs a warning, degrading to "no surf score" rather than failing
  the whole forecast over an optional data source (`fetchAndPersist` in
  `src/weather/refresh.ts`, using `Promise.allSettled` so a marine outage can't take down
  the land forecast that succeeded in parallel).
- **Concurrent requests for the same city are coalesced, not just deduplicated after the
  fact.** `WeatherService` keys in-flight requests by normalized city name and shares one
  promise across callers, so 5 simultaneous `forecast(city: "Marrakesh")` calls for a
  brand-new city make exactly one geocode call and one forecast fetch, not five — verified
  by firing real concurrent HTTP requests at a running server and checking the structured
  logs. `WeatherRepository.insertCity` also catches SQLite's `UNIQUE` constraint violation
  as defense-in-depth (relevant if this ever runs as multiple processes sharing one SQLite
  file, where coalescing inside a single process can't help). Both layers are covered by
  tests in `src/weather/refresh.test.ts`.
- **Graceful shutdown** — `SIGINT`/`SIGTERM` close the HTTP server and the SQLite handle
  before exiting, with a 5s hard-exit fallback if something hangs (`src/index.ts`).
- **Structured JSON logs** for refresh decisions (new city geocoded, cache hit vs. stale
  vs. forced refresh, marine degradation) — `src/logger.ts`. No log aggregation behind
  it, but the shape is ready for one.

## Assumptions made (no PM to ask)

- **Geocoding takes the single best match** for the input string. Ambiguous names (e.g.
  "Queenstown" matches South Africa before New Zealand) resolve to whatever Open-Meteo's
  geocoder ranks first — there's no disambiguation UI. A real product would likely surface
  multiple candidates and let the user pick, or accept a country hint.
- **"Next 7 days" means the city's local calendar days**, starting today in its own
  timezone (`timezone=auto` from Open-Meteo), not 7×24 hours from the request time.
- **Skiing is scored from forecast conditions only** (cold temps + fresh snowfall), since
  Open-Meteo doesn't expose snow-base depth or resort/lift status. A real ski-conditions
  product would pull that from resort-specific feeds.
- **Surfing ignores swell/wind direction** relative to the coastline (Open-Meteo doesn't
  tell us which way a beach faces), so it's scored on wave height, period, and wind speed
  only — a reasonable proxy, not a substitute for a local surf forecast.
- **A week's "ranking" is the simple average of its 7 daily scores.** An alternative would
  be "best single day", which rewards a city with one perfect day and six bad ones — felt
  less honest for a 7-day planning view, so I went with the average.
- **Indoor sightseeing is treated as weather-resilient but not weather-immune**: it starts
  from a high baseline (always a reasonable choice) and gets a further boost on days when
  the outdoor alternative is poor, with a penalty only for conditions severe enough that
  travelling there is itself unpleasant (e.g. storm-force wind).

## What I'd do next with more time

Prioritised the persistence/refresh model and the scoring logic (the two things the brief
called out as "part of the exercise") over breadth of features, then spent the remaining
time on the things a senior engineer is expected to catch in review — a real concurrency
bug, untested persistence/refresh logic, and no resilience on outbound calls — rather than
new surface area. Still left out, in priority order:

1. **A background refresh job** (e.g. cron every few hours for all known cities) so the
   _first_ request after data goes stale isn't the one paying the Open-Meteo round-trip.
   Currently refresh is purely on-demand/lazy.
2. **Pagination/search on `cities`** — fine for a handful of cities, wouldn't scale to
   thousands of lookups.
3. **A small weighting config** (expose the scoring weights as constants someone could
   tune) rather than hand-picked numbers baked into the functions.
4. **Production hardening I'd want before this took real traffic**: GraphQL introspection
   disabled and query depth/complexity limiting (a single `forecast` query is cheap, but
   the schema doesn't currently stop someone from requesting it for thousands of cities in
   one request), rate limiting per client, and a real log sink instead of stdout JSON
   lines.
