-- IS THE DATA TRUSTWORTHY AT ALL? Read this first, before believing any other number.
-- An example: copy it into the game's own telemetry/queries/ and name the game's own drop event.
-- A dropped row does not show as a gap, it shows as a smaller count; the drop row is what makes a
-- hole read as a hole.

-- 1. Is anything arriving, and how fresh is it?
SELECT
  COUNT(*)                         AS rows_total,
  COUNT(DISTINCT actor)            AS players,
  COUNT(DISTINCT job_id)           AS servers,
  datetime(MIN(t), 'unixepoch')    AS first_row,
  datetime(MAX(t), 'unixepoch')    AS last_row,
  (unixepoch('now') - MAX(t)) / 60 AS minutes_since_last_row
FROM events
WHERE env = 'live';

-- 2. Did the pipe lose anything, and which way? The drop row carries `count` and its three parts:
-- `overflow` (a full ring evicted them: the game's volume), `send_failed` (the ingest never took
-- the batch: the plan's daily wall, or the key) and `refused` (a call the pipe could make nothing
-- of). 'telemetry_drop' below is the name the game gave its `dropEvent`.
SELECT
  date(t, 'unixepoch')                                 AS day,
  COUNT(*)                                             AS drop_rows,
  SUM(COALESCE(json_extract(ctx, '$.count'), 0))       AS rows_lost,
  SUM(COALESCE(json_extract(ctx, '$.overflow'), 0))    AS evicted,
  SUM(COALESCE(json_extract(ctx, '$.send_failed'), 0)) AS never_taken,
  SUM(COALESCE(json_extract(ctx, '$.refused'), 0))     AS refused
FROM events
WHERE env = 'live' AND event = 'telemetry_drop'
GROUP BY day
ORDER BY day DESC;

-- 3. The lag between a row being written and its batch arriving. Up to three minutes is the pipe's
-- own interval; much more means posts are being refused and retried.
SELECT
  date(t, 'unixepoch')           AS day,
  COUNT(*)                       AS rows_count,
  ROUND(AVG(received_at - t), 1) AS avg_lag_s,
  MAX(received_at - t)           AS worst_lag_s
FROM events
WHERE env = 'live'
GROUP BY day
ORDER BY day DESC;

-- 4. Which events are arriving. A name of the game's vocabulary with no rows here is a quiet
-- feature or a broken emitter.
SELECT
  event,
  COUNT(*)                      AS rows_count,
  COUNT(DISTINCT actor)         AS players,
  datetime(MAX(t), 'unixepoch') AS last_seen
FROM events
WHERE env = 'live'
GROUP BY event
ORDER BY rows_count DESC;
