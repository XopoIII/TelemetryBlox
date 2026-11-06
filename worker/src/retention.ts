/**
 * Retention, every night: roll each finished day up into `events_daily` FIRST, then prune old
 * batches, so trends outlive the raw rows.
 *
 * Two walls, whichever comes first: age (`retentionDays`) and size (`maxRawEvents`). The size wall
 * is counted in events, not bytes, because D1 will not report its page count to a Worker. An event
 * takes some 150 to 160 bytes of D1's pages, so the default of two million is roughly 300 MB.
 *
 * The size wall runs every hour as well as at night, and takes only batches every job is done
 * with: at or before the `actors` cursor, and received before the first day still to roll up. So
 * what D1 holds is `maxRawEvents` plus the day being collected, and that sum, not the option alone,
 * must fit the plan: on the free plan's 500 MB a day of more than about two million events leaves
 * no room, and the wall says so rather than take rows no roll-up has counted.
 *
 * The roll-up keeps its own cursor in `retention_state`: the next day to roll up, and how far into
 * it the six-hour slices reached. A day is collected into `events_slice` one committed slice at a
 * time, so a run D1 cuts off (a big game's day is more than a statement's memory; the free plan's
 * rows-read day runs out too) leaves every finished slice behind, and the next run picks the day up
 * at the next slice: nothing is read twice and no batch is counted twice. A day small enough for
 * one statement (at most EXACT_MAX_EVENTS events by its batches' own counts) is rolled up exactly,
 * players and all; a bigger one is sliced, its events exact and its players counted once at the
 * end if that count fits. A slice that fails is retried at half the width (six hours, three, one,
 * fifteen minutes); when even that fails the run stops and says where, rather than leaving a day
 * that looks partly rolled up and never moves again.
 *
 * A batch counts toward a day only while it arrives within `CLOCK_SLACK_SECONDS` of that day: a
 * batch's window is the day expanded by the slack on both sides. An event whose batch arrives
 * later than that is not counted by the roll-up (the pipe drops a batch it cannot post long
 * before), and the size wall keeps a batch until the roll-up has passed the last day the batch can
 * hold -- received before the cursor day less the slack. No row is pruned before the roll-up has
 * had the chance to read the day it belongs to.
 */

import { send } from "./alerts.js";
import { database, type Env, type Resolved } from "./config.js";

/**
 * Batches per delete. A batch holds up to 1000 events, so a chunk can free a lot: at 2000 a night's
 * run can prune some 70,000 batches, against the 480 a server posts in a day.
 */
export const PRUNE_CHUNK = 2000;
/** Queries this job may spend; the free plan allows 50 an invocation, and the rest are overhead. */
export const QUERY_BUDGET = 40;

const DAY_SECONDS = 86_400;
/** How far a batch's arrival may sit from its day: a server's clock ahead or behind. */
const CLOCK_SLACK_SECONDS = 3600;

/** Events at or under which a day is rolled up exactly, players and all, in one statement. */
export const EXACT_MAX_EVENTS = 500_000;

/** A day too big for one statement goes in slices: six hours, then half, a sixth, a twenty-fourth. */
export const SLICE_SECONDS = 6 * 3600;
const SLICE_WIDTHS = [SLICE_SECONDS, SLICE_SECONDS / 2, SLICE_SECONDS / 6, SLICE_SECONDS / 24];

/** Slices one run may write: each is two queries, and the rest of the budget is the pruning. */
const SLICE_CAP = 8;
/** Queries kept out of the roll-up's reach for the age prune and the size wall, whose loops need them. */
const QUERY_RESERVE = 8;

/**
 * Batches one statement of the first-seen step may expand, and the queries every run keeps for it.
 * A batch holds at most a thousand events, so this bounds the statement's work; the step once
 * expanded every batch after its cursor in one statement. On a database that had not run for days
 * that was the whole backlog -- 2026-11-06, 10.7 million events -- and D1 answered an internal
 * error, which escaped before the roll-up ever ran: no day was rolled up and nothing was kept,
 * night after night. Counting batches rather than events keeps the boundary one index scan of a
 * couple of hundred rows; a windowed sum over every batch at a time is itself a statement D1
 * refused as overloaded.
 */
