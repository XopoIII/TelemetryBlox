// The local copy: a pull reads only the batches the copy lacks, keeps what the remote has pruned,
// answers a query as the remote does, and reads wrangler's answers and refusals. The remote is a
// second SQLite database with the kit's schema, which is what D1 is; the end-to-end case runs the
// bin over a stand-in for wrangler that answers from such a database.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openMirror, parseWrangler, pull } from "../mirror/index.mjs";
import { freshDatabase, schema } from "../testing/index.mjs";
import { NOW, recordTelegram } from "./helpers.mjs";

recordTelegram();

const BIN = fileURLToPath(new URL("../bin/mirror.mjs", import.meta.url));

/** Adds `count` batches of two events each to `db`, received an hour apart up to now. */
function fill(db, count, from = 1) {
	const insert = db.prepare(
		`INSERT INTO batches (received_at, env, schema_version, universe_id, place_id, place_version, job_id,
		 server_start, first_seq, last_seq, n, events) VALUES (?, 'live', 1, '1', '2', 7, 'job', 5, ?, ?, 2, ?)`,
	);
	for (let i = from; i < from + count; i += 1) {
		const events = [
			{ seq: i * 2 - 1, t: NOW - i * 60, event: "join", actor: `u_${i}`, ctx: {} },
			{ seq: i * 2, t: NOW - i * 60, event: "feed", actor: `u_${i}`, ctx: { food: i % 3 } },
		];
		insert.run(NOW - (from + count - i) * 3600, i * 2 - 1, i * 2, JSON.stringify(events));
	}
}

/** A remote over a SQLite database, counting what it is asked and the rows it returns. */
function remoteOver(db) {
	const asked = [];
	const remote = (sql) => {
		asked.push(sql);
		const rows = db.prepare(sql).all();
		return { rows, read: rows.length };
	};
	return { remote, asked };
}

const count = (db, sql) => Number(db.prepare(sql).get().n);

test("a first pull copies every batch page by page, and the next reads only what is new", () => {
	const d1 = freshDatabase().raw;
	fill(d1, 450);
	d1.prepare("INSERT INTO actors VALUES ('u_1', 'live', '1', 100, 7)").run();
	const copy = openMirror(":memory:");
	const { remote, asked } = remoteOver(d1);

	assert.deepEqual(pull(copy, remote), { batches: 450, read: 451, queries: 5, newest: NOW - 3600 });
	assert.deepEqual(asked.slice(0, 3), [
		"SELECT * FROM batches WHERE id > 0 ORDER BY id LIMIT 200",
		"SELECT * FROM batches WHERE id > 200 ORDER BY id LIMIT 200",
		"SELECT * FROM batches WHERE id > 400 ORDER BY id LIMIT 200",
	]);
	assert.equal(count(copy, "SELECT COUNT(*) AS n FROM events"), 900);
	assert.equal(count(copy, "SELECT COUNT(*) AS n FROM actors"), 1);

	assert.deepEqual(pull(copy, remote), { batches: 0, read: 1, queries: 3, newest: NOW - 3600 });
	fill(d1, 3, 451);
	assert.deepEqual(pull(copy, remote), { batches: 3, read: 4, queries: 3, newest: NOW - 3600 });
	assert.equal(asked.at(-3), "SELECT * FROM batches WHERE id > 450 ORDER BY id LIMIT 200");
	assert.equal(count(copy, "SELECT COUNT(*) AS n FROM batches"), 453);
});

test("a page exactly full asks once more, and an empty remote leaves an empty copy", () => {
	const d1 = freshDatabase().raw;
	const copy = openMirror(":memory:");
	const { remote, asked } = remoteOver(d1);
	assert.deepEqual(pull(copy, remote, { page: 2 }), { batches: 0, read: 0, queries: 3, newest: null });
	fill(d1, 4);
	assert.equal(pull(copy, remote, { page: 2 }).batches, 4);
	assert.deepEqual(asked.slice(3, 6), [
		"SELECT * FROM batches WHERE id > 0 ORDER BY id LIMIT 2",
		"SELECT * FROM batches WHERE id > 2 ORDER BY id LIMIT 2",
		"SELECT * FROM batches WHERE id > 4 ORDER BY id LIMIT 2",
	]);
	assert.throws(() => pull(copy, remote, { page: 0 }), /page must be a positive integer, got 0/);
});

