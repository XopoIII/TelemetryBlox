-- THE DAYS, from the roll-up the nightly job keeps after the raw rows are pruned.
-- An example: copy it into the game's own telemetry/queries/.

-- 1. Players and rows a day. The row with event '*' is the whole day, and its `actors` is the
-- day's distinct players; no sum over the per-event rows gives that.
SELECT day, actors AS players, events AS rows_count
FROM events_daily
WHERE env = 'live' AND event = '*'
ORDER BY day DESC
LIMIT 60;

-- 2. Each event a day, and how many players wrote it.
SELECT day, event, events AS rows_count, actors AS players
FROM events_daily
WHERE env = 'live' AND event <> '*'
ORDER BY day DESC, rows_count DESC, event;

-- 3. New players a day, and the place version they first met. `first_seen` is the kept moment: a
-- player's oldest raw row moves forward as the pruning takes the rows before it.
SELECT
  date(s.t0, 'unixepoch') AS day,
  COUNT(*)                AS new_players,
  MIN(a.first_version)    AS oldest_version,
  MAX(a.first_version)    AS newest_version
FROM first_seen s
LEFT JOIN actors a ON a.actor = s.actor AND a.env = s.env
WHERE s.env = 'live'
GROUP BY day
ORDER BY day DESC;