const ACTOR_BATCH_CHUNK = 200;
const ACTOR_MIN_QUERIES = 8;

/** The roll-up's cursor, and what a database without one starts from. */
const STATE = `SELECT
	(SELECT MAX(day) FROM events_daily) AS rolled,
	(SELECT value FROM retention_state WHERE name = 'rollup_day') AS day,
	(SELECT value FROM retention_state WHERE name = 'rollup_slice') AS slice,
	(SELECT MIN(received_at) FROM batches) AS first`;

/**
 * How many events the day's batches say they hold, in the window the roll-up will read them in. One
 * index scan over the batches, no event expanded: it tells a day with no batch at all (0) from a
 * day small enough for the exact statement, and a day too big for it.
 */
const DAY_EVENTS = `SELECT COALESCE(SUM(n), 0) AS events FROM batches
	WHERE received_at >= ?1 - ${CLOCK_SLACK_SECONDS} AND received_at < ?2 + ${CLOCK_SLACK_SECONDS}`;

/**
 * A finished day small enough for one statement: exact, players and all. The x rows collapse the
 * day's events to one row a player and event before the sum, which is what the plan's statement
 * memory holds at EXACT_MAX_EVENTS; the '*' row takes the distinct players across them.
 */
const EXACT_DAY = `WITH x AS MATERIALIZED (
	SELECT json_extract(e.value,'$.event') AS event, b.env AS env, b.universe_id AS universe_id,
	       json_extract(e.value,'$.actor') AS actor, COUNT(*) AS n
	FROM batches b, json_each(b.events) e
	WHERE b.received_at >= ?1 - ${CLOCK_SLACK_SECONDS} AND b.received_at < ?2 + ${CLOCK_SLACK_SECONDS}
	  AND json_extract(e.value,'$.t') >= ?1 AND json_extract(e.value,'$.t') < ?2
	GROUP BY event, env, universe_id, actor
)
INSERT OR REPLACE INTO events_daily (day, event, env, universe_id, events, actors)
SELECT ?3, event, env, universe_id, SUM(n), COUNT(actor) FROM x GROUP BY event, env, universe_id
UNION ALL
SELECT ?3, '*', env, universe_id, SUM(n), COUNT(DISTINCT actor) FROM x GROUP BY env, universe_id`;

/**
 * One slice of a day, counted from the batches received while it ran: the day's rows are summed
 * from all of them when its last slice lands. INSERT OR REPLACE makes a re-run replace the slice's
 * own rows rather than add to them. The window ends at the slice's end plus the slack, not days
 * later: a batch received long after its events is a batch whose events are dropped by the pipe,
 * and reading that far forward would make a slice cost the whole backlog again.
 */
const SLICE = `INSERT OR REPLACE INTO events_slice (day, slice_from, event, env, universe_id, events, actors)
	SELECT ?3, ?1, json_extract(e.value,'$.event'), b.env, b.universe_id, COUNT(*), NULL
	FROM batches b, json_each(b.events) e
	WHERE b.received_at >= ?1 - ${CLOCK_SLACK_SECONDS} AND b.received_at < ?2 + ${CLOCK_SLACK_SECONDS}
	  AND json_extract(e.value,'$.t') >= ?1 AND json_extract(e.value,'$.t') < ?2
	GROUP BY json_extract(e.value,'$.event'), b.env, b.universe_id`;

/**
 * A sliced day's last slice landed: its per-event rows, actors left unknown (a slice's distinct
 * set is not a day's, and a day too big for one statement will not fit its distinct set either),
 * and its '*' row. Both are replaced, so a repeat of the step changes no number.
 */
