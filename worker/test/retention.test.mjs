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

/** The Worker's cron handler at `hour` UTC, waited for. */
async function cron(env, hour, handler) {
	const waited = [];
	await handler.scheduled({ scheduledTime: Date.UTC(2026, 9, 4, hour, 17) }, env, {
		waitUntil: (p) => waited.push(p),
	});
	await Promise.all(waited);
}

test("past the event budget the oldest batches go once rolled up, whatever their age", async () => {
	const tiny = createWorker({ ...CONFIG, maxRawEvents: 3 });
	const env = environment();
	const yesterday = TODAY - DAY;
	for (const hour of [6, 7]) {
		store(env, yesterday + hour * HOUR, [
			[yesterday + hour * HOUR, "join", "u_a"],
			[yesterday + hour * HOUR, "feed", "u_a"],
		]);
	}
	const report = (await call(env, "/retention", { handler: tiny })).body;
	// Four events against three: yesterday is rolled up first, then its batches go, here both.
	assert.equal(report.overBudgetBatches, 2);
	assert.equal(report.rawEvents, 0);
	assert.equal(report.warn, undefined);
	assert.equal(rows(env, "SELECT events FROM events_daily WHERE event = '*'")[0].events, 4);
	// The default budget leaves four events alone.
	const kept = environment();
	store(kept, yesterday + 6 * HOUR, [[yesterday + 6 * HOUR, "join", "u_a"]]);
	assert.equal((await call(kept, "/retention")).body.overBudgetBatches, 0);
});

test("the size wall never takes the day being collected, and says so once a night", async () => {
	const env = environment();
	const yesterday = TODAY - DAY;
	store(env, yesterday + 6 * HOUR, [
		[yesterday + 6 * HOUR, "join", "u_a"],
		[yesterday + 6 * HOUR, "feed", "u_a"],
	]);
	store(env, NOW - HOUR, [
		[NOW - HOUR, "join", "u_b"],
		[NOW - HOUR, "feed", "u_b"],
		[NOW - HOUR, "feed", "u_b"],
	]);
	// A budget of three: yesterday's batch goes, today's three events stay, and that is enough.
	const three = (await call(env, "/retention", { handler: createWorker({ ...CONFIG, maxRawEvents: 3 }) })).body;
	assert.equal(three.overBudgetBatches, 1);
	assert.equal(three.rawEvents, 3);
	assert.equal(three.warn, undefined);
	assert.equal(texts().length, 0);
	// A budget of two: today alone is over it, and nothing of today is taken.
	const two = (await call(env, "/retention", { handler: createWorker({ ...CONFIG, maxRawEvents: 2 }) })).body;
	assert.equal(two.overBudgetBatches, 0);
	assert.equal(two.rawEvents, 3);
	assert.equal(two.warn, "the rows not rolled up yet are over budget by themselves");
	assert.deepEqual(texts(), [
		"[warning] Example Game: 3 raw events left after the size wall, over maxRawEvents 2 (the rows not rolled up yet are over budget by themselves)",
	]);
});

test("the size wall leaves a batch who was first seen has not read", async () => {
	const tiny = createWorker({ ...CONFIG, maxRawEvents: 1 });
	const env = environment();
	const yesterday = TODAY - DAY;
	store(env, yesterday + 6 * HOUR, [
		[yesterday + 6 * HOUR, "join", "u_a"],
		[yesterday + 6 * HOUR, "feed", "u_a"],
	]);
	await call(env, "/retention", { handler: tiny });
	assert.equal(rows(env, "SELECT COUNT(*) AS n FROM batches")[0].n, 0);
	// Received yesterday but stored after the night's cursor: its player is not kept yet.
	store(env, yesterday + 9 * HOUR, [[yesterday + 9 * HOUR, "join", "u_late"]]);
	store(env, yesterday + 10 * HOUR, [[yesterday + 10 * HOUR, "join", "u_later"]]);
	await cron(env, 12, tiny);
	assert.equal(rows(env, "SELECT COUNT(*) AS n FROM batches")[0].n, 2);
});

test("an hourly run prunes past the budget what the night has rolled up", async () => {
	const tiny = createWorker({ ...CONFIG, maxRawEvents: 2 });
	const env = environment();
	const yesterday = TODAY - DAY;
	store(env, yesterday + 6 * HOUR, [[yesterday + 6 * HOUR, "join", "u_a"]]);
	await call(env, "/retention", { handler: createWorker({ ...CONFIG, maxRawEvents: 100 }) });
	// After the night, today's rows come in and the budget is passed.
	store(env, NOW - 2 * HOUR, [[NOW - 2 * HOUR, "join", "u_b"]]);
	store(env, NOW - HOUR, [[NOW - HOUR, "join", "u_c"]]);
	// Not the night's hour: the roll-up does not run, the wall does, and takes the rolled-up batch.
	// The cursor stands at the night's last batch, so today's two stay whatever the budget.
	await cron(env, 12, tiny);
	assert.deepEqual(rows(env, "SELECT n FROM batches ORDER BY id"), [{ n: 1 }, { n: 1 }]);
	assert.equal(rows(env, "SELECT COUNT(*) AS n FROM events_daily WHERE event = '*'")[0].n, 1);
});
