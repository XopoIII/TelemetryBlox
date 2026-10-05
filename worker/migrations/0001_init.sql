-- TelemetryBlox ingest schema (D1), sized for Cloudflare's FREE plan.
--
-- Applied by wrangler from the installed package: the game's wrangler config names this folder as
-- its `migrations_dir`, and `wrangler d1 migrations apply <database> --remote` runs every file here
-- that the database has not seen (README.md, "The Worker"). Every statement is IF NOT EXISTS, so the
-- file is also safe on a database that already holds these tables.
--
-- A later change to the schema is a new numbered file in this folder, never an edit of this one.
--
-- ONE ROW PER BATCH, not per event. The free plan allows 100,000 rows WRITTEN a day, and every
-- index write counts as another row. A row per event with four indexes costs about five writes an
-- event; a row per batch costs two a batch (the table and its one unique index), whatever the batch
-- holds. The events ride inside the row as a JSON array.
--
-- The `events` VIEW below expands the batches back into one row per event with SQLite's json_each,
-- so every query reads as if events were stored one per row. `ctx` is JSON text, read with
-- json_extract():
--
--   SELECT json_extract(ctx,'$.food') AS food, COUNT(*)
--   FROM events WHERE event = 'feed' AND env = 'live' GROUP BY food ORDER BY 2 DESC;

CREATE TABLE IF NOT EXISTS batches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  -- when the ingest accepted it (the Worker's clock); each event also carries its own time `t`
  received_at    INTEGER NOT NULL,
  env            TEXT    NOT NULL, -- 'live', 'studio', 'test': NEVER mix these in an analysis
  schema_version INTEGER NOT NULL,
  universe_id    TEXT    NOT NULL,
  place_id       TEXT    NOT NULL,
  place_version  INTEGER,
  job_id         TEXT    NOT NULL,
  server_start   INTEGER NOT NULL,
  first_seq      INTEGER NOT NULL,
  last_seq       INTEGER NOT NULL,
  n              INTEGER NOT NULL, -- events in this batch; SUM(n) is the retention budget's measure
  events         TEXT    NOT NULL  -- JSON array of {seq, t, event, actor?, ctx}
);

-- IDEMPOTENCY. The pipe holds a refused batch and posts it again, so a post that was stored but
-- whose answer was lost WILL arrive twice. (job_id, server_start, first_seq) names a batch; with
-- INSERT OR IGNORE the second arrival is free. `server_start` is in the key because Studio leaves
-- the job id empty.
-- The only index, on purpose: each extra one costs a row written per batch on the free plan.
CREATE UNIQUE INDEX IF NOT EXISTS idx_batches_identity ON batches (job_id, server_start, first_seq);

CREATE VIEW IF NOT EXISTS events AS
SELECT
  b.id                                            AS batch_id,
  b.received_at                                   AS received_at,
  json_extract(e.value, '$.t')                    AS t,
  json_extract(e.value, '$.seq')                  AS seq,
  json_extract(e.value, '$.event')                AS event,
  json_extract(e.value, '$.actor')                AS actor,
  COALESCE(json_extract(e.value, '$.ctx'), '{}')  AS ctx,
  b.env                                           AS env,
  b.schema_version                                AS schema_version,
  b.universe_id                                   AS universe_id,
  b.place_id                                      AS place_id,
  b.place_version                                 AS place_version,
  b.job_id                                        AS job_id,
  b.server_start                                  AS server_start
FROM batches b, json_each(b.events) e;

-- RETENTION (src/retention.ts). A free D1 database stops at 500 MB and nothing warns first; the
-- symptom is refused writes. The nightly job rolls each finished day up here FIRST, then prunes old
-- batches, so long-run trends survive at a few rows a day.
CREATE TABLE IF NOT EXISTS events_daily (
  day         TEXT    NOT NULL, -- 'YYYY-MM-DD', UTC (date(t,'unixepoch'))
  event       TEXT    NOT NULL,
  env         TEXT    NOT NULL,
  universe_id TEXT    NOT NULL,
  events      INTEGER NOT NULL,
  actors      INTEGER NOT NULL, -- distinct actors that day
  PRIMARY KEY (day, event, env, universe_id)
);
-- The row with event '*' is the whole day: every event, and the distinct actors across all of them,
-- which is the day's players. No sum over the per-event rows gives that, so it is kept on its own.

-- FIRST SEEN. When each player was first seen, and on which place version. Every cohort is counted
-- from this moment, and the raw batches it would otherwise be read from are pruned: after that a
-- player's "first" row is merely the oldest one left, and old cohorts quietly move forward. The
-- nightly job fills this BEFORE it prunes, one row written per new player, once.
CREATE TABLE IF NOT EXISTS actors (
  actor         TEXT    NOT NULL,
  env           TEXT    NOT NULL,
  universe_id   TEXT    NOT NULL,
  first_seen    INTEGER NOT NULL, -- the `t` of their oldest event
  first_version INTEGER,          -- the place version that event came from
  PRIMARY KEY (actor, env, universe_id)
) WITHOUT ROWID;

-- What a query reads: the kept moment, or for a player who arrived since the last nightly run the
-- oldest raw event. Never `MIN(t)` over `events` alone.
CREATE VIEW IF NOT EXISTS first_seen AS
SELECT actor, env, MIN(t0) AS t0
FROM (
  SELECT actor, env, first_seen AS t0 FROM actors
  UNION ALL
  SELECT actor, env, MIN(t) AS t0 FROM events WHERE actor IS NOT NULL GROUP BY actor, env
)
GROUP BY actor, env;

-- ALERTS (src/alerts.ts). One row for each alert key ever sent: when, and how many of it were held
-- back since. A key inside its cool-down is counted in `held` and not sent; the next one past it is
-- sent and hands the count over in `released`. A row written per alert, so a batch raises a handful
-- at most.
CREATE TABLE IF NOT EXISTS alert_state (
  key      TEXT    NOT NULL PRIMARY KEY,
  sent_at  INTEGER NOT NULL,
  held     INTEGER NOT NULL,
  released INTEGER NOT NULL
) WITHOUT ROWID;

-- Where the hourly scan stopped: the newest batch id it read. It reads only newer ones, by the
-- primary key, so its cost is the hour's batches and not the table.
CREATE TABLE IF NOT EXISTS alert_cursor (
  name     TEXT    NOT NULL PRIMARY KEY,
  batch_id INTEGER NOT NULL
) WITHOUT ROWID;