const AGGREGATE = `WITH x AS (
	SELECT event, env, universe_id, SUM(events) AS events
	FROM events_slice WHERE day = ?1 GROUP BY event, env, universe_id
)
INSERT OR REPLACE INTO events_daily (day, event, env, universe_id, events, actors)
SELECT ?1, event, env, universe_id, events, NULL FROM x
UNION ALL
SELECT ?1, '*', env, universe_id, SUM(events), NULL FROM x GROUP BY env, universe_id`;

const DISCARD = `DELETE FROM events_slice WHERE day = ?1`;

/**
 * A sliced day's players, best effort: a count of distinct actors is a set, not a sum of the
 * slices, so it is read once more from the day's events when the last slice lands. One statement
 * that may not fit the plan's memory at all; if it fails the column stays empty, as it did for
 * every sliced day before this, and the day is still rolled up.
 */
const STAR_ACTORS = `UPDATE events_daily SET actors = (
	SELECT COUNT(DISTINCT json_extract(e.value,'$.actor'))
	FROM batches b, json_each(b.events) e
	WHERE b.env = events_daily.env AND b.universe_id = events_daily.universe_id
	  AND b.received_at >= ?1 - ${CLOCK_SLACK_SECONDS} AND b.received_at < ?2 + ${CLOCK_SLACK_SECONDS}
	  AND json_extract(e.value,'$.t') >= ?1 AND json_extract(e.value,'$.t') < ?2
)
WHERE day = ?3 AND event = '*'`;

/**
 * The end of the next range of batches for the first-seen step: the last of at most ?3 arrivals
 * after ?1. A read of the index alone -- no event expanded, no count walked -- so finding the
 * boundary cannot itself become the statement that will not fit.
 */
const CHUNK_END = `SELECT MAX(id) AS last FROM (
	SELECT id FROM batches WHERE id > ?1 AND id <= ?2 ORDER BY id LIMIT ?3
)`;

/** Who was first seen when, over one bounded range of batches. */
const FIRSTS = `INSERT OR IGNORE INTO actors (actor, env, universe_id, first_seen, first_version)
	SELECT actor, env, universe_id, MIN(t), place_version
	FROM (
	  SELECT json_extract(e.value,'$.actor') AS actor, b.env AS env, b.universe_id AS universe_id,
	         json_extract(e.value,'$.t') AS t, b.place_version AS place_version
	  FROM batches b, json_each(b.events) e
	  WHERE b.id > ?1 AND b.id <= ?2 AND b.received_at >= ?3
	)
	WHERE actor IS NOT NULL
	GROUP BY actor, env, universe_id`;

/** Both halves of the cursor in one write: a slice's commit and its progress land together. */
const SAVE_STATE = `INSERT OR REPLACE INTO retention_state (name, value)
	VALUES ('rollup_day', ?1), ('rollup_slice', ?2)`;

/** How far one run got, what it read, and where it stopped. */
export interface RollUp {
	/** Rows written into `events_slice` and `events_daily`: the night's work. */
	rolledUp: number;
	/** The first day the run was for, as a `YYYY-MM-DD` day. */
	rolledFrom: string;
	/** The days it finished in slices, each summed into `events_daily`. */
	sliced: string[];
	/** The days it passed over: no batch can hold an event of them. */
	skipped: string[];
	/** Where the next run starts. */
	state: { day: string; slice: number };
	queries: number;
	rowsRead: number;
	/** The slice that would not go in, even at fifteen minutes: the cursor stands before it. */
	failed?: { day: string; from: string; error: string };
	/** The first-seen step, which every run drains alongside the roll-up. */
	firsts?: Firsts;
}

/** The rows D1 says the run's big statements read, an expanded event counting once each. */
type Read = (res: { meta?: { rows_read?: number } }) => void;

interface Meter {
	queries: number;
	rowsRead: number;
}

/** A unix second as its UTC `YYYY-MM-DD` day; the epoch for a cursor that is nowhere yet. */
function isoDay(seconds: number): string {
	return seconds > 0 ? new Date(seconds * 1000).toISOString().slice(0, 10) : "1970-01-01";
}

