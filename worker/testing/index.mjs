// What a game's own Worker tests stand on: a D1 database over Node's SQLite with the kit's schema
// applied, and a check that every saved query runs against it. D1 IS SQLite, so the Worker's SQL
// and the game's queries run here as written.
//
//     import { checkQueries, freshDatabase } from "telemetryblox/testing";
//
// Plain JavaScript on purpose: Node will not strip types from a file under node_modules, and this
// one is run from there.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/** The folder of the kit's migrations, as a path: what a game's wrangler config points at. */
export const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));

/** The kit's schema: every migration, in order, as one script. */
export function schema() {
	return readdirSync(MIGRATIONS)
		.filter((name) => name.endsWith(".sql"))
		.sort()
		.map((name) => readFileSync(`${MIGRATIONS}${name}`, "utf8"))
		.join("\n");
}

class Statement {
	constructor(db, sql, args = []) {
		this.db = db;
		this.sql = sql;
		this.args = args;
	}

	bind(...args) {
		return new Statement(this.db, this.sql, args);
	}

	async run() {
		const result = this.db.prepare(this.sql).run(...this.args);
		return { meta: { changes: Number(result.changes) } };
	}

	async first() {
		return this.db.prepare(this.sql).get(...this.args) ?? null;
	}

	async all() {
		return { results: this.db.prepare(this.sql).all(...this.args) };
	}
}

/**
 * A fresh in-memory database with the schema applied, shaped like the D1 binding as far as the
 * Worker uses it (`prepare`, `bind`, `run`, `first`, `all`). `raw` is the SQLite handle, for a
 * test's own reads and writes.
 */
export function freshDatabase() {
	const raw = new DatabaseSync(":memory:");
	raw.exec(schema());
	return {
		raw,
		prepare(sql) {
			return new Statement(raw, sql);
		},
	};
}

/** The statements of one SQL file's text: comment lines dropped, split at each `;` that ends a line. */
export function statements(text) {
	return text
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("--"))
		.join("\n")
		.split(/;\s*(?:\n|$)/)
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}

/**
 * Runs every statement of every `.sql` file in `directory` against an empty copy of the schema.
 * Returns what failed, each with its file, its statement and SQLite's own words; an empty list
 * means every query names tables and columns that exist. A folder with no query is itself a
 * failure: a check that checks nothing is not green.
 */
export function checkQueries(directory) {
	const folder = directory.endsWith("/") ? directory : `${directory}/`;
	const files = readdirSync(folder)
		.filter((name) => name.endsWith(".sql"))
		.sort();
	if (files.length === 0) return [{ file: folder, statement: "", error: "no .sql file here" }];
	const db = freshDatabase().raw;
	const failures = [];
	for (const file of files) {
		const found = statements(readFileSync(`${folder}${file}`, "utf8"));
		if (found.length === 0) failures.push({ file, statement: "", error: "no statement in this file" });
		for (const statement of found) {
			try {
				db.prepare(statement).all();
			} catch (error) {
				failures.push({ file, statement, error: error instanceof Error ? error.message : String(error) });
			}
		}
	}
	return failures;
}
