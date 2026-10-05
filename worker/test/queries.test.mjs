// The example queries and the check a game runs its own queries through: every statement of every
// file in worker/queries runs against the schema, and says the right numbers of a small made-up
// launch ingested through the Worker itself.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkQueries, freshDatabase, MIGRATIONS, schema, statements } from "../testing/index.mjs";
import { call, DAY, envelope, environment, NOW, recordTelegram, texts } from "./helpers.mjs";

beforeEach(recordTelegram);

const QUERIES = fileURLToPath(new URL("../queries/", import.meta.url));
const TODAY = Math.floor(NOW / DAY) * DAY;

/** Every statement of an example query, run; the rows of each. */
function run(env, file) {
	return statements(readFileSync(join(QUERIES, file), "utf8")).map((sql) =>
		env.DB.raw
			.prepare(sql)
			.all()
			.map((row) => ({ ...row })),
	);
}

test("every example query runs against an empty copy of the schema", () => {
	assert.deepEqual(checkQueries(QUERIES), []);
	assert.deepEqual(checkQueries(QUERIES.slice(0, -1)), []);
});

test("a query that names what the schema does not have is found, with its file and SQLite's words", () => {
	const folder = mkdtempSync(join(tmpdir(), "telemetryblox-queries-"));
	try {
		assert.deepEqual(checkQueries(folder), [{ file: `${folder}/`, statement: "", error: "no .sql file here" }]);
		writeFileSync(
			join(folder, "good.sql"),
			"-- fine\nSELECT COUNT(*) FROM events;\nSELECT day FROM events_daily;\n",
		);
		assert.deepEqual(checkQueries(folder), []);
		writeFileSync(join(folder, "bad.sql"), "SELECT coins FROM events;\nSELECT 1 FROM purchases;\n");
		writeFileSync(join(folder, "empty.sql"), "-- nothing but a comment\n");
		assert.deepEqual(checkQueries(folder), [
			{ file: "bad.sql", statement: "SELECT coins FROM events", error: "no such column: coins" },
			{ file: "bad.sql", statement: "SELECT 1 FROM purchases", error: "no such table: purchases" },
			{ file: "empty.sql", statement: "", error: "no statement in this file" },
		]);
	} finally {
		rmSync(folder, { recursive: true });
	}
});

test("a file's statements are split at the semicolons that end a line, comments dropped", () => {
	assert.deepEqual(statements("-- a\nSELECT 1;\n\n  -- b\nSELECT ';' AS x,\n  2;\nSELECT 3"), [
		"SELECT 1",
		"SELECT ';' AS x,\n  2",
		"SELECT 3",
	]);
	assert.deepEqual(statements("-- only a comment\n"), []);
});

test("the schema is every migration in order, and can be applied twice", () => {
	assert.ok(MIGRATIONS.endsWith("/worker/migrations/"));
	const db = freshDatabase().raw;
	db.exec(schema());
	const names = db
		.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
		.all()
		.map((row) => `${row.type} ${row.name}`);
	assert.deepEqual(names, [
		"index idx_batches_identity",
		"table actors",
		"table alert_cursor",
		"table alert_state",
		"table batches",
		"table events_daily",
		"view events",
		"view first_seen",
	]);
});

test("the example queries say the right numbers of a small launch", async () => {
	const env = environment();
	const a = TODAY - 2 * DAY + 3600;
	const b = TODAY + 60;
	await call(env, "/ingest", {
		body: envelope({ jobId: "job-a", placeVersion: 46 }, [
			{ seq: 1, t: a, event: "join", actor: "u_a", ctx: {} },
			{ seq: 2, t: a + 10, event: "feed", actor: "u_a", ctx: {} },
			{ seq: 3, t: a + 20, event: "feed", actor: "u_a", ctx: {} },
			{ seq: 4, t: a + 30, event: "telemetry_drop", ctx: { count: 9, overflow: 4, send_failed: 3, refused: 2 } },
		]),
	});
	await call(env, "/ingest", {
		body: envelope({ jobId: "job-b", placeVersion: 47 }, [
			{ seq: 1, t: b, event: "join", actor: "u_a", ctx: {} },
			{ seq: 2, t: b + 5, event: "join", actor: "u_b", ctx: {} },
		]),
	});
	// A developer's own rows are in no answer.
	await call(env, "/ingest", {
		body: envelope({ jobId: "", env: "studio" }, [{ seq: 1, t: b, event: "join", actor: "u_dev", ctx: {} }]),
	});
	await call(env, "/retention");
	// The drop row is worth a warning to the example game; it went to the recorder, not the network.
	assert.equal(texts().length, 1);

	const [fresh, drops, lag, arriving] = run(env, "pipe-health.sql");
	assert.equal(fresh[0].rows_total, 6);
	assert.equal(fresh[0].players, 2);
	assert.equal(fresh[0].servers, 2);
	assert.deepEqual(drops, [
		{
			day: new Date(a * 1000).toISOString().slice(0, 10),
			drop_rows: 1,
			rows_lost: 9,
			evicted: 4,
			never_taken: 3,
			refused: 2,
		},
	]);
	assert.equal(lag.length, 2);
	assert.deepEqual(
		arriving.map((row) => [row.event, row.rows_count, row.players]),
		[
			["join", 3, 2],
			["feed", 2, 1],
			["telemetry_drop", 1, 0],
		],
	);

	const [days, perEvent, arrivals] = run(env, "daily.sql");
	// Only the finished day is rolled up: four rows, one player.
	assert.deepEqual(days, [{ day: new Date(a * 1000).toISOString().slice(0, 10), players: 1, rows_count: 4 }]);
	assert.deepEqual(
		perEvent.map((row) => [row.event, row.rows_count, row.players]),
		[
			["feed", 2, 1],
			["join", 1, 1],
			["telemetry_drop", 1, 0],
		],
	);
	assert.deepEqual(arrivals, [
		{ day: new Date(b * 1000).toISOString().slice(0, 10), new_players: 1, oldest_version: 47, newest_version: 47 },
		{ day: new Date(a * 1000).toISOString().slice(0, 10), new_players: 1, oldest_version: 46, newest_version: 46 },
	]);
});
