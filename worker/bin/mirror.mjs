#!/usr/bin/env node
// Brings a local copy of a game's telemetry database up to D1, reading only the batches that
// arrived since the last pull, and says what that cost. Run it where the game's wrangler config is.
//
//     npx telemetryblox-mirror <database> <file.sqlite>
//
// WRANGLER overrides how wrangler is run (default `npx wrangler`). Exits 1 when D1 or wrangler
// refuses, with D1's own words; the copy keeps every page stored before the refusal.
import { resolve } from "node:path";
import { openMirror, pull, wranglerRemote } from "../mirror/index.mjs";

const [database, file] = process.argv.slice(2);
if (!database || !file || process.argv.length > 4) {
	console.error("usage: telemetryblox-mirror <database> <file.sqlite>");
	process.exit(2);
}

const db = openMirror(resolve(file));
try {
	const took = pull(db, wranglerRemote(database, { command: process.env.WRANGLER || "npx wrangler" }));
	const newest =
		took.newest === null
			? "the copy holds no batch"
			: `newest batch received ${new Date(took.newest * 1000).toISOString()}, ${Math.round((Date.now() / 1000 - took.newest) / 60)} min ago`;
	console.log(
		`mirror: ${took.batches} new batches, ${took.read} rows read on D1 in ${took.queries} queries; ${newest}`,
	);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	db.close();
}