test("what the remote pruned stays in the copy, and its small tables are brought up to date", () => {
	const d1 = freshDatabase().raw;
	fill(d1, 10);
	d1.prepare("INSERT INTO events_daily VALUES ('2026-10-01', 'join', 'live', '1', 5, 4)").run();
	const copy = openMirror(":memory:");
	const { remote } = remoteOver(d1);
	pull(copy, remote);
	d1.exec("DELETE FROM batches WHERE id <= 6");
	d1.exec("UPDATE events_daily SET events = 9");
	d1.prepare("INSERT INTO actors VALUES ('u_2', 'live', '1', 200, 7)").run();
	fill(d1, 1, 11);
	assert.equal(pull(copy, remote).batches, 1);
	assert.equal(count(copy, "SELECT COUNT(*) AS n FROM batches"), 11);
	assert.equal(count(copy, "SELECT events AS n FROM events_daily"), 9);
	assert.equal(count(copy, "SELECT COUNT(*) AS n FROM actors"), 1);
});

test("a query asked of the copy answers as it does on the remote", () => {
	const d1 = freshDatabase().raw;
	fill(d1, 40);
	const copy = openMirror(":memory:");
	pull(copy, remoteOver(d1).remote);
	const question =
		"SELECT json_extract(ctx, '$.food') AS food, COUNT(*) AS n FROM events_week WHERE event = 'feed' GROUP BY food ORDER BY food";
	const rows = (db) =>
		db
			.prepare(question)
			.all()
			.map((row) => ({ ...row }));
	assert.deepEqual(rows(copy), rows(d1));
	assert.equal(
		rows(copy).reduce((sum, row) => sum + row.n, 0),
		40,
	);
});

test("a remote whose ids do not grow is refused rather than asked forever", () => {
	const copy = openMirror(":memory:");
	const stuck = () => ({ rows: [{ id: 0 }], read: 1 });
	assert.throws(() => pull(copy, stuck, { page: 1 }), /the remote's ids do not grow past 0/);
});

test("wrangler's answer gives its rows and D1's count, and a refusal gives D1's own words", () => {
	assert.deepEqual(parseWrangler('\n[{"results":[{"id":1}],"success":true,"meta":{"rows_read":3}}]'), {
		rows: [{ id: 1 }],
		read: 3,
	});
	assert.throws(
		() =>
			parseWrangler(
				'{"error":{"text":"A request failed.","notes":[{"text":"Over the daily read limit. [code: 7500]"}]}}',
			),
		{ message: "mirror: A request failed. Over the daily read limit. [code: 7500]" },
	);
	assert.throws(() => parseWrangler("Not logged in."), {
		message: "mirror: wrangler printed no JSON: Not logged in.",
	});
	assert.throws(() => parseWrangler('[{"success":false}]'), { message: "mirror: wrangler's answer holds no rows" });
});

test("the bin pulls through wrangler into a file, and says what it read", () => {
	const folder = mkdtempSync(join(tmpdir(), "telemetryblox-mirror-"));
	try {
		const remoteFile = join(folder, "d1.sqlite");
		const d1 = new DatabaseSync(remoteFile);
		d1.exec(schema());
		fill(d1, 3);
		d1.close();
		const stub = join(folder, "wrangler.mjs");
		writeFileSync(
			stub,
			[
				'import { DatabaseSync } from "node:sqlite";',
				'const sql = process.argv.find((arg) => arg.startsWith("--command=")).slice(10);',
				"if (process.argv[2] !== 'd1' || process.argv[4] !== 'example-db' || !process.argv.includes('--remote')) process.exit(3);",
				"if (process.env.REFUSE) { console.log(JSON.stringify({ error: { text: 'Refused.' } })); process.exit(1); }",
				`const rows = new DatabaseSync(${JSON.stringify(remoteFile)}).prepare(sql).all();`,
				"console.log(JSON.stringify([{ results: rows, success: true, meta: { rows_read: rows.length } }]));",
			].join("\n"),
		);
		const copyFile = join(folder, "copy.sqlite");
		const env = { ...process.env, WRANGLER: `${process.execPath} ${stub}` };
		const first = execFileSync(process.execPath, [BIN, "example-db", copyFile], { env, encoding: "utf8" });
		assert.match(
			first,
			/^mirror: 3 new batches, 3 rows read on D1 in 3 queries; newest batch received .*, 60 min ago\n$/,
		);
		const again = execFileSync(process.execPath, [BIN, "example-db", copyFile], { env, encoding: "utf8" });
		assert.match(again, /^mirror: 0 new batches, 0 rows read on D1 in 3 queries;/);
		const copy = new DatabaseSync(copyFile);
		assert.equal(count(copy, "SELECT COUNT(*) AS n FROM events"), 6);
		copy.close();

		const refused = spawnSync(process.execPath, [BIN, "example-db", copyFile], {
			env: { ...env, REFUSE: "1" },
			encoding: "utf8",
		});
		assert.equal(refused.status, 1);
		assert.equal(refused.stderr, "mirror: Refused.\n");
		const usage = spawnSync(process.execPath, [BIN, "example-db"], { encoding: "utf8" });
		assert.equal(usage.status, 2);
	} finally {
		rmSync(folder, { recursive: true });
	}
});
