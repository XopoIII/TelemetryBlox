-- A day too big to roll up in one statement is rolled up in slices, and a slice's distinct players
-- are not a number anyone can have: the column was NOT NULL, so the job could only refuse the day or
-- write a zero it would be lying with. It is nullable now (2026-10-31, the free plan's statement
-- memory), and a read shows nothing rather than zero for those days.
CREATE TABLE events_daily_nullable (
  day         TEXT    NOT NULL,
  event       TEXT    NOT NULL,
  env         TEXT    NOT NULL,
  universe_id TEXT    NOT NULL,
  events      INTEGER NOT NULL,
  actors      INTEGER,
  PRIMARY KEY (day, event, env, universe_id)
);
INSERT INTO events_daily_nullable (day, event, env, universe_id, events, actors)
	SELECT day, event, env, universe_id, events, actors FROM events_daily;
DROP TABLE events_daily;
ALTER TABLE events_daily_nullable RENAME TO events_daily;
