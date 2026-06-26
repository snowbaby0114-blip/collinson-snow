# Design log: plan, trade-offs, assumptions

This is the running log of decisions made while building this exercise with Claude Code,
in lieu of a PM to check open questions with. Roughly chronological.

## Scope and time budget

The brief asks for "one well implemented feature over several rushed ones." I read the
two things it explicitly calls "part of the exercise" — the data model/persistence/refresh
strategy, and the ranking logic — as the graded core, and treated everything else
(schema ergonomics, error handling, a couple of unit tests) as supporting cast. Things I
consciously didn't build are listed at the end of the README rather than half-built here.

## Process question I'd normally ask a PM

Two things I decided myself rather than asking back-and-forth, because the brief invites
making the call and documenting it:

- **Submission mechanics** (GitHub repo creation, AI-session export format) — asked the
  human operator directly since those are account-level/external actions, not product
  decisions. Resolved: build locally, human pushes to GitHub themselves; this file plus
  commit history stands in for an exported chat transcript.
- **Everything about the ranking formulas, data model, and refresh policy** — these are
  exactly the kind of product ambiguity the exercise is testing judgement on, so I made
  a call and wrote down the reasoning (see README "Assumptions made").

## Stack choices and why

**Storage: better-sqlite3 over `node:sqlite`, Prisma, or Postgres.**

- A weather cache for "≤7 rows per city" is a textbook fit for an embedded, file-based
  database — no separate server to provision, trivial to hand to a reviewer (`npm install
&& npm run dev`, nothing else to stand up).
- Considered Node's built-in `node:sqlite` (no extra dependency at all, Node 22+). Rejected
  because it's still flagged experimental and would print a runtime warning on every
  start — not worth it just to save one dependency.
- Considered Prisma+SQLite for a "more production" feel with migrations. Rejected as
  overkill for two tables; raw SQL via better-sqlite3 (synchronous, no ORM overhead) is
  more legible at this scale, and I'd rather hand-write two `CREATE TABLE` statements than
  pull in a code-gen step.
- Verified before committing: `better-sqlite3@^12` installs from a prebuilt binary on this
  Windows machine with no compiler — the pinned `^11.10.0` I started with did not have a
  prebuild for Node 24 and fell back to node-gyp (which needs Visual Studio build tools).
  Bumped the pin after confirming the failure, rather than asking the reviewer to install
  a C++ toolchain just to run a take-home.

**GraphQL: graphql-yoga over Apollo Server.** Both are fine choices; Yoga has fewer moving
parts for a single-schema, no-federation service, and ships a usable GraphiQL UI out of
the box for manual exploration.

**Scores computed on read, not persisted.** Only raw weather columns are stored. Scores
are pure functions of those columns, computed per-request. This means tuning a scoring
formula is a code change with no migration/backfill — and the trade-off is recomputing
4 activities × 7 days of arithmetic per request, which is cheap enough not to matter at
this scale. Would revisit if this became a high-QPS service.

## Data model

```
cities            (id, query_name UNIQUE, name, country, latitude, longitude, timezone, created_at)
daily_forecasts   (id, city_id, date, temp_max, temp_min, precipitation_sum, snowfall_sum,
                    wind_speed_max, wind_gusts_max, weather_code, wave_height_max,
                    wave_period_max, fetched_at, UNIQUE(city_id, date))
```

