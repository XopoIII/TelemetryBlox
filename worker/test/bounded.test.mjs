// Reads that cost the window, not the history (migration 0002): `events_day` and `events_week` hold
// the rows of the batches received in their window and no other, SQLite reaches those batches by
// the index on `received_at` before it expands a single event, and `first_seen` takes the players
// the nightly job has not kept yet from the last week alone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { freshDatabase } from "../testing/index.mjs";
import { DAY, NOW } from "./helpers.mjs";

const HOUR = 3600;

/** One stored batch, received `ago` seconds before now, of one `join` per actor. */
function store(db, ago, actors, env = "live") {
	const received = NOW - ago;
	const events = actors.map((actor, index) => ({ seq: index + 1, t: received - 60, event: "join", actor, ctx: {} }));
	db.prepare(
		`INSERT INTO batches (received_at, env, schema_version, universe_id, place_id, place_version, job_id,
		 server_start, first_seq, last_seq, n, events) VALUES (?, ?, 1, 'u1', 'p1', 7, ?, 1, 1, ?, ?, ?)`,
	).run(received, env, `job-${ago}`, events.length, events.length, JSON.stringify(events));
}

/** The actors a view holds, sorted. */
function actorsOf(db, view) {
	return db
		.prepare(`SELECT actor FROM ${view} ORDER BY actor`)
		.all()
		.map((row) => row.actor);
}

/** How SQLite plans to read `sql`, as one line. */
function plan(db, sql) {
	return db
		.prepare(`EXPLAIN QUERY PLAN ${sql}`)
		.all()
		.map((row) => row.detail)
		.join("; ");
}

test("events_day and events_week hold the batches received in their window, and no older one", () => {
	const db = freshDatabase().raw;
	store(db, 25 * HOUR, ["a_day"]);
	store(db, 27 * HOUR, ["b_week"]);
	store(db, 7 * DAY + 23 * HOUR, ["c_week"]);
	store(db, 8 * DAY + HOUR, ["d_old"]);
	assert.deepEqual(actorsOf(db, "events_day"), ["a_day"]);
	assert.deepEqual(actorsOf(db, "events_week"), ["a_day", "b_week", "c_week"]);
	assert.deepEqual(actorsOf(db, "events"), ["a_day", "b_week", "c_week", "d_old"]);
});

test("a window's batches are found by the index on received_at, not by reading them all", () => {
	const db = freshDatabase().raw;
	assert.match(plan(db, "SELECT COUNT(*) FROM events_day"), /USING INDEX idx_batches_received \(received_at>\?\)/);
	assert.match(plan(db, "SELECT COUNT(*) FROM events_week"), /USING INDEX idx_batches_received \(received_at>\?\)/);
	// the whole view still reads every batch: that is what the windows are for
	assert.doesNotMatch(plan(db, "SELECT COUNT(*) FROM events"), /idx_batches_received/);
});

test("first_seen keeps the nightly job's players and adds the last week's, not older raw rows", () => {
	const db = freshDatabase().raw;
	db.prepare(
		"INSERT INTO actors (actor, env, universe_id, first_seen, first_version) VALUES ('kept', 'live', 'u1', ?, 5)",
	).run(NOW - 40 * DAY);
	store(db, 2 * DAY, ["kept", "recent"]);
	store(db, 9 * DAY, ["unkept"]);
	const rows = db.prepare("SELECT actor, t0 FROM first_seen WHERE env = 'live' ORDER BY actor").all();
	assert.deepEqual(
		rows.map((row) => [row.actor, row.t0]),
		[
			["kept", NOW - 40 * DAY],
			["recent", NOW - 2 * DAY - 60],
		],
	);
});
