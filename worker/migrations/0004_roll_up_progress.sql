-- THE ROLL-UP'S PROGRESS, AND A DAY'S SLICES IN FLIGHT.
--
-- The nightly roll-up used to find its work by expanding every batch kept, which on a database
-- that had not rolled up for days was the whole backlog: the query that found the days read every
-- event, and the job died of it (2026-11-02: 10,737,537 raw events went unrolled). It now walks
-- days forward from a cursor kept here, and a day too big for one statement is collected into
-- six-hour slices, one committed statement at a time.
--
-- 'retention_state' holds the cursor: 'rollup_day' is the midnight of the next day to roll up and
-- 'rollup_slice' the second into it the committed slices reached. A slice is committed before the
-- cursor moves past it, so an invocation killed halfway leaves its finished slices here and the
-- next one picks the day up at the next slice instead of reading everything again.
--
-- 'events_slice' rows are written with INSERT OR REPLACE, so re-running a slice replaces its own
-- rows instead of adding to them; when a day's last slice lands they are summed into
-- 'events_daily' and deleted.
CREATE TABLE IF NOT EXISTS events_slice (
  day         TEXT    NOT NULL, -- 'YYYY-MM-DD', UTC: the day this slice belongs to
  slice_from  INTEGER NOT NULL, -- the slice's first second, a unix time on that day's midnight
  event       TEXT    NOT NULL,
  env         TEXT    NOT NULL,
  universe_id TEXT    NOT NULL,
  events      INTEGER NOT NULL,
  actors      INTEGER,
  PRIMARY KEY (day, slice_from, event, env, universe_id)
);

CREATE TABLE IF NOT EXISTS retention_state (
  name  TEXT    PRIMARY KEY,
  value INTEGER NOT NULL
);