- `query_name` is the lowercased/trimmed input string, separate from `name` (the
  geocoder's canonical display name) — so "new york", "New York", " New York " all hit the
  same cached row without a second geocoding call, while the response still shows the
  proper-cased name.
- `wave_height_max`/`wave_period_max` are nullable: most cities aren't coastal, and
  Open-Meteo's marine API confirms this with `null` values (HTTP 200) rather than an
  error — verified this against a landlocked coordinate (Denver) before writing the
  null-handling code, rather than guessing at the failure mode.
- One row per (city, date) rather than per (city, date, activity) — the activities don't
  need separate storage, they're just different lenses on the same weather row.

## Refresh strategy

On each `forecast(city)` query:

1. Look up the city by normalized name; geocode-and-insert if it's new.
2. Check whether there are 7 forecast rows for today-onward (in the city's own timezone)
   and whether the oldest of them was fetched within the last 3 hours.
3. If either check fails, fetch land + marine forecasts concurrently and upsert all 7 days.

3 hours was picked because Open-Meteo's underlying models (e.g. GFS, ECMWF) rerun a few
times a day — short enough that a "today" forecast doesn't go stale mid-day, long enough
that repeated queries for a popular city don't generate one upstream call each.

This is **lazy/on-demand** refresh, not a background cron. The trade-off: the first
request after data goes stale pays the Open-Meteo round-trip latency; a scheduled
refresh job would avoid that at the cost of refreshing cities nobody's currently asking
about. Noted as the top follow-up in the README rather than built, given the time budget.

## Ranking formulas

Each activity gets a 0–100 score per day from a small set of weighted, clamped functions
over the raw weather fields (see `src/scoring/index.ts`, which has no I/O and is the most
heavily unit-tested part of the codebase for that reason). The reasoning per activity
lives here and in the README rather than as code comments — short version:

- **Skiing** — cold temps (ideal −10 to 0°C) + fresh snowfall, penalised by high wind.
  No snow-base data exists in Open-Meteo, so a city with a great snowpack but no fresh
  snow this week will under-score relative to reality — called out as a limitation.
- **Surfing** — wave height in a comfortable range (1.0–2.2m ideal), rewarding longer
  wave period (cleaner swell), penalised by wind. Scores 0 with an explanatory `note`
  when there's no marine data at all (non-coastal).
- **Outdoor sightseeing** — mild temp (16–26°C ideal) + clear-sky weather code, penalised
  by precipitation and wind.
- **Indoor sightseeing** — high baseline (weather-resilient activity) that rises further
  when the outdoor score is poor, with a penalty only for severe-storm + high-wind days
  (getting to the museum is itself unpleasant). This was the one activity where "rank by
  how good the weather is for it" doesn't map directly to "good weather" — worth flagging
  as the squishiest of the four formulas.

Weekly score = mean of the 7 daily scores (see README for the "average vs. best-day"
trade-off).

## Verification performed (first pass)

- `npm test` — 16 unit tests over the scoring functions (one regression caught and fixed:
  the initial indoor-sightseeing formula let the "bad weather bonus" exactly cancel out
  the "severe storm" penalty for a specific input, so a dangerous storm scored identically
  to a calm clear day; rebalanced the penalty to scale with wind speed instead of being a
  flat constant).
- `npm run build` — clean `tsc` type-check.
- Manual GraphQL queries against the running server for: a coastal Southern-Hemisphere
  winter city (Sydney — confirmed indoor > outdoor, surf data present, skiing correctly 0),
  a landlocked city (Denver — confirmed surf note appears, surf score 0), a Northern
  Hemisphere ski town in summer (Whistler — confirmed skiing correctly scores 0 with no
  snow in the forecast), a second request for an already-cached city (confirmed ~40ms
  response, i.e. served from SQLite and not Open-Meteo), an invalid city name (confirmed
  a clean `NOT_FOUND` GraphQL error rather than a generic 500).

## Hardening pass: from "demoed once" to "tested under adversarial conditions"

The first pass worked and was manually verified, but it had the gaps you'd expect from
optimizing for the 2–3 hour budget over rigor: zero test coverage on the persistence/
refresh logic (the two things the brief says are "part of the exercise" — somewhat
embarrassing to have only proven those by hand), no resilience on outbound HTTP calls,
and a real concurrency bug. Going through these in the order I found them:

**The concurrency bug, in two layers.** `getCityForecast` looked up a city, and if
missing, geocoded and inserted it. Two simultaneous requests for the same brand-new city
both pass the "not found" check before either has inserted — the loser then hits SQLite's
`UNIQUE` constraint on `query_name` and the request 500s. This is a genuine correctness
bug, not a hypothetical: any two users hitting a cold city around the same moment trigger
it. First fix: `WeatherRepository.insertCity` catches `SQLITE_CONSTRAINT_UNIQUE`
specifically (verified the exact error shape — `err.code === 'SQLITE_CONSTRAINT_UNIQUE'`
— against better-sqlite3 directly before writing the catch) and returns the row the
winner just inserted, instead of treating "someone else already cached this" as a
failure.

That fix stops the 500, and I initially stopped there because the unit test for it
passed. Then I ran the actual scenario against a live server — five real concurrent HTTP
requests for a brand-new city — and the structured logs showed all five independently
geocoding and fetching the forecast: no crash, but five upstream round-trips for one
city, which is exactly the kind of thing that looks fine in a unit test and wasteful in
production. Second fix: `WeatherService.getCityForecast` now keys in-flight requests by
normalized city name (plus whether it's a forced refresh) and has every caller for the
same key share one promise, so N concurrent requests collapse into one geocode call and
one forecast fetch. Re-ran the same live concurrent-request test afterward and confirmed
the logs show exactly one of each. Kept the repository-level constraint catch as
defense-in-depth — coalescing only protects a single process's in-memory map, so it
wouldn't help if this ever ran as multiple replicas sharing one SQLite file.

Both layers are pinned down by tests: one gates two concurrent calls on the same
in-flight geocode promise and asserts only one city row exists, another asserts the fake
data source's `geocodeCity`/`fetchLandForecast` are each called exactly once across five
concurrent calls for the same (normalized) city name, and a third confirms two genuinely
different cities are _not_ incorrectly coalesced together.

**No resilience on outbound calls.** The Open-Meteo client had no timeout, so a hung
upstream response would hang the GraphQL request forever, and no retry, so a single
transient blip (a 503, a dropped connection) failed the whole forecast. Added a 10s
timeout via `AbortController` and 2 retries with exponential backoff, but only for
429/5xx — retrying a 400 or 404 would just waste three round-trips confirming the same
client error.

**Conflated failure modes on the marine API.** The original `fetchMarineForecast` caught
_any_ error — network failure, timeout, malformed response — and returned `null`, the
same value it returns for "this is genuinely a landlocked city." That means a real marine
API outage would have been silently indistinguishable from Denver. Split this: the client
now only returns `null` when Open-Meteo responds successfully with all-null wave arrays,
and throws `UpstreamWeatherError` on an actual request failure. `WeatherService` fetches
land and marine forecasts via `Promise.allSettled` (not `Promise.all`, which would have
let a marine failure take down the land forecast that succeeded right alongside it),
catches a marine-specific failure, logs it as a warning, and still returns the forecast
without a surf score — a real outage is now visible in logs instead of silently looking
like "not coastal."

**Untestable architecture.** `db`, the repository functions, and the Open-Meteo client
were module-level singletons imported directly wherever needed — there was no seam to
inject a fake network layer, so only the pure scoring functions had tests. Refactored to
dependency-injected classes: `WeatherRepository` takes a `Database.Database` in its
constructor (production code passes a file-backed one, tests pass `:memory:`), and
`WeatherService` takes a `WeatherDataSource` _interface_ rather than the concrete
`OpenMeteoClient` class — `OpenMeteoClient implements WeatherDataSource`, and tests
implement a fake against the same interface. This is the one change that's more
"infrastructure" than "feature," but it's what made every other fix in this section
provable rather than asserted: 21 new tests now cover staleness/refresh decisions, the
two-layer race condition, request coalescing, and the marine-failure degradation path,
against a real in-memory SQLite database with only the network replaced.

**Wiring.** `WeatherRepository`/`OpenMeteoClient`/`WeatherService` are constructed once in
`src/index.ts` and passed to resolvers through the Yoga `context()` factory rather than
imported as singletons — the idiomatic GraphQL DI pattern, and consistent with the
constructor-injection style used everywhere else in this pass.

**Also added:** graceful shutdown (`SIGINT`/`SIGTERM` close the HTTP server and the
SQLite handle, with a 5s hard-exit fallback so a hang doesn't block a deploy), structured
JSON logging for refresh decisions, a `config.ts` pulling the previously hardcoded
staleness window/timeouts/retry counts into one place with env var overrides, ESLint +
Prettier with both wired into CI, and a GitHub Actions workflow running lint, format
check, build, and test on every push/PR — table stakes for a repo more than one person is
going to touch, and there was no CI at all in the first pass.

Worth being honest about a platform wrinkle found while verifying the shutdown handler:
on native Windows (this dev machine, not WSL/Linux), Node treats `SIGTERM` sent via
`process.kill()` from another process as an unconditional terminate rather than
delivering it to the handler — a documented Node-on-Windows limitation, not a bug in this
code. Confirmed the handler logic itself is correct by having the running process
self-emit the signal (`process.emit("SIGINT")`), which exercises the exact same
listener Node would invoke on a real signal: it closed the HTTP server, closed the
SQLite handle, logged both steps, and exited cleanly well inside the 5s fallback window.
This pattern is the one that matters in practice anyway — it's what Docker/Kubernetes
send on container shutdown, on Linux, where Node's signal handling is standard POSIX.

**Deliberately not done in this pass** (see README "Production hardening" for the fuller
list): a background refresh job, GraphQL query complexity limiting, rate limiting. These
are real gaps for production traffic, but they're additive features rather than
correctness fixes, and the brief's instruction to prefer "one well implemented feature
over several rushed ones" argued for finishing the resilience/testability work properly
over starting a fifth thing.

## Verification performed (hardening pass)

- `npm run lint` / `npm run format:check` — clean.
- `npx tsc --noEmit` — clean (also caught that `let marineDays = null` was relying on
  TypeScript's "evolving any" inference rather than an explicit type; tightened it).
- `npm test` — 37 tests across three files: the original 16 scoring tests, 8
  `WeatherRepository` tests against a real in-memory SQLite database (including the
  concurrent-insert race), and 13 `WeatherService` tests against that same repository
  with a fake `WeatherDataSource` (cache hit/miss, staleness, forced refresh, marine
  failure degrading gracefully vs. land failure propagating, request coalescing, and not
  coalescing genuinely different cities).
- Confirmed `npm run build` after the refactor still produces a server that behaves
  identically over the wire — re-ran the same manual GraphQL smoke tests from the first
  pass (Sydney, Denver, Whistler, cache-hit timing, invalid city) with no regressions.
- Live concurrency test against the running server: fired 5 real concurrent HTTP requests
  for a brand-new city. Before coalescing, structured logs showed 5 separate "geocoded
  new city" + "refreshing forecast" entries (no crash, but 5x redundant upstream calls);
  after adding coalescing, the identical test produced exactly one of each, with all 5
  HTTP responses still succeeding and the `cities` table still showing exactly one row.
- Verified graceful shutdown by self-emitting `SIGINT` on the running process and
  confirming the close-server → close-db → exit(0) sequence completes well inside the 5s
  hard-exit fallback (see the SIGTERM/Windows note above for why cross-process signal
  delivery wasn't a reliable way to test this on this machine).
