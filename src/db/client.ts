import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function createDatabase(path: string): Database.Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS cities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_name TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      country TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      timezone TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_forecasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city_id INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      temp_max REAL NOT NULL,
      temp_min REAL NOT NULL,
      precipitation_sum REAL NOT NULL,
      snowfall_sum REAL NOT NULL,
      wind_speed_max REAL NOT NULL,
      wind_gusts_max REAL NOT NULL,
      weather_code INTEGER NOT NULL,
      wave_height_max REAL,
      wave_period_max REAL,
      fetched_at TEXT NOT NULL,
      UNIQUE(city_id, date)
    );
  `);

  return db;
}
