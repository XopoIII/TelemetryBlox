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
 * Deletes are rows written too, and every statement is one of the 50 queries an invocation may
 * make on the free plan, so both loops are bounded by QUERY_BUDGET.
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
/** How far before its day a day's batch may be received: a server's clock running ahead. */
const CLOCK_SLACK_SECONDS = 3600;

/** Seconds of a day in one slice of the fallback roll-up: a day too big for one statement. */
export const SLICE_SECONDS = 6 * 3600;

/** A finished day rolled up in one statement: exact, and only when the day fits in memory. */
const EXACT_DAY = `WITH x AS MATERIALIZED (
	SELECT date(json_extract(e.value,'$.t'),'unixepoch') AS day,
	       json_extract(e.value,'$.event') AS event, b.env AS env, b.universe_id AS universe_id,
	       json_extract(e.value,'$.actor') AS actor, COUNT(*) AS n
	FROM batches b, json_each(b.events) e
	WHERE b.received_at >= ?1 - ${CLOCK_SLACK_SECONDS} AND b.received_at < ?2 + ${CLOCK_SLACK_SECONDS} + ${2 * DAY_SECONDS}
	  AND json_extract(e.value,'$.t') >= ?1 AND json_extract(e.value,'$.t') < ?2
	GROUP BY day, event, env, universe_id, actor
)
INSERT OR REPLACE INTO events_daily (day, event, env, universe_id, events, actors)
SELECT day, event, env, universe_id, SUM(n), COUNT(actor) FROM x GROUP BY day, event, env, universe_id
UNION ALL
SELECT day, '*', env, universe_id, SUM(n), COUNT(DISTINCT actor) FROM x GROUP BY day, env, universe_id`;

/** One slice of a day: its events counted, its players left unknown. */
const SLICE = `INSERT INTO events_daily (day, event, env, universe_id, events, actors)
SELECT date(json_extract(e.value,'$.t'),'unixepoch') AS day,
	       json_extract(e.value,'$.event') AS event, b.env AS env, b.universe_id AS universe_id,
	       COUNT(*) AS events, NULL
	FROM batches b, json_each(b.events) e
	WHERE b.received_at >= ?1 - ${CLOCK_SLACK_SECONDS} AND b.received_at < ?2 + ${CLOCK_SLACK_SECONDS} + ${2 * DAY_SECONDS}
	  AND json_extract(e.value,'$.t') >= ?1 AND json_extract(e.value,'$.t') < ?2
	GROUP BY day, event, env, universe_id
	ON CONFLICT(day, event, env, universe_id) DO UPDATE SET events = events + excluded.events`;

/** The '*' row of a sliced day: the day's events summed from its own per-event rows. */
const STAR = `INSERT OR REPLACE INTO events_daily (day, event, env, universe_id, events, actors)
SELECT day, '*', env, universe_id, SUM(events), NULL FROM events_daily
	WHERE day = date(?1, 'unixepoch') AND event <> '*' GROUP BY env, universe_id`;

/** A `YYYY-MM-DD` day's midnight, UTC, in seconds. */
function unixDay(day: string): number {
	return Date.parse(`${day}T00:00:00Z`) / 1000;
}

/**
 * A day rolled up in slices of `SLICE_SECONDS`: its events counted exactly, its per-event players
 * left unknown -- a day that will not fit in one statement will not fit its distinct set either --
 * and its '*' row summed from the per-event rows it wrote.
 */
async function sliceDay(
	db: D1Database,
	day: number,
	count: () => void,
	read: (res: { meta?: { rows_read?: number } }) => void,
): Promise<number> {
	let changes = 0;
	for (let from = day; from < day + DAY_SECONDS; from += SLICE_SECONDS) {
		const res = await db
			.prepare(SLICE)
			.bind(from, from + SLICE_SECONDS)
			.run();
		count();
		read(res);
		changes += res.meta?.changes ?? 0;
	}
	const star = await db.prepare(STAR).bind(day).run();
	count();
	read(star);
	changes += star.meta?.changes ?? 0;
	return changes;
}

