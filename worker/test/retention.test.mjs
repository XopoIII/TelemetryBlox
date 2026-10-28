// The nightly job's reads: every event is a row read when json_each expands it, and D1's free plan
// reads five million a day, past which it refuses the ingest too. So the job expands the batches
// twice a night (who was first seen, the day's roll-up), rolls up only the days after the last one,
// and says so when a night reads more than `nightlyReadWarn`.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createWorker } from "../dist/index.js";
import { CONFIG, call, DAY, environment, NOW, recordTelegram, rows, texts } from "./helpers.mjs";

const HOUR = 3600;
const TODAY = Math.floor(NOW / DAY) * DAY;
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);

beforeEach(() => recordTelegram());

/** One stored batch, received at `received`, of `events` given as [t, event, actor]. */
function store(env, received, events) {
	env.DB.raw
		.prepare(
			`INSERT INTO batches (received_at, env, schema_version, universe_id, place_id, place_version, job_id,
			 server_start, first_seq, last_seq, n, events) VALUES (?, 'live', 1, 'u1', 'p1', 7, ?, 1, 1, ?, ?, ?)`,
		)
		.run(
			received,
			`job-${received}`,
			events.length,
			events.length,
			JSON.stringify(events.map(([t, event, actor], index) => ({ seq: index + 1, t, event, actor, ctx: {} }))),
		);
}

/** A day already rolled up, as a past night left it. */
function rolled(env, t, events) {
	env.DB.raw
		.prepare(
			"INSERT INTO events_daily (day, event, env, universe_id, events, actors) VALUES (?, '*', 'live', 'u1', ?, 1)",
		)
		.run(day(t), events);
}

/** The D1 binding with each statement that expands events reporting `perExpansion` rows read. */
function reading(env, perExpansion) {
	const db = env.DB;
	const wrap = (statement, sql) => ({
		bind: (...args) => wrap(statement.bind(...args), sql),
		first: () => statement.first(),
		all: () => statement.all(),
		run: async () => {
			const result = await statement.run();
			return { meta: { ...result.meta, rows_read: sql.includes("json_each") ? perExpansion : 0 } };
		},
	});
	return { ...env, DB: { raw: db.raw, prepare: (sql) => wrap(db.prepare(sql), sql) } };
}

test("a night rolls up the days after the last one rolled, and leaves a settled day as it was", async () => {
	const env = environment();
	const settled = TODAY - 2 * DAY;
	const yesterday = TODAY - DAY;
	rolled(env, settled, 1);
	store(env, settled + 12 * HOUR, [[settled + 12 * HOUR, "join", "u_a"]]);
	// A straggler of the settled day, received after its night: not counted into it again.
	store(env, yesterday + 4 * HOUR, [[settled + 23 * HOUR, "join", "u_b"]]);
	store(env, yesterday + 6 * HOUR, [
		[yesterday + 6 * HOUR, "join", "u_c"],
		[yesterday + 7 * HOUR, "feed", "u_c"],
		[yesterday + 8 * HOUR, "world_build", null],
	]);
	const report = (await call(env, "/retention")).body;
	assert.equal(report.rolledFrom, day(yesterday));
	assert.deepEqual(rows(env, "SELECT day, event, events, actors FROM events_daily ORDER BY day, event"), [
		{ day: day(settled), event: "*", events: 1, actors: 1 },
		{ day: day(yesterday), event: "*", events: 3, actors: 1 },
		{ day: day(yesterday), event: "feed", events: 1, actors: 1 },
		{ day: day(yesterday), event: "join", events: 1, actors: 1 },
		{ day: day(yesterday), event: "world_build", events: 1, actors: 0 },
	]);
	// The next run the same night finds no finished day left.
	assert.equal((await call(env, "/retention")).body.rolledUp, 0);
});

test("with no cursor yet, who was first seen is read from the roll-up's window and the day before it", async () => {
	const env = environment();
	const settled = TODAY - 2 * DAY;
	rolled(env, settled, 1);
	// Received on the settled day, before the roll-up's window: kept all the same.
	store(env, settled + 6 * HOUR, [[settled + 6 * HOUR, "join", "u_early"]]);
	// Before the day before: not read.
	store(env, settled - 2 * DAY, [[settled - 2 * DAY, "join", "u_old"]]);
	await call(env, "/retention");
	assert.deepEqual(rows(env, "SELECT actor, first_seen FROM actors ORDER BY actor"), [
		{ actor: "u_early", first_seen: settled + 6 * HOUR },
	]);
});

test("after the cursor, who was first seen is read from the batches since the last night only", async () => {
	const env = environment();
	store(env, NOW - 3 * HOUR, [[NOW - 3 * HOUR, "join", "u_a"]]);
	await call(env, "/retention");
	assert.deepEqual(rows(env, "SELECT actor FROM actors"), [{ actor: "u_a" }]);
	// The kept rows gone: the batch already read is not read again.
	env.DB.raw.exec("DELETE FROM actors");
	store(env, NOW - HOUR, [[NOW - HOUR, "join", "u_b"]]);
	assert.equal((await call(env, "/retention")).body.newActors, 1);
	assert.deepEqual(rows(env, "SELECT actor FROM actors"), [{ actor: "u_b" }]);
});

test("a night expands the batches twice, and warns past nightlyReadWarn", async () => {
	const quiet = reading(environment(), 1000);
	store(quiet, NOW - DAY, [[NOW - DAY, "join", "u_a"]]);
	const report = (await call(quiet, "/retention")).body;
	assert.equal(report.rowsRead, 2000);
	assert.equal(texts().length, 0);

	const handler = createWorker({ ...CONFIG, nightlyReadWarn: 1500 });
	const loud = reading(environment(), 1000);
	store(loud, NOW - DAY, [[NOW - DAY, "join", "u_a"]]);
	await call(loud, "/retention", { handler });
	assert.deepEqual(texts(), ["[warning] Example Game: the nightly job read 2000 rows of D1 (warned past 1500)"]);
});
