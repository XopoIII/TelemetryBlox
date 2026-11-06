// The nightly job's reads: every event is a row read when json_each expands it, and D1's free plan
// reads five million a day, past which it refuses the ingest too. So the job expands the batches
// twice a night (who was first seen, the day's roll-up), rolls up only the days after the last one,
// and says so when a night reads more than `nightlyReadWarn`.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createWorker } from "../dist/index.js";
import { EXACT_MAX_EVENTS, firsts } from "../dist/retention.js";
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

/**
 * A batch whose own count says its day is over the exact statement's limit, so the day is sliced.
 * Its events are empty: the slices count what the real batches hold.
 */
function bulk(env, received, n = EXACT_MAX_EVENTS + 1) {
	env.DB.raw
		.prepare(
			`INSERT INTO batches (received_at, env, schema_version, universe_id, place_id, place_version, job_id,
			 server_start, first_seq, last_seq, n, events) VALUES (?, 'live', 1, 'u1', 'p1', 7, ?, 1, 1, 1, ?, '[]')`,
		)
		.run(received, `job-bulk-${received}`, n);
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
	// Noon yesterday: a batch received just after midnight can hold the day before as well, and the
	// night would then read two days of statements instead of one.
	store(quiet, TODAY - 12 * HOUR, [[TODAY - 12 * HOUR, "join", "u_a"]]);
	const report = (await call(quiet, "/retention")).body;
	assert.equal(report.rowsRead, 2000);
	assert.equal(texts().length, 0);

	const handler = createWorker({ ...CONFIG, nightlyReadWarn: 1500 });
	const loud = reading(environment(), 1000);
	store(loud, TODAY - 12 * HOUR, [[TODAY - 12 * HOUR, "join", "u_a"]]);
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

test("a roll-up whose first read D1 refuses answers 200 and says where it stopped", async () => {
	const env = environment();
	const yesterday = TODAY - DAY;
	store(env, yesterday + 6 * HOUR, [[yesterday + 6 * HOUR, "join", "u_a"]]);
	// The run's opening read, and no other, is what the busy database refuses.
	const db = env.DB;
	env.DB = {
		...db,
		prepare: (sql) =>
			sql.includes("retention_state WHERE name = 'rollup_day'")
				? {
						first: async () => {
							throw new Error("D1_ERROR: D1 DB is overloaded");
						},
						bind: () => env.DB,
					}
				: db.prepare(sql),
	};
	const answered = await call(env, "/retention", { handler: createWorker(CONFIG) });
	assert.equal(answered.status, 200);
	assert.equal(answered.body.failed.error, "D1_ERROR: D1 DB is overloaded");
	assert.equal(answered.body.rolledUp, 0);
});

test("a day's rows D1 refuses to drop leave the cursor before them", async () => {
	const env = environment();
	const yesterday = TODAY - DAY;
	// A day over the exact statement's limit, so it goes in slices and reaches its discard.
	bulk(env, yesterday + 6 * HOUR);
	store(env, yesterday + 6 * HOUR, [[yesterday + 6 * HOUR, "join", "u_a"]]);
	// The discard alone is refused: the day is aggregated, its rows stay, and the cursor must not
	// pass them, or the next run would count a day whose rows are gone as done.
	const db = env.DB;
	env.DB = {
		...db,
		prepare: (sql) =>
			sql.startsWith("DELETE FROM events_slice")
				? {
						bind: () => ({
							run: async () => {
								throw new Error("D1_ERROR: D1 DB is overloaded");
							},
						}),
					}
				: db.prepare(sql),
	};
	const answered = await call(env, "/retention", { handler: createWorker(CONFIG) });
	assert.equal(answered.status, 200);
	assert.equal(answered.body.failed.error, "D1_ERROR: D1 DB is overloaded");
	// Its slices are all in, and it stays open: the next run aggregates the day again and drops it.
	assert.equal(Number(rows(env, "SELECT value FROM retention_state WHERE name = 'rollup_slice'")[0].value), DAY);
	assert.ok(
		Number(rows(env, "SELECT value FROM retention_state WHERE name = 'rollup_day'")[0].value) < yesterday + DAY,
	);
});

test("a size wall over budget is said once in six hours, not on every call", async () => {
	const env = environment();
	store(env, NOW - HOUR, [
		[NOW - HOUR, "join", "u_b"],
		[NOW - HOUR, "feed", "u_b"],
		[NOW - HOUR, "feed", "u_b"],
	]);
	const tiny = createWorker({ ...CONFIG, maxRawEvents: 2 });
	// Three runs inside one window say it once: a catch-up calls the job every twenty seconds.
	for (let run = 0; run < 3; run++) {
		const answered = (await call(env, "/retention", { handler: tiny })).body;
		assert.equal(answered.warn, "the rows not rolled up yet are over budget by themselves");
	}
	assert.equal(texts().length, 1);
	// Six hours later it is said again: a wall that stays over budget is not a solved one.
	env.DB.raw
		.prepare("INSERT OR REPLACE INTO retention_state (name, value) VALUES ('wall_warn', ?1)")
		.run(`the rows not rolled up yet are over budget by themselves|${Math.floor(NOW / 1000) - 6 * HOUR}`);
	await call(env, "/retention", { handler: tiny });
	assert.equal(texts().length, 2);
});

test("a day that will not go in one statement is rolled up in slices, its per-event players left unknown", async () => {
	const env = environment();
	const yesterday = TODAY - DAY + HOUR;
	store(env, yesterday, [
		[yesterday, "feed", "u_a"],
		[yesterday, "feed", "u_b"],
	]);
	// A day of millions answers SQLITE_NOMEM on the one statement, as the live one did on 2026-10-31.
	const base = env.DB;
	const broken = {
		...env,
		DB: {
			raw: base.raw,
			prepare: (sql) => {
				if (sql.includes("MATERIALIZED")) throw new Error("D1_ERROR: out of memory: SQLITE_NOMEM");
				return base.prepare(sql);
			},
		},
	};
	const report = (await call(broken, "/retention")).body;
	assert.deepEqual(report.sliced, [day(yesterday)]);
	const kept = rows(
		env,
		`SELECT event, events, actors FROM events_daily WHERE day = '${day(yesterday)}' ORDER BY event`,
	).map((r) => ({ ...r }));
	assert.deepEqual(kept, [
		// The day's players are counted once more when its last slice lands; the per-event rows stay
		// unknown, as a slice's distinct set is not a day's.
		{ event: "*", events: 2, actors: 2 },
		{ event: "feed", events: 2, actors: null },
	]);
});

test("the size wall takes a batch only after its player is kept", async () => {
	const tiny = createWorker({ ...CONFIG, maxRawEvents: 1 });
	const env = environment();
	const yesterday = TODAY - DAY;
	store(env, yesterday + 6 * HOUR, [
		[yesterday + 6 * HOUR, "join", "u_a"],
		[yesterday + 6 * HOUR, "feed", "u_a"],
	]);
	await call(env, "/retention", { handler: tiny });
	assert.equal(rows(env, "SELECT COUNT(*) AS n FROM batches")[0].n, 0);
	// Rows that arrive after the night's cursor: the next run reads them before the wall may take
	// them, so their players survive the pruning that follows.
	store(env, yesterday + 9 * HOUR, [[yesterday + 9 * HOUR, "join", "u_late"]]);
	store(env, yesterday + 10 * HOUR, [[yesterday + 10 * HOUR, "join", "u_later"]]);
	await cron(env, 12, tiny);
	assert.equal(rows(env, "SELECT COUNT(*) AS n FROM batches")[0].n, 0);
	assert.deepEqual(rows(env, "SELECT actor FROM actors ORDER BY actor"), [
		{ actor: "u_a" },
		{ actor: "u_late" },
		{ actor: "u_later" },
	]);
});

test("the first-seen step takes the backlog a range of batches at a time", async () => {
	const env = environment();
	const yesterday = TODAY - DAY;
	store(env, yesterday + 2 * HOUR, [[yesterday + 2 * HOUR, "join", "u_a"]]);
	store(env, yesterday + 3 * HOUR, [[yesterday + 3 * HOUR, "join", "u_b"]]);
	store(env, yesterday + 4 * HOUR, [[yesterday + 4 * HOUR, "join", "u_c"]]);
	// A chunk of one event, so each range is one batch: the backlog goes in a statement a batch,
	// not one statement over every batch there is. The cursor says how far each one got.
	const base = env.DB;
	let statements = 0;
	const counted = {
		...env,
		DB: {
			raw: base.raw,
			prepare: (sql) => {
				if (sql.includes("INTO actors")) statements++;
				return base.prepare(sql);
			},
		},
	};
	const meter = { queries: 0, rowsRead: 0 };
	const read = (res) => {
		meter.rowsRead += res.meta?.rows_read ?? 0;
	};
	const kept = await firsts(counted.DB, meter, read, 40, 1);
	assert.deepEqual(kept, { newActors: 3, to: 3 });
	assert.equal(statements, 3);
	assert.deepEqual(rows(env, "SELECT actor FROM actors ORDER BY actor"), [
		{ actor: "u_a" },
		{ actor: "u_b" },
		{ actor: "u_c" },
	]);
	// Past the cursor there is nothing left to read.
	assert.deepEqual(await firsts(env.DB, meter, read, 40, 1), { newActors: 0, to: 3 });
});

test("a first-seen step that will not fit says so and leaves the roll-up done", async () => {
	const env = environment();
	const yesterday = TODAY - DAY;
	store(env, yesterday + 2 * HOUR, [[yesterday + 2 * HOUR, "feed", "u_a"]]);
	// D1 refuses every statement that would expand events into players, as it did for days.
	const base = env.DB;
	let refusals = 0;
	const refusing = {
		...env,
		DB: {
			raw: base.raw,
			prepare: (sql) => {
				const statement = base.prepare(sql);
				if (!sql.includes("INTO actors")) return statement;
				return {
					bind: () => ({
						run: async () => {
							refusals++;
							throw new Error("D1_ERROR: D1 DB is overloaded");
						},
					}),
				};
			},
		},
	};
	const body = (await call(refusing, "/retention")).body;
	// Four widths tried: two hundred batches, a fifth of that each time, down to one.
	assert.equal(refusals, 4);
	assert.equal(body.newActors, 0);
	assert.deepEqual(body.firstsFailed, { batch: 1, error: "D1_ERROR: D1 DB is overloaded" });
	// The night's work stands: the roll-up is not lost with the step that could not run.
	assert.deepEqual(rows(env, "SELECT event, events, actors FROM events_daily ORDER BY event"), [
		{ event: "*", events: 1, actors: 1 },
		{ event: "feed", events: 1, actors: 1 },
	]);
});

test("an hourly run prunes past the budget what the night has rolled up", async () => {
	const tiny = createWorker({ ...CONFIG, maxRawEvents: 2 });
	const env = environment();
	const yesterday = TODAY - DAY;
	store(env, yesterday + 6 * HOUR, [[yesterday + 6 * HOUR, "join", "u_a"]]);
	await call(env, "/retention", { handler: createWorker({ ...CONFIG, maxRawEvents: 100 }) });
	// After the night, today's rows come in and the budget is passed. They are placed INSIDE today:
	// the wall keeps the day being collected, and an hour before midnight is still an hour back.
	const today = Math.floor(NOW / DAY) * DAY;
	store(env, today + 2 * HOUR, [[today + 2 * HOUR, "join", "u_b"]]);
	store(env, today + 3 * HOUR, [[today + 3 * HOUR, "join", "u_c"]]);
	// Not the night's hour: the roll-up does not run, the wall does, and takes the rolled-up batch.
	// The first-seen step keeps up in the same run, so the wall may take it; today's two it may not.
	await cron(env, 12, tiny);
	assert.deepEqual(rows(env, "SELECT n FROM batches ORDER BY id"), [{ n: 1 }, { n: 1 }]);
	assert.equal(rows(env, "SELECT COUNT(*) AS n FROM events_daily WHERE event = '*'")[0].n, 1);
});

test("a night cut off inside a day resumes at the next slice without counting anything twice", async () => {
	const env = environment();
	const yesterday = TODAY - DAY;
	store(env, yesterday + 2 * HOUR, [[yesterday + 2 * HOUR, "feed", "u_a"]]);
	store(env, yesterday + 8 * HOUR, [[yesterday + 8 * HOUR, "join", "u_b"]]);
	// The day's own count says it is too big for one statement: six-hour slices it is.
	bulk(env, yesterday + 3 * HOUR);
	// D1 refuses the six-hour statement of the second slice: the run must stop with the cursor
	// before it, not walk over a hole, and it must not try a smaller width in the same spent
	// ten-second window -- the next run starts narrower instead.
	const base = env.DB;
	let failures = 0;
	const flaky = {
		...env,
		DB: {
			raw: base.raw,
			prepare: (sql) => {
				const statement = base.prepare(sql);
				if (!sql.includes("INTO events_slice")) return statement;
				return {
					bind: (...args) =>
						args[0] === yesterday + 6 * HOUR && failures < 4
							? {
									run: async () => {
										failures++;
										throw new Error("D1_ERROR: D1 DB is overloaded");
									},
								}
							: statement.bind(...args),
				};
			},
		},
	};
	const cut = (await call(flaky, "/retention")).body;
	assert.ok(cut.failed, "the run says where it stopped");
	assert.equal(cut.failed.day, day(yesterday));
	assert.equal(cut.failed.from, new Date((yesterday + 6 * HOUR) * 1000).toISOString());
	assert.deepEqual(cut.state, { day: day(yesterday), slice: 6 * HOUR });
	assert.deepEqual(cut.sliced, []);
	// One statement, one refusal: the widths below six hours are not tried against a spent window.
	assert.equal(failures, 1, "a refused slice is not retried in the same window");
	// And the narrower width is kept for the next run.
	assert.deepEqual(rows(env, "SELECT value FROM retention_state WHERE name = 'rollup_width'"), [{ value: 1 }]);
	// The first six hours are in, and committed: they are not read again.
	assert.deepEqual(rows(env, "SELECT day, slice_from, event, events FROM events_slice"), [
		{ day: day(yesterday), slice_from: yesterday, event: "feed", events: 1 },
	]);
	assert.equal(rows(env, "SELECT COUNT(*) AS n FROM events_daily")[0].n, 0);

	// The next run picks the day up at the slice the first one could not write; its slices REPLACE
	// their own rows, so nothing is counted twice.
	const again = (await call(env, "/retention")).body;
	assert.deepEqual(again.sliced, [day(yesterday)]);
	assert.equal(again.failed, undefined);
	assert.deepEqual(again.state, { day: day(TODAY), slice: 0 });
	assert.deepEqual(
		rows(env, `SELECT event, events, actors FROM events_daily WHERE day = '${day(yesterday)}' ORDER BY event`),
		[
			{ event: "*", events: 2, actors: 2 },
			{ event: "feed", events: 1, actors: null },
			{ event: "join", events: 1, actors: null },
		],
	);
	assert.equal(rows(env, "SELECT COUNT(*) AS n FROM events_slice")[0].n, 0);
	// A finished day hands the next one the widest slice again.
	assert.deepEqual(rows(env, "SELECT value FROM retention_state WHERE name = 'rollup_width'"), [{ value: 0 }]);
});

test("the narrower width is kept before the statement D1 may refuse", async () => {
	const env = environment();
	const yesterday = TODAY - DAY;
	store(env, yesterday + 2 * HOUR, [[yesterday + 2 * HOUR, "feed", "u_a"]]);
	store(env, yesterday + 8 * HOUR, [[yesterday + 8 * HOUR, "join", "u_b"]]);
	bulk(env, yesterday + 3 * HOUR);
	// Once the six-hour statement is refused, the database refuses every later write -- the window
	// is spent, as it was on 2026-11-06. The width must already be in the database by then.
	const base = env.DB;
	let refused = false;
	const spent = {
		...env,
		DB: {
			raw: base.raw,
			prepare: (sql) => {
				const statement = base.prepare(sql);
				if (sql.includes("INTO events_slice")) {
					return {
						bind: (...args) =>
							args[0] === yesterday + 6 * HOUR
								? {
										run: async () => {
											refused = true;
											throw new Error("D1_ERROR: D1 DB is overloaded");
										},
									}
								: statement.bind(...args),
					};
				}
				if (refused && sql.includes("rollup_width")) {
					return {
						bind: () => ({
							run: async () => {
								throw new Error("D1_ERROR: D1 DB is overloaded");
							},
						}),
					};
				}
				return statement;
			},
		},
	};
	const cut = (await call(spent, "/retention")).body;
	assert.ok(cut.failed, "the run says where it stopped");
	// The width was written while the window still had room, so a spent window cannot lose it.
	assert.deepEqual(rows(env, "SELECT value FROM retention_state WHERE name = 'rollup_width'"), [{ value: 1 }]);
	// And the next run, on a database that is well again, starts a step narrower and moves on.
	const again = (await call(env, "/retention")).body;
	assert.deepEqual(again.sliced, [day(yesterday)]);
	assert.equal(again.failed, undefined);
});

test("re-running a day's slices replaces its rows instead of adding to them", async () => {
	const env = environment();
	const yesterday = TODAY - DAY;
	store(env, yesterday + 2 * HOUR, [[yesterday + 2 * HOUR, "feed", "u_a"]]);
	store(env, yesterday + 8 * HOUR, [[yesterday + 8 * HOUR, "join", "u_b"]]);
	bulk(env, yesterday + 3 * HOUR);
	assert.deepEqual((await call(env, "/retention")).body.sliced, [day(yesterday)]);
	const settled = rows(env, "SELECT day, event, events, actors FROM events_daily ORDER BY event");
	// The cursor put back where the night began, as a run killed before its last state write would
	// leave it: every slice is written again over its own rows, and no number doubles.
	env.DB.raw
		.prepare("INSERT OR REPLACE INTO retention_state (name, value) VALUES ('rollup_day', ?), ('rollup_slice', 0)")
		.run(yesterday);
	await call(env, "/retention");
	assert.deepEqual(rows(env, "SELECT day, event, events, actors FROM events_daily ORDER BY event"), settled);
	assert.equal(rows(env, "SELECT COUNT(*) AS n FROM events_slice")[0].n, 0);
});

test("a day no batch can hold is skipped, and the cursor moves past it", async () => {
	const env = environment();
	const settled = TODAY - 2 * DAY;
	rolled(env, settled, 1);
	// No batch at all: nothing can hold the day between the settled one and today.
	const report = (await call(env, "/retention")).body;
	assert.deepEqual(report.skipped, [day(TODAY - DAY)]);
	assert.deepEqual(rows(env, "SELECT day, event, events FROM events_daily"), [
		{ day: day(settled), event: "*", events: 1 },
	]);
	assert.deepEqual(rows(env, "SELECT name, value FROM retention_state ORDER BY name"), [
		{ name: "rollup_day", value: TODAY },
		{ name: "rollup_slice", value: 0 },
	]);
});

test("a prune D1 is too busy for is said in the report, not thrown at the route", async () => {
	const env = environment();
	const yesterday = TODAY - DAY;
	store(env, yesterday + 6 * HOUR, [[yesterday + 6 * HOUR, "join", "u_a"]]);
	const base = env.DB;
	let refusals = 0;
	const refusing = {
		...env,
		DB: {
			raw: base.raw,
			prepare: (sql) => {
				const statement = base.prepare(sql);
				if (!sql.includes("unixepoch('now'")) return statement;
				return {
					bind: () => ({
						run: async () => {
							refusals++;
							throw new Error("D1_ERROR: D1 DB is overloaded");
						},
					}),
				};
			},
		},
	};
	const response = await call(refusing, "/retention");
	assert.equal(response.status, 200);
	assert.equal(refusals, 1);
	assert.equal(response.body.pruneFailed, "D1_ERROR: D1 DB is overloaded");
	assert.equal(response.body.deletedBatches, 0);
	// The night's work stands: a prune that did not run costs no day.
	assert.deepEqual(rows(env, "SELECT event, events FROM events_daily ORDER BY event"), [
		{ event: "*", events: 1 },
		{ event: "join", events: 1 },
	]);
});

test("a size wall's count D1 refuses is said, never read as a database under budget", async () => {
	const env = environment();
	const yesterday = TODAY - DAY;
	store(env, yesterday + 6 * HOUR, [[yesterday + 6 * HOUR, "join", "u_a"]]);
	const base = env.DB;
	const refusing = {
		...env,
		DB: {
			raw: base.raw,
			prepare: (sql) => {
				const statement = base.prepare(sql);
				if (!sql.includes("COALESCE(SUM(n), 0) AS events, COUNT(*) AS batches")) return statement;
				const refused = () => {
					throw new Error("D1_ERROR: D1 DB is overloaded");
				};
				return {
					first: async () => refused(),
					bind: () => ({ first: async () => refused(), run: async () => refused() }),
				};
			},
		},
	};
	const response = await call(refusing, "/retention");
	assert.equal(response.status, 200);
	assert.equal(response.body.wallFailed, "D1_ERROR: D1 DB is overloaded");
	assert.equal(response.body.overBudgetBatches, 0);
});
