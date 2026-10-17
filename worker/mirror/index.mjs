// A local copy of a game's telemetry database, so every question is asked of a file on the
// developer's machine and not of D1.
//
//     import { openMirror, pull, wranglerRemote } from "telemetryblox/mirror";
//
// WHY: D1's free plan reads five million rows a day, and a question over the `events` view counts
// every event it expands. A few dozen questions spend the day, and past the limit D1 refuses the
// ingest's inserts too, so reading the data loses it. The copy is pulled by primary key: a batch
// already here is never read again, so a pull costs the batches that arrived since the last one,
// one row each, and every question after it costs nothing.
//
// The copy has the kit's own schema (every migration, applied again on each open, as each is
// written to be), so a query written for D1 runs on it unchanged. It keeps the batches D1's
// retention has pruned: here the history only grows.
//
// Plain JavaScript on purpose: Node will not strip types from a file under node_modules, and this
// one is run from there.
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { schema } from "../testing/index.mjs";

/** Batches asked for at once: a few megabytes of JSON at most, well inside what D1 answers. */
export const PAGE = 200;

/** The small tables pulled whole on every run: the long-run trends and when each player was first seen. */
export const WHOLE = ["events_daily", "actors"];

/** Opens (or creates) the copy at `file`, with the kit's schema applied. */
export function openMirror(file) {
	const db = new DatabaseSync(file);
	db.exec(schema());
	return db;
}

function columns(db, table) {
	return db
		.prepare(`SELECT name FROM pragma_table_info('${table}')`)
		.all()
		.map((row) => row.name);
}

function store(db, table, rows, verb) {
	if (rows.length === 0) return;
	const names = columns(db, table);
	const insert = db.prepare(
		`${verb} INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
	);
	db.exec("BEGIN");
	try {
		for (const row of rows) insert.run(...names.map((name) => row[name] ?? null));
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

/**
 * Brings the copy `db` up to the remote. `remote(sql)` runs one statement there and returns
 * `{ rows, read }`, the rows and what the remote counted as read. Returns what the pull took:
 * the new batches, the rows the remote read, the statements it ran, and the newest batch's
 * `received_at` in the copy (null for an empty one).
 */
export function pull(db, remote, { page = PAGE } = {}) {
	if (!Number.isInteger(page) || page < 1) throw new Error(`mirror: page must be a positive integer, got ${page}`);
	let after = Number(db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM batches").get().id);
	let batches = 0;
	let read = 0;
	let queries = 0;
	for (;;) {
		const answer = remote(`SELECT * FROM batches WHERE id > ${after} ORDER BY id LIMIT ${page}`);
		queries += 1;
		read += answer.read;
		store(db, "batches", answer.rows, "INSERT OR IGNORE");
		batches += answer.rows.length;
		if (answer.rows.length < page) break;
		const last = Number(answer.rows[answer.rows.length - 1].id);
		if (!Number.isInteger(last) || last <= after)
			throw new Error(`mirror: the remote's ids do not grow past ${after}`);
		after = last;
	}
	for (const table of WHOLE) {
		const answer = remote(`SELECT * FROM ${table}`);
		queries += 1;
		read += answer.read;
		store(db, table, answer.rows, "INSERT OR REPLACE");
	}
	const newest = db.prepare("SELECT MAX(received_at) AS t FROM batches").get().t;
	return { batches, read, queries, newest: newest === null ? null : Number(newest) };
}

/**
 * What `wrangler d1 execute --json` printed, as `{ rows, read }`: the first result's rows and the
 * rows D1 says it read. Throws with D1's own words when the answer is an error.
 */
export function parseWrangler(text) {
	const start = text.search(/[[{]/);
	let answer;
	try {
		answer = JSON.parse(start < 0 ? text : text.slice(start));
	} catch {
		throw new Error(`mirror: wrangler printed no JSON: ${text.trim().slice(0, 200)}`);
	}
	if (!Array.isArray(answer)) {
		const error = answer?.error;
		const notes = Array.isArray(error?.notes) ? error.notes.map((note) => note.text) : [];
		throw new Error(`mirror: ${[error?.text ?? "wrangler answered with no result", ...notes].join(" ")}`);
	}
	const result = answer[0];
	if (!result || result.success === false || !Array.isArray(result.results)) {
		throw new Error("mirror: wrangler's answer holds no rows");
	}
	return { rows: result.results, read: Number(result.meta?.rows_read ?? 0) };
}

/**
 * A remote for `pull` over wrangler: `database` is the D1 database's name in the wrangler config
 * of `cwd`. `command` is how wrangler is run, split at spaces (default `npx wrangler`).
 */
export function wranglerRemote(database, { command = "npx wrangler", cwd = process.cwd() } = {}) {
	const [binary, ...lead] = command.split(" ").filter((part) => part.length > 0);
	return (sql) => {
		const args = [...lead, "d1", "execute", database, "--remote", "--json", `--command=${sql}`];
		let text;
		try {
			text = execFileSync(binary, args, {
				cwd,
				encoding: "utf8",
				maxBuffer: 1 << 28,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			text = typeof error?.stdout === "string" && error.stdout.trim() ? error.stdout : String(error?.message);
			parseWrangler(text);
			throw new Error(`mirror: wrangler failed: ${String(error?.message).slice(0, 200)}`);
		}
		return parseWrangler(text);
	};
}