export async function retention(config: Resolved, env: Env): Promise<Record<string, unknown>> {
	const db = database(env, config);
	let queries = 0;

	// Each event a statement expands through json_each is a row read, and D1's free plan reads five
	// million a day; past it D1 refuses the ingest too. So every event is expanded about twice a
	// night: once for who was first seen, once for the day's roll-up.
	let rowsRead = 0;
	const read = (res: { meta?: { rows_read?: number } }) => {
		rowsRead += res.meta?.rows_read ?? 0;
	};

	// 1. Who was first seen when, kept BEFORE the prune can take the rows that say so. The bare
	//    `place_version` beside MIN(t) is that oldest row's own (SQLite's rule for a lone MIN). A
	//    player already kept is ignored, so each costs one row written, once. The batches are those
	//    after the cursor, moved only once the insert has gone through, so a night that fails is read
	//    again the next. With no cursor yet (a new database, or one from before it), the window of
	//    the roll-up below and the day before it.
	const lastRolled = await db.prepare(`SELECT MAX(day) AS day FROM events_daily`).first<{ day: string | null }>();
	queries++;
	const floorDay = lastRolled?.day ?? null;
	const cursor = await db
		.prepare(`SELECT batch_id FROM alert_cursor WHERE name = 'actors'`)
		.first<{ batch_id: number }>();
	queries++;
	const newest = await db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM batches`).first<{ id: number }>();
	queries++;
	const to = newest?.id ?? 0;
	const firsts = await db
		.prepare(
			`INSERT OR IGNORE INTO actors (actor, env, universe_id, first_seen, first_version)
			 SELECT actor, env, universe_id, MIN(t), place_version
			 FROM (
			   SELECT json_extract(e.value,'$.actor') AS actor, b.env AS env, b.universe_id AS universe_id,
			          json_extract(e.value,'$.t') AS t, b.place_version AS place_version
			   FROM batches b, json_each(b.events) e
			   WHERE b.id > ?1 AND b.id <= ?2 AND b.received_at >= ?3
			 )
			 WHERE actor IS NOT NULL
			 GROUP BY actor, env, universe_id`,
		)
		.bind(cursor?.batch_id ?? 0, to, cursor ? 0 : floorDay ? unixDay(floorDay) - DAY_SECONDS : 0)
		.run();
	queries++;
	read(firsts);
	await db.prepare(`INSERT OR REPLACE INTO alert_cursor (name, batch_id) VALUES ('actors', ?1)`).bind(to).run();
	queries++;

	// 2. Roll up the finished days after the last one rolled up, ONE DAY AT A TIME: a day of a big
	//    game does not fit in one statement (2026-10-31: SQLITE_NOMEM over 1.9 million events, 3.9
	//    million rows read). A day that will not go in one goes in slices of `SLICE_SECONDS`, its
	//    events exact and its per-event players left unknown -- a number nobody has is better than a
	//    number that is wrong. Batches are narrowed by `received_at` before json_each expands them.
	const rolledFrom = floorDay ? unixDay(floorDay) + DAY_SECONDS : 0;
	const now = Math.floor(Date.now() / 1000);
	const lastDay = now - (now % DAY_SECONDS) - DAY_SECONDS;
	// Which days the batches hold, in one pass: a day with no row is not walked over at all.
	const found = await db
		.prepare(
			`SELECT DISTINCT date(json_extract(e.value,'$.t'),'unixepoch') AS day
			 FROM batches b, json_each(b.events) e
			 WHERE b.received_at >= ?1 - ${CLOCK_SLACK_SECONDS}
			 GROUP BY day ORDER BY day`,
		)
		.bind(rolledFrom > 0 ? rolledFrom - DAY_SECONDS : 0)
		.all<{ day: string | null }>();
	queries++;
	read(found);
	let rolled = 0;
	const sliced: string[] = [];
	for (const row of found.results ?? []) {
		if (!row.day) continue;
		const day = unixDay(row.day);
		if (day < rolledFrom || day > lastDay || queries >= QUERY_BUDGET - 8) continue;
		try {
			const one = await db
				.prepare(EXACT_DAY)
				.bind(day, day + DAY_SECONDS)
				.run();
			queries++;
			read(one);
			rolled += one.meta?.changes ?? 0;
		} catch {
			const cut = await sliceDay(
				db,
				day,
				() => {
					queries++;
				},
				read,
			);
			rolled += cut;
			sliced.push(row.day);
		}
	}

	// 2. Past the age window, oldest first, in chunks.
	let deleted = 0;
	while (queries < QUERY_BUDGET) {
		const res = await db
			.prepare(
				`DELETE FROM batches WHERE id IN (
				   SELECT id FROM batches WHERE received_at < unixepoch('now', ?1) ORDER BY id LIMIT ?2
				 )`,
			)
			.bind(`-${config.retentionDays} days`, PRUNE_CHUNK)
			.run();
		queries++;
		read(res);
		const n = res.meta?.changes ?? 0;
		deleted += n;
		if (n < PRUNE_CHUNK) break;
	}

	// 3. Past the size budget.
	const wall = await sizeWall(config, db, queries);
	queries = wall.queries;
	deleted += wall.overBudgetBatches;

	const report = {
		message: "retention",
		rolledUp: rolled,
		rolledFrom: rolledFrom ? new Date(rolledFrom * 1000).toISOString().slice(0, 10) : "1970-01-01",
		sliced,
		newActors: firsts.meta?.changes ?? 0,
		deletedBatches: deleted,
		overBudgetBatches: wall.overBudgetBatches,
		rawEvents: wall.rawEvents,
		// Counted after the age prune, so only the size prune is still to come off.
		rawBatches: wall.rawBatches,
		queries,
		// The rows of D1 the job's big statements read, as D1 reports them.
		rowsRead,
		warn: wall.warn,
	};
	console.log(JSON.stringify(report));
	// The read budget is the one wall a growing game meets with no warning: said the night it nears.
	if (rowsRead > config.nightlyReadWarn) {
		await send(
			config,
			env,
			`${config.marks.warning} ${config.game}: the nightly job read ${rowsRead} rows of D1 (warned past ${config.nightlyReadWarn})`,
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
 * slack (the roll-up has counted them). With no day rolled up yet nothing is old enough.
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
			`SELECT (SELECT MAX(day) FROM events_daily) AS day,
			        (SELECT batch_id FROM alert_cursor WHERE name = 'actors') AS cursor`,
		)
		.first<{ day: string | null; cursor: number | null }>();
	queries++;
	const before = done?.day ? unixDay(done.day) + DAY_SECONDS - CLOCK_SLACK_SECONDS : 0;
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
 * reads a row a stored batch.
 */
export async function hourlyWall(config: Resolved, env: Env): Promise<Wall> {
	const wall = await sizeWall(config, database(env, config), 0);
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