/** A `YYYY-MM-DD` day's midnight, UTC, in seconds. */
function unixDay(day: string): number {
	return Date.parse(`${day}T00:00:00Z`) / 1000;
}

/**
 * The day a database without a cursor starts at: after the last day rolled up, and -- with none
 * ever rolled up -- the earliest day its oldest batch can still hold events for, its own day at
 * most a day (the window) and the clock slack behind it. Never later than that, or the first day's
 * events would be skipped; never much earlier, or a fresh database walks days it has no rows for.
 */
function bootstrapDay(rolled: string | null, first: number | null, lastDay: number): number {
	const afterRolled = rolled ? unixDay(rolled) + DAY_SECONDS : 0;
	if (first === null) return afterRolled > 0 ? afterRolled : lastDay + DAY_SECONDS;
	const earliest = Math.floor((first - DAY_SECONDS - CLOCK_SLACK_SECONDS) / DAY_SECONDS) * DAY_SECONDS + DAY_SECONDS;
	return Math.max(afterRolled, earliest);
}

/**
 * Runs a statement, D1's answer or the error as a value: a day too big for the exact statement, or
 * a slice that does not fit, is a retry with the next statement, never the end of the run.
 */
async function attempt(statement: () => D1PreparedStatement): Promise<D1Result | Error> {
	try {
		return await statement().run();
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

/** The same, for a one-row read: a boundary D1 refuses is a value to retry at, not the end. */
async function firstOf<T>(statement: () => D1PreparedStatement): Promise<{ row: T | null } | Error> {
	try {
		return { row: await statement().first<T>() };
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

/**
 * The roll-up itself: walk the finished days from the cursor, exactly when a day fits in one
 * statement and six hours at a time when it does not, and finish each day into `events_daily` when
 * it is done. Returns where it stopped; the caller decides what to do with the meter.
 */
async function rollUpDays(
	db: D1Database,
	meter: Meter,
	read: Read,
	ceiling = QUERY_BUDGET - QUERY_RESERVE,
): Promise<RollUp> {
	const state = await db
		.prepare(STATE)
		.first<{ rolled: string | null; day: number | null; slice: number | null; first: number | null }>();
	meter.queries++;
	const now = Math.floor(Date.now() / 1000);
	const lastDay = now - (now % DAY_SECONDS) - DAY_SECONDS;
	const saved = state?.day ?? 0;
	const first = state?.first ?? null;
	const start = saved > 0 ? saved : bootstrapDay(state?.rolled ?? null, first, lastDay);
	let day = start;
	let slice = saved > 0 ? Math.min(Math.max(state?.slice ?? 0, 0), DAY_SECONDS) : 0;
	// The width the last slice of this day went in at: a day that needed three hours does not try
	// six again for every slice, and a failure costs one statement, not four, each run.
	let widthStep = 0;
	let slices = 0;
	let rolledUp = 0;
	const sliced: string[] = [];
	const skipped: string[] = [];
	let failed: RollUp["failed"];

	while (day <= lastDay && slices < SLICE_CAP && meter.queries < ceiling) {
		const text = isoDay(day);
		if (slice >= DAY_SECONDS) {
			if (meter.queries + 4 > ceiling) break;
			// The day's slices are all in. Aggregate, drop them, count the players once more, move
			// on: each of the four is safe to repeat, so a run cut off between them costs one of
			// them, never a number.
			const done = await attempt(() => db.prepare(AGGREGATE).bind(text));
			meter.queries++;
			if (done instanceof Error) {
				failed = { day: text, from: new Date(day * 1000).toISOString(), error: done.message };
				break;
			}
			read(done);
			rolledUp += done.meta?.changes ?? 0;
			await db.prepare(DISCARD).bind(text).run();
			meter.queries++;
			const stars = await attempt(() => db.prepare(STAR_ACTORS).bind(day, day + DAY_SECONDS, text));
			meter.queries++;
			if (!(stars instanceof Error)) read(stars);
			await db
				.prepare(SAVE_STATE)
				.bind(day + DAY_SECONDS, 0)
				.run();
			meter.queries++;
			sliced.push(text);
			day += DAY_SECONDS;
			slice = 0;
			widthStep = 0;
			continue;
		}
		if (slice === 0) {
			if (meter.queries + 1 > ceiling) break;
			// How big the day is, from the batches' own counts: 0 is a day nothing can touch, and
			// at or under EXACT_MAX_EVENTS it goes up in one statement, players and all.
			const size = await db
				.prepare(DAY_EVENTS)
				.bind(day, day + DAY_SECONDS)
				.first<{ events: number }>();
			meter.queries++;
			const events = size?.events ?? 0;
			if (events === 0) {
				// No batch can hold an event of this day: no slices, no '*' row.
				if (meter.queries + 1 > ceiling) break;
				await db
					.prepare(SAVE_STATE)
					.bind(day + DAY_SECONDS, 0)
					.run();
				meter.queries++;
				skipped.push(text);
				day += DAY_SECONDS;
				widthStep = 0;
				continue;
			}
			if (events <= EXACT_MAX_EVENTS) {
				if (meter.queries + 2 > ceiling) break;
				const exact = await attempt(() => db.prepare(EXACT_DAY).bind(day, day + DAY_SECONDS, text));
				meter.queries++;
				if (!(exact instanceof Error)) {
					read(exact);
					rolledUp += exact.meta?.changes ?? 0;
					await db
						.prepare(SAVE_STATE)
						.bind(day + DAY_SECONDS, 0)
						.run();
					meter.queries++;
					day += DAY_SECONDS;
					widthStep = 0;
					continue;
				}
				// Not in one statement after all, whatever the batches' counts said: slice it.
			}
		}
		let written = false;
		for (let step = widthStep; step < SLICE_WIDTHS.length; step++) {
			const ladder = SLICE_WIDTHS[step];
			if (ladder === undefined) break;
			const at = day + slice;
			const width = Math.min(ladder, day + DAY_SECONDS - at);
			if (meter.queries + 2 > ceiling) break;
			const result = await attempt(() => db.prepare(SLICE).bind(at, at + width, text));
			meter.queries++;
			if (result instanceof Error) {
				// The same range, at half the width: a day too big for a six-hour statement may go
				// in a three-hour one. Past fifteen minutes the run stops, the cursor standing
				// before the slice, so the next run tries again instead of skipping a hole.
				if (step + 1 < SLICE_WIDTHS.length) {
					widthStep = step + 1;
					continue;
				}
				failed = { day: text, from: new Date(at * 1000).toISOString(), error: result.message };
				break;
			}
			read(result);
			rolledUp += result.meta?.changes ?? 0;
			// The cursor moves only once the slice is committed. A run killed before that repeats
			// the slice, which REPLACE makes free; a cursor moved first could skip it for ever.
			const savedState = await attempt(() => db.prepare(SAVE_STATE).bind(day, slice + width));
			meter.queries++;
			if (savedState instanceof Error) {
				failed = { day: text, from: new Date(at * 1000).toISOString(), error: savedState.message };
				break;
			}
			slice += width;
			slices++;
			widthStep = step;
			written = true;
			break;
		}
		if (!written) break;
	}

	return {
		rolledUp,
		rolledFrom: isoDay(start),
		sliced,
		skipped,
		state: { day: isoDay(day), slice },
		queries: meter.queries,
		rowsRead: meter.rowsRead,
		...(failed ? { failed } : {}),
	};
}

/** How far the first-seen step got, and the range it would not take. */
export interface Firsts {
	/** New players kept this run. */
	newActors: number;
	/** The batch id the cursor stands at: everything at or before it is kept. */
	to: number;
	/** The range that would not go in, even one batch at a time. */
	failed?: { batch: number; error: string };
}

/**
 * Who was first seen when, kept BEFORE the prune can take the rows that say so. The bare
 * `place_version` beside MIN(t) is that oldest row's own (SQLite's rule for a lone MIN). A player
 * already kept is ignored, so each costs one row written, once. The batches go in ranges of at most
 * `chunk` arrivals, and the cursor moves past a range only once that range is in, so a run D1
 * cuts off leaves the rest to the next. With no cursor yet (a new database, or one from before it),
 * the window of the roll-up and the day before it.
 */
export async function firsts(
	db: D1Database,
	meter: Meter,
	read: Read,
	ceiling: number,
	chunk = ACTOR_BATCH_CHUNK,
): Promise<Firsts> {
	const cursor = await db
		.prepare(`SELECT batch_id FROM alert_cursor WHERE name = 'actors'`)
		.first<{ batch_id: number }>();
	meter.queries++;
	const newest = await db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM batches`).first<{ id: number }>();
	meter.queries++;
	const rolled = await db.prepare(`SELECT MAX(day) AS day FROM events_daily`).first<{ day: string | null }>();
	meter.queries++;
	const to = newest?.id ?? 0;
	const floor = cursor ? 0 : rolled?.day ? unixDay(rolled.day) - DAY_SECONDS : 0;
	let from = cursor?.batch_id ?? 0;
	let newActors = 0;
	let width = chunk;
	while (from < to && meter.queries + 2 <= ceiling) {
		// The boundary is a read of the index, and even that can be the statement D1 is too busy
		// for: it is tried as a range that may be retried, never an error that ends the run.
		const end = await firstOf<{ last: number | null }>(() => db.prepare(CHUNK_END).bind(from, to, width));
		meter.queries++;
		if (end instanceof Error) {
			if (width > 1) {
				width = Math.max(1, Math.floor(width / 5));
				continue;
			}
			return { newActors, to: from, failed: { batch: to, error: end.message } };
		}
		const last = end.row?.last ?? null;
		if (last === null) break;
		const res = await attempt(() => db.prepare(FIRSTS).bind(from, last, floor));
		meter.queries++;
		if (res instanceof Error) {
			// More than D1 will expand in one statement, or it is too busy for it: a fifth of the
			// chunk, then a fifth again, down to one batch; a run that cannot fit even that says so.
			if (width > 1) {
				width = Math.max(1, Math.floor(width / 5));
				continue;
			}
			return { newActors, to: from, failed: { batch: last, error: res.message } };
		}
		read(res);
		newActors += res.meta?.changes ?? 0;
		await db.prepare(`INSERT OR REPLACE INTO alert_cursor (name, batch_id) VALUES ('actors', ?1)`).bind(last).run();
		meter.queries++;
		from = last;
	}
	return { newActors, to: from };
}

/** The roll-up alone, as every hourly run does it: the backlog drains through the day, not only at night. */
export async function rollUp(config: Resolved, env: Env): Promise<RollUp> {
	const meter: Meter = { queries: 0, rowsRead: 0 };
	const read: Read = (res) => {
		meter.rowsRead += res.meta?.rows_read ?? 0;
	};
	const db = database(env, config);
	const report = await rollUpDays(db, meter, read, QUERY_BUDGET - QUERY_RESERVE - ACTOR_MIN_QUERIES);
	const kept = await firsts(db, meter, read, QUERY_BUDGET - QUERY_RESERVE);
	if (report.rolledUp > 0 || report.failed || kept.newActors > 0 || kept.failed)
		console.log(JSON.stringify({ message: "rollup", ...report, firsts: kept }));
	return { ...report, queries: meter.queries, firsts: kept };
}

export async function retention(config: Resolved, env: Env): Promise<Record<string, unknown>> {
	const db = database(env, config);
	const meter: Meter = { queries: 0, rowsRead: 0 };
	const read: Read = (res) => {
		meter.rowsRead += res.meta?.rows_read ?? 0;
	};

	// 1. Who was first seen when, kept BEFORE the prune can take the rows that say so: a couple of
	//    hundred batches a statement, the cursor moving past a range only once that range is in. It
	//    goes first because it is the cheap half and must not wait behind statements a D1 window
	//    saturated by the roll-up will refuse -- and because, bounded and wrapped, it can no longer
	//    take the night's roll-up with it: the one statement it was did, night after night, until
	//    2026-11-06.
	const kept = await firsts(db, meter, read, QUERY_BUDGET - QUERY_RESERVE - ACTOR_MIN_QUERIES);

	// 2. The finished days after the cursor. The same bounded roll-up the hourly runs make, so a
	//    backlog drains an hour at a time instead of waiting for a night that may not finish it.
	const rolled = await rollUpDays(db, meter, read, QUERY_BUDGET - QUERY_RESERVE);

	// 3. Past the age window, oldest first, in chunks.
	let deleted = 0;
	while (meter.queries < QUERY_BUDGET) {
		const res = await db
			.prepare(
				`DELETE FROM batches WHERE id IN (
				   SELECT id FROM batches WHERE received_at < unixepoch('now', ?1) ORDER BY id LIMIT ?2
				 )`,
			)
			.bind(`-${config.retentionDays} days`, PRUNE_CHUNK)
			.run();
		meter.queries++;
		read(res);
		const n = res.meta?.changes ?? 0;
		deleted += n;
		if (n < PRUNE_CHUNK) break;
	}

	// 4. Past the size budget.
	const wall = await sizeWall(config, db, meter.queries);
	meter.queries = wall.queries;
	deleted += wall.overBudgetBatches;

	const report = {
		message: "retention",
		rolledUp: rolled.rolledUp,
		rolledFrom: rolled.rolledFrom,
		sliced: rolled.sliced,
		skipped: rolled.skipped,
		state: rolled.state,
		...(rolled.failed ? { failed: rolled.failed } : {}),
		newActors: kept.newActors,
		actorCursor: kept.to,
		...(kept.failed ? { firstsFailed: kept.failed } : {}),
		deletedBatches: deleted,
		overBudgetBatches: wall.overBudgetBatches,
		rawEvents: wall.rawEvents,
		// Counted after the age prune, so only the size prune is still to come off.
		rawBatches: wall.rawBatches,
		queries: meter.queries,
		// The rows of D1 the job's big statements read, as D1 reports them.
		rowsRead: meter.rowsRead,
		warn: wall.warn,
	};
	console.log(JSON.stringify(report));
	// The read budget is the one wall a growing game meets with no warning: said the night it nears.
	if (meter.rowsRead > config.nightlyReadWarn) {
		await send(
			config,
			env,
			`${config.marks.warning} ${config.game}: the nightly job read ${meter.rowsRead} rows of D1 (warned past ${config.nightlyReadWarn})`,
		);
	}
	// And the size wall, once a night: past it D1 refuses the ingest.
	if (wall.warn) {
		await send(
			config,
			env,
			`${config.marks.warning} ${config.game}: ${wall.rawEvents} raw events left after the size wall, over maxRawEvents ${config.maxRawEvents} (${wall.warn})`,
		);
	}
	return report;
}

/** What the size wall did. `warn` says why events are still over budget, if they are. */
export interface Wall {
	rawEvents: number;
	rawBatches: number;
	overBudgetBatches: number;
	queries: number;
	warn: string | undefined;
}

/**
 * Past `maxRawEvents`, the oldest batches go in chunks, `id` (arrival) order, which server clocks
 * are not. Only batches every job is done with: at or before the `actors` cursor (who was first
 * seen has read them) and received before the first day still to roll up, less the servers' clock
 * slack (the roll-up has counted the last day that batch can hold). With no day rolled up yet
 * nothing is old enough.
 */
async function sizeWall(config: Resolved, db: D1Database, used: number): Promise<Wall> {
	let queries = used;
	const counted = await db
		.prepare(`SELECT COALESCE(SUM(n), 0) AS events, COUNT(*) AS batches FROM batches`)
		.first<{ events: number; batches: number }>();
	queries++;
	let rawEvents = counted?.events ?? 0;
	let rawBatches = counted?.batches ?? 0;
	let overBudgetBatches = 0;
	if (rawEvents <= config.maxRawEvents) {
		return { rawEvents, rawBatches, overBudgetBatches, queries, warn: undefined };
	}
	const done = await db
		.prepare(
			`SELECT (SELECT MAX(day) FROM events_daily) AS rolled,
			        (SELECT value FROM retention_state WHERE name = 'rollup_day') AS state,
			        (SELECT batch_id FROM alert_cursor WHERE name = 'actors') AS cursor`,
		)
		.first<{ rolled: string | null; state: number | null; cursor: number | null }>();
	queries++;
	// The roll-up's own cursor is the horizon: a batch received before it (less the slack) cannot
	// hold an event of a day still to roll up, so every day it could hold is already rolled up.
	const cursorDay =
		done?.state && done.state > 0 ? done.state : done?.rolled ? unixDay(done.rolled) + DAY_SECONDS : 0;
	const before = cursorDay > 0 ? cursorDay - CLOCK_SLACK_SECONDS : 0;
	const through = done?.cursor ?? 0;
	let exhausted = false;
	while (rawEvents > config.maxRawEvents && queries < QUERY_BUDGET) {
		const res = await db
			.prepare(
				`DELETE FROM batches WHERE id IN (
				   SELECT id FROM batches WHERE id <= ?1 AND received_at < ?2 ORDER BY id LIMIT ?3
				 ) RETURNING n`,
			)
			.bind(through, before, PRUNE_CHUNK)
			.all<{ n: number }>();
		queries++;
		const rows = res.results ?? [];
		overBudgetBatches += rows.length;
		rawBatches -= rows.length;
		for (const row of rows) rawEvents -= row.n;
		if (rows.length < PRUNE_CHUNK) {
			exhausted = true;
			break;
		}
	}
	let warn: string | undefined;
	if (rawEvents > config.maxRawEvents) {
		// Out of batches it may take: the day being collected is over budget by itself, so the
		// game must send fewer rows or keep them in a bigger database. Out of queries: next run.
		warn = exhausted
			? "the rows not rolled up yet are over budget by themselves"
			: "still over maxRawEvents after the query budget";
	}
	return { rawEvents, rawBatches, overBudgetBatches, queries, warn };
}

/**
 * The size wall alone, every hour: a day's rows past `maxRawEvents` go before the night, so D1
 * holds the budget plus the day being collected. When under budget it costs one statement, which
 * reads a row a stored batch. `used` is what the same invocation's roll-up has spent, so the two
 * together stay inside the plan's queries.
 */
export async function hourlyWall(config: Resolved, env: Env, used = 0): Promise<Wall> {
	const wall = await sizeWall(config, database(env, config), used);
	if (wall.overBudgetBatches > 0 || wall.warn) console.log(JSON.stringify({ message: "size_wall", ...wall }));
	return wall;
}

/**
 * How fresh the live data is: the newest live batch, its age and the place version it came from.
 * `batches` 0 and the rest null means nothing has ever arrived.
 */
export async function freshness(config: Resolved, env: Env): Promise<Record<string, unknown>> {
	const newest = await database(env, config)
		.prepare(
			`SELECT received_at, place_version, (SELECT COUNT(*) FROM batches WHERE env = 'live') AS batches
			 FROM batches WHERE env = 'live' ORDER BY id DESC LIMIT 1`,
		)
		.first<{ received_at: number; place_version: number | null; batches: number }>();
	const now = Math.floor(Date.now() / 1000);
	return {
		ok: true,
		batches: newest?.batches ?? 0,
		lastReceivedAt: newest?.received_at ?? null,
		ageSeconds: newest ? now - newest.received_at : null,
		placeVersion: newest?.place_version ?? null,
	};
}
