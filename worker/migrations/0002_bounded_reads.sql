-- READS THAT COST THE WINDOW, NOT THE HISTORY.
--
-- The free plan allows 5,000,000 rows READ a day, and an expanded event counts as a row read. The
-- `events` view expands every batch kept, so a query over it costs the whole history however
-- narrow its WHERE on `t`: a live game with 150,000 events kept hit the wall in a day of a few
-- dozen questions, and at the retention's two million a single query would cost close to half of
-- the day. A batch's `received_at` is the one column that can narrow the batches BEFORE their
-- events are expanded, and this index lets it.
--
-- One index costs one more row written a batch (the free plan's 100,000 writes a day): about 480
-- a server a day. It also serves the retention's pruning, which already asks by `received_at`.
CREATE INDEX IF NOT EXISTS idx_batches_received ON batches (received_at);

-- The same rows as `events`, of the batches received in the last 26 hours and the last 8 days.
-- What a question about yesterday or last week reads. A batch arrives within minutes of its rows
-- (longer only while posts are refused), so the extra hours of each window keep the rows written
-- at its start; a query that wants an exact window still says `t >= ...`.
CREATE VIEW IF NOT EXISTS events_day AS
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
FROM batches b, json_each(b.events) e
WHERE b.received_at >= unixepoch('now', '-26 hours');

CREATE VIEW IF NOT EXISTS events_week AS
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
FROM batches b, json_each(b.events) e
WHERE b.received_at >= unixepoch('now', '-8 days');

-- FIRST SEEN, read from the last week's batches instead of all of them. The nightly job keeps every
-- player it has seen in `actors` before it prunes, reading the batches since the day before the
-- last day it rolled up; so a player missing from `actors` arrived since the last nightly run, and
-- the last week holds them while that job runs at all. A database whose nightly job has not run
-- for a week sees the players of the batches older than that only once it runs again.
DROP VIEW IF EXISTS first_seen;
CREATE VIEW IF NOT EXISTS first_seen AS
SELECT actor, env, MIN(t0) AS t0
FROM (
  SELECT actor, env, first_seen AS t0 FROM actors
  UNION ALL
  SELECT actor, env, MIN(t) AS t0 FROM events_week WHERE actor IS NOT NULL GROUP BY actor, env
)
GROUP BY actor, env;
