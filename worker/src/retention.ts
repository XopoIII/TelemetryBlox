/**
 * Retention, every night: roll each finished day up into `events_daily` FIRST, then prune old
 * batches, so trends outlive the raw rows.
 *
 * Two walls, whichever comes first: age (`retentionDays`) and size (`maxRawEvents`). The size wall
 * is counted in events, not bytes, because D1 will not report its page count to a Worker. An event
 * is about 150 bytes of JSON, so the default of two million is roughly 300 MB, inside the free
 * plan's 500 MB.
 *
 * Deletes are rows written too, and every statement is one of the 50 queries an invocation may
 * make on the free plan, so both loops are bounded by QUERY_BUDGET.
 */

import { database, type Env, type Resolved } from "./config.js";

/**
 * Batches per delete. A batch holds up to 1000 events, so a chunk can free a lot: at 2000 a night's
 * run can prune some 70,000 batches, against the 480 a server posts in a day.
 */
export const PRUNE_CHUNK = 2000;
/** Queries this job may spend; the free plan allows 50 an invocation, and the rest are overhead. */
export const QUERY_BUDGET = 40;

export async function retention(config: Resolved, env: Env): Promise<Record<string, unknown>> {
	const db = database(env, config);
	let queries = 0;

	// 1. Roll up finished days not settled yet. The floor is the last day already rolled up (redone,
	//    since it may have been partial); batches are narrowed by `received_at` BEFORE json_each
	//    expands them, so the job reads only the last few days, not the whole history.
	const lastRolled = await db.prepare(`SELECT MAX(day) AS day FROM events_daily`).first<{ day: string | null }>();
	queries++;
	const floorDay = lastRolled?.day ?? "1970-01-01";
	const rolled = await db
		.prepare(
			`INSERT OR REPLACE INTO events_daily (day, event, env, universe_id, events, actors)
			 SELECT date(json_extract(e.value,'$.t'),'unixepoch') AS day,
			        json_extract(e.value,'$.event') AS event, b.env, b.universe_id,
			        COUNT(*) AS events, COUNT(DISTINCT json_extract(e.value,'$.actor')) AS actors
			 FROM batches b, json_each(b.events) e
			 WHERE b.received_at >= unixepoch(?1, '-1 day')
			   AND json_extract(e.value,'$.t') >= unixepoch(?1)
			   AND json_extract(e.value,'$.t') < unixepoch(date('now'))
			 GROUP BY day, event, b.env, b.universe_id`,
		)
		.bind(floorDay)
		.run();
	queries++;

	// The whole day under event '*': the distinct actors across every event are the day's players,
	// which no sum over the per-event rows gives.
	await db
		.prepare(
			`INSERT OR REPLACE INTO events_daily (day, event, env, universe_id, events, actors)
			 SELECT date(json_extract(e.value,'$.t'),'unixepoch') AS day, '*', b.env, b.universe_id,
			        COUNT(*) AS events, COUNT(DISTINCT json_extract(e.value,'$.actor')) AS actors
			 FROM batches b, json_each(b.events) e
			 WHERE b.received_at >= unixepoch(?1, '-1 day')
			   AND json_extract(e.value,'$.t') >= unixepoch(?1)
			   AND json_extract(e.value,'$.t') < unixepoch(date('now'))
			 GROUP BY day, b.env, b.universe_id`,
		)
		.bind(floorDay)
		.run();
	queries++;

	// Who was first seen when, kept BEFORE the prune can take the rows that say so. The bare
	// `place_version` beside MIN(t) is that oldest row's own (SQLite's rule for a lone MIN). A
	// player already kept is ignored, so each costs one row written, once.
	const firsts = await db
		.prepare(
			`INSERT OR IGNORE INTO actors (actor, env, universe_id, first_seen, first_version)
			 SELECT actor, env, universe_id, MIN(t), place_version
			 FROM (
			   SELECT json_extract(e.value,'$.actor') AS actor, b.env AS env, b.universe_id AS universe_id,
			          json_extract(e.value,'$.t') AS t, b.place_version AS place_version
			   FROM batches b, json_each(b.events) e
			   WHERE b.received_at >= unixepoch(?1, '-1 day')
			 )
			 WHERE actor IS NOT NULL
			 GROUP BY actor, env, universe_id`,
		)
		.bind(floorDay)
		.run();
	queries++;

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
		const n = res.meta?.changes ?? 0;
		deleted += n;
		if (n < PRUNE_CHUNK) break;
	}

	// 3. Past the size budget, oldest first. `id` is arrival order, which server clocks are not.
	const counted = await db
		.prepare(`SELECT COALESCE(SUM(n), 0) AS events, COUNT(*) AS batches FROM batches`)
		.first<{ events: number; batches: number }>();
	queries++;
	let rawEvents = counted?.events ?? 0;
	let overBudget = 0;
	while (rawEvents > config.maxRawEvents && queries < QUERY_BUDGET) {
		const res = await db
			.prepare(`DELETE FROM batches WHERE id IN (SELECT id FROM batches ORDER BY id LIMIT ?1) RETURNING n`)
			.bind(PRUNE_CHUNK)
			.all<{ n: number }>();
		queries++;
		const rows = res.results ?? [];
		if (rows.length === 0) break;
		overBudget += rows.length;
		for (const row of rows) rawEvents -= row.n;
	}
	deleted += overBudget;

	const report = {
		message: "retention",
		rolledUp: rolled.meta?.changes ?? 0,
		rolledFrom: floorDay,
		newActors: firsts.meta?.changes ?? 0,
		deletedBatches: deleted,
		overBudgetBatches: overBudget,
		rawEvents,
		// Counted after the age prune, so only the size prune is still to come off.
		rawBatches: (counted?.batches ?? 0) - overBudget,
		queries,
		// Out of queries with events still over budget: the ingest rate has outgrown the plan.
		warn: rawEvents > config.maxRawEvents ? "still over maxRawEvents after the query budget" : undefined,
	};
	console.log(JSON.stringify(report));
	return report;
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
