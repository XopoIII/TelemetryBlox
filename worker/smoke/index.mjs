// The Worker run for real, once, the way a game runs it: workerd (the runtime Cloudflare runs)
// around the JavaScript committed in worker/dist, its D1 binding over real SQLite, the kit's own
// migrations applied, and HTTP through the front door. The unit tests prove the parts against
// Node's SQLite; this proves the parts survive being an actual Worker: module graph, bindings,
// routing, D1, and back.
//
// It is deliberately narrow: a batch in, a duplicate held off, the health door answering from the
// data. Anything narrower than "it runs" is the unit tests' job. No Telegram secrets are set, so
// an alert would be logged, never sent; nothing here touches the network but workerd itself.
//
// Run by scripts/check-worker.sh after the build (worker/dist is what it serves).

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { schema, statements } from "../testing/index.mjs";

const KEY = "smoke-key";
// dispatchFetch resolves the host for real; localhost is the one name that always resolves.
const HOST = "http://localhost";

// `modules: true` has miniflare follow the entry's imports from disk, so the smoke serves the
// exact files a game installs: worker/dist as it is committed.
const mf = new Miniflare({
	scriptPath: fileURLToPath(new URL("./entry.mjs", import.meta.url)),
	modules: true,
	// The kit's dist is `.js`, which the module rules read as CommonJS without this.
	modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
	compatibilityDate: "2026-01-01",
	d1Databases: ["DB"],
	bindings: { INGEST_KEY: KEY },
});

const fail = (problem) => {
	console.error(`smoke: ${problem}`);
	process.exitCode = 1;
};

try {
	// The schema a game's wrangler would apply, over the same D1 the Worker is bound to.
	const db = await mf.getD1Database("DB");
	for (const statement of statements(schema())) {
		await db.prepare(statement).run();
	}

	const post = (path, body, key = KEY) =>
		mf.dispatchFetch(`${HOST}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
			body: JSON.stringify(body),
		});

	const batch = {
		schemaVersion: 1,
		game: "smoke",
		universeId: "111",
		placeId: "222",
		placeVersion: 7,
		jobId: "job-smoke",
		env: "live",
		serverStart: 1000,
		sentAt: 1001,
		events: [
			{ seq: 1, t: 1000, event: "join", actor: "u_a", ctx: {} },
			{ seq: 2, t: 1001, event: "purchase", actor: "u_a", ctx: { robux: 25 } },
		],
	};

	// No key: refused, and nothing stored.
	const locked = await post("/ingest", batch, null);
	assert.equal(locked.status, 401, "a batch without the key is refused");

	const first = await post("/ingest", batch);
	assert.equal(first.status, 200, "a batch with the key is taken");
	const stored = await first.json();
	assert.equal(stored.accepted, 2, "both events are stored");
	assert.equal(stored.duplicate, false, "the first arrival is not a duplicate");

	const again = await post("/ingest", { ...batch, sentAt: 1002 });
	assert.equal((await again.json()).duplicate, true, "the same batch again is ignored, not stored twice");

	const health = await mf.dispatchFetch(`${HOST}/health`);
	assert.deepEqual(await health.json(), { ok: true }, "the health door is up");

	const deep = await mf.dispatchFetch(`${HOST}/health?deep=1`, { headers: { "x-api-key": KEY } });
	const freshness = await deep.json();
	assert.equal(freshness.batches, 1, "the deep health reads the stored batch");
	assert.equal(freshness.placeVersion, 7, "and says its place version");

	const count = await db.prepare("SELECT COUNT(*) AS n FROM batches").first();
	assert.equal(count.n, 1, "D1 holds exactly one batch");

	if (process.exitCode) {
		console.error("smoke: FAILED");
	} else {
		console.log("smoke: the Worker runs in workerd: batch in, duplicate held off, health answers");
	}
} catch (error) {
	fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
	await mf.dispose();
}
