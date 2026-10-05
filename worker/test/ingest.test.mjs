// The ingest, run for real against SQLite: `npm test`, which builds worker/dist first. The tests
// read the built JavaScript, which is what a game runs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createWorker } from "../dist/index.js";
import { freshDatabase } from "../testing/index.mjs";
import { call, DAY, envelope, environment, KEY, NOW, rows, stored, YESTERDAY } from "./helpers.mjs";

const one = (overrides = {}) => envelope(overrides, [{ seq: 1, t: YESTERDAY, event: "join", actor: "u_a", ctx: {} }]);

test("a batch without the key, or with a wrong one, is refused and stores nothing", async () => {
	const env = environment();
	assert.equal((await call(env, "/ingest", { key: null, body: one() })).status, 401);
	assert.equal((await call(env, "/ingest", { key: "wrong-key", body: one() })).status, 401);
	assert.equal((await call(env, "/ingest", { key: `${KEY}x`, body: one() })).status, 401);
	assert.equal(stored(env), 0);
	// The right key, beside them, is let in.
	assert.equal((await call(env, "/ingest", { body: one() })).status, 200);
	assert.equal(stored(env), 1);
});

test("a Worker with no key set lets nobody in, whatever they present", async () => {
	const env = environment({ INGEST_KEY: undefined });
	assert.equal((await call(env, "/ingest", { key: null, body: one() })).status, 401);
	assert.equal((await call(env, "/ingest", { key: "undefined", body: one() })).status, 401);
	const empty = environment({ INGEST_KEY: "" });
	assert.equal((await call(empty, "/ingest", { key: null, body: one() })).status, 401);
	assert.equal(stored(env) + stored(empty), 0);
});

test("a batch is one row, and the same batch sent again is not stored twice", async () => {
	const env = environment();
	const batch = envelope({}, [
		{ seq: 7, t: YESTERDAY, event: "join", actor: "u_a", ctx: { locale: "en" } },
		{ seq: 8, t: YESTERDAY + 5, event: "feed", actor: "u_a", ctx: { pieces: 2 } },
	]);
	const first = await call(env, "/ingest", { body: batch });
	assert.deepEqual(first, { status: 200, body: { ok: true, accepted: 2, skipped: 0, duplicate: false } });
	// The game holds a refused batch and posts the same rows again; `sentAt` is the only difference.
	const second = await call(env, "/ingest", { body: { ...batch, sentAt: batch.sentAt + 60 } });
	assert.deepEqual(second, { status: 200, body: { ok: true, accepted: 2, skipped: 0, duplicate: true } });
	assert.equal((await call(env, "/ingest", { body: batch })).body.duplicate, true);
	assert.deepEqual(rows(env, "SELECT first_seq, last_seq, n, place_version, env FROM batches"), [
		{ first_seq: 7, last_seq: 8, n: 2, place_version: 49, env: "live" },
	]);
	assert.deepEqual(
		rows(env, "SELECT seq, event, actor, json_extract(ctx,'$.pieces') AS pieces FROM events ORDER BY seq"),
		[
			{ seq: 7, event: "join", actor: "u_a", pieces: null },
			{ seq: 8, event: "feed", actor: "u_a", pieces: 2 },
		],
	);
});

test("another batch is another row: a later first row, another server, another server start", async () => {
	const env = environment();
	const event = (seq) => ({ seq, t: YESTERDAY, event: "join", actor: "u_a", ctx: {} });
	for (const batch of [
		envelope({}, [event(1)]),
		envelope({}, [event(2)]),
		envelope({ jobId: "job-b" }, [event(1)]),
		envelope({ serverStart: 2000 }, [event(1)]),
	]) {
		assert.equal((await call(env, "/ingest", { body: batch })).body.duplicate, false);
	}
	assert.equal(stored(env), 4);
});

test("a malformed event is skipped and the rest of its batch lands", async () => {
	const env = environment();
	const batch = envelope({}, [
		{ seq: 1, t: YESTERDAY, event: "join", actor: "u_a", ctx: {} },
		{ seq: "two", t: YESTERDAY, event: "feed" },
		{ seq: 3, t: YESTERDAY },
		"not an event",
	]);
	const answer = await call(env, "/ingest", { body: batch });
	assert.deepEqual(answer.body, { ok: true, accepted: 1, skipped: 3, duplicate: false });
	assert.equal(rows(env, "SELECT n FROM batches")[0].n, 1);
	// A batch of nothing usable is answered and not stored.
	const none = await call(env, "/ingest", { body: envelope({ jobId: "job-n" }, [{ seq: 1 }]) });
	assert.deepEqual(none, { status: 200, body: { ok: true, accepted: 0, skipped: 1 } });
	assert.equal(stored(env), 1);
});

test("an empty context arrives from Roblox as an empty array and is read as empty", async () => {
	const env = environment();
	await call(env, "/ingest", { body: envelope({}, [{ seq: 1, t: YESTERDAY, event: "join", ctx: [] }]) });
	assert.deepEqual(rows(env, "SELECT ctx, actor FROM events"), [{ ctx: "{}", actor: null }]);
});

test("an oversized body is refused before it is stored, and one at the limit is not", async () => {
	const small = createWorker({ game: "example", maxBodyBytes: 600 });
	const env = environment();
	const padded = (bytes) => {
		const body = envelope({}, [{ seq: 1, t: YESTERDAY, event: "join", ctx: { pad: "" } }]);
		const base = JSON.stringify(body).length;
		body.events[0].ctx.pad = "x".repeat(bytes - base);
		return JSON.stringify(body);
	};
	assert.equal(padded(600).length, 600);
	const over = await call(env, "/ingest", { raw: padded(601), handler: small });
	assert.deepEqual(over, { status: 413, body: { error: "payload_too_large" } });
	assert.equal(stored(env), 0);
	assert.equal((await call(env, "/ingest", { raw: padded(600), handler: small })).status, 200);
	assert.equal(stored(env), 1);
});

test("a body is measured in bytes, and one that declares itself too large is not read", async () => {
	const small = createWorker({ game: "example", maxBodyBytes: 600 });
	const env = environment();
	// 250 two-byte characters: 500 bytes of padding in under 600 characters of body.
	const wide = JSON.stringify(
		envelope({}, [{ seq: 1, t: YESTERDAY, event: "join", ctx: { pad: String.fromCharCode(233).repeat(250) } }]),
	);
	assert.ok(wide.length < 600 && new TextEncoder().encode(wide).byteLength > 600);
	assert.equal((await call(env, "/ingest", { raw: wide, handler: small })).status, 413);
	const declared = await call(env, "/ingest", {
		body: one(),
		handler: small,
		headers: { "content-length": "601" },
	});
	assert.equal(declared.status, 413);
	assert.equal(stored(env), 0);
});

test("the default limit is a million bytes", async () => {
	const env = environment();
	const big = JSON.stringify(
		envelope({}, [{ seq: 1, t: YESTERDAY, event: "join", ctx: { pad: "x".repeat(1_000_000) } }]),
	);
	assert.equal((await call(env, "/ingest", { raw: big })).status, 413);
	assert.equal(stored(env), 0);
});

test("an envelope the ingest cannot use is refused with 400 and says why", async () => {
	const env = environment();
	const refused = async (body, detail) => {
		const answer = await call(env, "/ingest", { body });
		assert.deepEqual(answer, { status: 400, body: { error: "invalid_envelope", detail } });
	};
	await refused(one({ env: "prod" }), "env must be one of live, studio, test");
	await refused(one({ env: undefined }), "env must be one of live, studio, test");
	await refused(one({ schemaVersion: "1" }), "schemaVersion must be a number");
	await refused(one({ universeId: 111 }), "universeId must be a string");
	await refused(one({ placeId: "" }), "placeId must be a string");
	await refused(envelope({}, "rows"), "events must be an array");
	await refused(envelope({}, new Array(2001).fill({ seq: 1 })), "events exceeds 2000");
	await refused(null, "the body must be an object");
	assert.deepEqual(await call(env, "/ingest", { raw: "{not json" }), {
		status: 400,
		body: { error: "invalid_json" },
	});
	assert.equal(stored(env), 0);
	// Two thousand events, the limit itself, are taken.
	const full = envelope({}, new Array(2000).fill({ seq: 1, t: YESTERDAY, event: "join", ctx: {} }));
	assert.equal((await call(env, "/ingest", { body: full })).body.accepted, 2000);
});

test("a batch tagged for another game is refused, and one with no tag is taken", async () => {
	const env = environment();
	const other = await call(env, "/ingest", { body: one({ game: "other" }) });
	assert.deepEqual(other, {
		status: 400,
		body: { error: "invalid_envelope", detail: "this ingest is example's" },
	});
	assert.equal(stored(env), 0);
	assert.equal((await call(env, "/ingest", { body: one({ game: undefined }) })).status, 200);
	assert.equal((await call(env, "/ingest", { body: one({ game: "example", jobId: "job-b" }) })).status, 200);
	assert.equal(stored(env), 2);
});

test("a test place's batch is stored under its own name, and the game says which names exist", async () => {
	const env = environment();
	assert.equal((await call(env, "/ingest", { body: one({ env: "test" }) })).status, 200);
	assert.equal((await call(env, "/ingest", { body: one({ env: "studio", jobId: "" }) })).status, 200);
	assert.deepEqual(rows(env, "SELECT env FROM batches ORDER BY id"), [{ env: "test" }, { env: "studio" }]);
	const strict = createWorker({ game: "example", environments: ["live", "staging"] });
	assert.equal((await call(env, "/ingest", { body: one({ env: "test" }), handler: strict })).status, 400);
	assert.equal((await call(env, "/ingest", { body: one({ env: "staging" }), handler: strict })).status, 200);
});

test("the nightly job keeps who was first seen when, and on which version, before it prunes", async () => {
	const env = environment();
	await call(env, "/ingest", {
		body: envelope({ placeVersion: 46, jobId: "job-a" }, [
			{ seq: 1, t: YESTERDAY, event: "join", actor: "u_a", ctx: {} },
			{ seq: 2, t: YESTERDAY + 60, event: "feed", actor: "u_a", ctx: {} },
			{ seq: 3, t: YESTERDAY + 90, event: "world_build", ctx: {} },
		]),
	});
	await call(env, "/ingest", {
		body: envelope({ placeVersion: 47, jobId: "job-b" }, [
			{ seq: 1, t: YESTERDAY + 600, event: "join", actor: "u_a", ctx: {} },
			{ seq: 2, t: YESTERDAY + 700, event: "join", actor: "u_b", ctx: {} },
		]),
	});

	const report = (await call(env, "/retention")).body;
	assert.equal(report.newActors, 2);
	assert.equal(report.deletedBatches, 0);
	assert.deepEqual(rows(env, "SELECT actor, env, first_seen, first_version FROM actors ORDER BY actor"), [
		{ actor: "u_a", env: "live", first_seen: YESTERDAY, first_version: 46 },
		{ actor: "u_b", env: "live", first_seen: YESTERDAY + 700, first_version: 47 },
	]);
	// A second run finds nobody new and changes nothing.
	assert.equal((await call(env, "/retention")).body.newActors, 0);

	// The raw rows go (as the prune takes them) and u_a comes back a week later: their first moment
	// is still the kept one, not the oldest row left.
	env.DB.raw.exec("DELETE FROM batches");
	await call(env, "/ingest", {
		body: envelope({ placeVersion: 50, jobId: "job-c" }, [
			{ seq: 1, t: YESTERDAY + 7 * DAY, event: "join", actor: "u_a", ctx: {} },
			{ seq: 2, t: YESTERDAY + 7 * DAY, event: "join", actor: "u_c", ctx: {} },
		]),
	});
	assert.deepEqual(rows(env, "SELECT actor, t0 FROM first_seen WHERE env = 'live' ORDER BY actor"), [
		{ actor: "u_a", t0: YESTERDAY },
		{ actor: "u_b", t0: YESTERDAY + 700 },
		// Not kept yet (no nightly run since): read from the raw rows.
		{ actor: "u_c", t0: YESTERDAY + 7 * DAY },
	]);
});

test("the nightly job rolls a finished day up per event and as a whole", async () => {
	const env = environment();
	await call(env, "/ingest", {
		body: envelope({}, [
			{ seq: 1, t: YESTERDAY, event: "join", actor: "u_a", ctx: {} },
			{ seq: 2, t: YESTERDAY + 1, event: "join", actor: "u_b", ctx: {} },
			{ seq: 3, t: YESTERDAY + 2, event: "feed", actor: "u_a", ctx: {} },
			{ seq: 4, t: YESTERDAY + 3, event: "feed", actor: "u_a", ctx: {} },
			{ seq: 5, t: YESTERDAY + 4, event: "world_build", ctx: {} },
			// Today is not finished, so it is not rolled up yet.
			{ seq: 6, t: NOW, event: "join", actor: "u_c", ctx: {} },
		]),
	});
	await call(env, "/retention");
	assert.deepEqual(rows(env, "SELECT event, events, actors FROM events_daily ORDER BY event"), [
		// The day as a whole: five events, two players. The per-event actors sum to three.
		{ event: "*", events: 5, actors: 2 },
		{ event: "feed", events: 2, actors: 1 },
		{ event: "join", events: 2, actors: 2 },
		{ event: "world_build", events: 1, actors: 0 },
	]);
	assert.equal(rows(env, "SELECT COUNT(DISTINCT day) AS days FROM events_daily")[0].days, 1);
});

/** Two batches, one received `age` days ago and one yesterday; the retention report of `handler`. */
async function pruned(handler, age) {
	const env = environment();
	await call(env, "/ingest", {
		body: envelope({ jobId: "old" }, [{ seq: 1, t: NOW - age * DAY, event: "join", actor: "u_a", ctx: {} }]),
	});
	await call(env, "/ingest", {
		body: envelope({ jobId: "new" }, [{ seq: 1, t: YESTERDAY, event: "join", actor: "u_b", ctx: {} }]),
	});
	env.DB.raw.exec(`UPDATE batches SET received_at = ${NOW - age * DAY} WHERE job_id = 'old'`);
	const report = (await call(env, "/retention", { handler })).body;
	return { env, report, left: rows(env, "SELECT job_id FROM batches ORDER BY id").map((row) => row.job_id) };
}

test("the nightly job prunes batches past sixty days and keeps the rest", async () => {
	const { env, report, left } = await pruned(undefined, 61);
	assert.equal(report.deletedBatches, 1);
	assert.equal(report.rawBatches, 1);
	assert.deepEqual(left, ["new"]);
	// The pruned player's first moment was kept first.
	assert.equal(rows(env, "SELECT first_seen FROM actors WHERE actor = 'u_a'")[0].first_seen, NOW - 61 * DAY);
	// Fifty-nine days is inside the window.
	assert.deepEqual((await pruned(undefined, 59)).left, ["old", "new"]);
});

test("the days raw rows are kept are the game's to say", async () => {
	const month = createWorker({ game: "example", retentionDays: 30 });
	assert.deepEqual((await pruned(month, 31)).left, ["new"]);
	assert.deepEqual((await pruned(month, 29)).left, ["old", "new"]);
	const year = createWorker({ game: "example", retentionDays: 365 });
	assert.deepEqual((await pruned(year, 61)).left, ["old", "new"]);
});

test("past the event budget the oldest batches go, whatever their age", async () => {
	const tiny = createWorker({ game: "example", maxRawEvents: 3 });
	const env = environment();
	for (const jobId of ["a", "b"]) {
		const events = [1, 2].map((seq) => ({ seq, t: YESTERDAY, event: "join", actor: "u_a", ctx: {} }));
		await call(env, "/ingest", { body: envelope({ jobId }, events) });
	}
	const report = (await call(env, "/retention", { handler: tiny })).body;
	// Four events against a budget of three: one chunk of the oldest batches goes, which here is all.
	assert.equal(report.overBudgetBatches, 2);
	assert.equal(report.rawEvents, 0);
	assert.equal(report.warn, undefined);
	assert.equal(stored(env), 0);
	// The default budget leaves four events alone.
	const kept = environment();
	await call(kept, "/ingest", { body: one() });
	assert.equal((await call(kept, "/retention")).body.overBudgetBatches, 0);
	assert.equal(stored(kept), 1);
});

test("the deep health check needs the key and says how fresh the live data is", async () => {
	const env = environment();
	assert.deepEqual(await call(env, "/health", { key: null }), { status: 200, body: { ok: true } });
	assert.equal((await call(env, "/health?deep=1", { key: null })).status, 401);
	assert.deepEqual((await call(env, "/health?deep=1")).body, {
		ok: true,
		batches: 0,
		lastReceivedAt: null,
		ageSeconds: null,
		placeVersion: null,
	});

	// A Studio batch and a test place's are not live data.
	await call(env, "/ingest", {
		body: one({ env: "studio", jobId: "", events: [{ seq: 1, t: NOW, event: "join", ctx: {} }] }),
	});
	await call(env, "/ingest", { body: one({ env: "test", jobId: "t" }) });
	assert.equal((await call(env, "/health?deep=1")).body.batches, 0);

	await call(env, "/ingest", { body: one({ placeVersion: 47 }) });
	const fresh = (await call(env, "/health?deep=1")).body;
	assert.equal(fresh.batches, 1);
	assert.equal(fresh.placeVersion, 47);
	assert.ok(fresh.ageSeconds >= 0 && fresh.ageSeconds <= 5, `age ${fresh.ageSeconds}`);
	assert.ok(Math.abs(fresh.lastReceivedAt - NOW) <= 5);
});

test("the doors that read or delete need the key, and an unknown door is not found", async () => {
	const env = environment();
	for (const path of ["/retention", "/anomalies", "/notify", "/health?deep=1"]) {
		assert.equal((await call(env, path, { key: null })).status, 401, path);
		assert.equal((await call(env, path, { key: "wrong-key" })).status, 401, path);
	}
	assert.deepEqual(await call(env, "/nowhere"), { status: 404, body: { error: "not_found" } });
	assert.deepEqual(await call(env, "/ingest"), { status: 405, body: { error: "method_not_allowed" } });
	assert.deepEqual(await call(env, "/notify"), { status: 405, body: { error: "method_not_allowed" } });
});

test("the binding and the secrets are called what the game calls them", async () => {
	const renamed = createWorker({ game: "example", bindings: { database: "TELEMETRY", ingestKey: "GAME_KEY" } });
	const env = { TELEMETRY: freshDatabase(), GAME_KEY: "another-key", INGEST_KEY: KEY };
	// The default secret's name opens nothing on this Worker.
	assert.equal((await call(env, "/ingest", { body: one(), handler: renamed })).status, 401);
	assert.equal((await call(env, "/ingest", { key: "another-key", body: one(), handler: renamed })).status, 200);
	assert.equal(env.TELEMETRY.raw.prepare("SELECT COUNT(*) AS n FROM batches").get().n, 1);
	// A config that names a binding wrangler does not provide is a 500 that says so in the log.
	const lost = createWorker({ game: "example", bindings: { database: "MISSING" } });
	assert.equal((await call(environment(), "/ingest", { body: one(), handler: lost })).status, 500);
});

test("a config that is wrong fails when the Worker is made, not on the first batch", () => {
	const wrong = (config, problem) =>
		assert.throws(() => createWorker(config), { message: `TelemetryBlox: ${problem}` });
	wrong({}, "`game` must be a non-empty string");
	wrong({ game: "" }, "`game` must be a non-empty string");
	wrong({ game: "x", alerts: { boom: "loud" } }, "the alert for boom has no such severity: loud");
	wrong({ game: "x", retentionDays: 0 }, "`retentionDays` must be a positive number");
	wrong({ game: "x", maxAlertsPerBatch: -1 }, "`maxAlertsPerBatch` must be a positive number");
	wrong({ game: "x", cooldownSeconds: { critical: -1 } }, "`cooldownSeconds.critical` must be zero or more seconds");
	wrong({ game: "x", nightlyHourUtc: 24 }, "`nightlyHourUtc` must be an hour, 0 to 23");
	wrong({ game: "x", environments: ["studio"] }, '`environments` must hold "live"');
	const scan = (rule) => ({ game: "x", scan: [{ name: "n", event: "e", measure: "rows", limit: 1, ...rule }] });
	wrong(scan({ name: "two words" }), "a scan rule's name must be a word of its own: two words");
	wrong(scan({ measure: "sum" }), "the scan rule n needs a `field` to sum");
	wrong(scan({ measure: "max", field: "a.b" }), "the scan rule n needs a `field` to max");
	wrong(scan({ measure: "mean" }), "the scan rule n has no such measure");
	wrong(scan({ limit: undefined }), "the scan rule n has no limit");
	wrong(scan({ event: "" }), "the scan rule n names no event");
	wrong({ game: "x", scan: [scan({}).scan[0], scan({}).scan[0]] }, "a scan rule's name must be a word of its own: n");
	wrong(
		{ game: "x", scan: new Array(31).fill(0).map((_, i) => scan({ name: `n${i}` }).scan[0]) },
		"`scan` holds 31 rules; 30 is the most",
	);
	// The smallest config there is.
	assert.equal(typeof createWorker({ game: "x" }).fetch, "function");
});

test("the batch the Luau pipe is checked against is taken whole", async () => {
	// tests/wire/batch.json is what the pipe posts, to the field (tests/unit/Wire.luau).
	const wire = readFileSync(new URL("../../tests/wire/batch.json", import.meta.url), "utf8");
	const env = environment();
	const answer = await call(env, "/ingest", { raw: wire });
	assert.deepEqual(answer, { status: 200, body: { ok: true, accepted: 2, skipped: 0, duplicate: false } });
	assert.deepEqual(
		rows(
			env,
			`SELECT env, schema_version, universe_id, place_id, place_version, job_id, server_start, first_seq, last_seq, n
			 FROM batches`,
		),
		[
			{
				env: "live",
				schema_version: 1,
				universe_id: "111",
				place_id: "222",
				place_version: 7,
				job_id: "job-a",
				server_start: 1800000000,
				first_seq: 1,
				last_seq: 2,
				n: 2,
			},
		],
	);
	assert.deepEqual(rows(env, "SELECT seq, t, event, actor, ctx FROM events ORDER BY seq"), [
		{ seq: 1, t: 1800000000, event: "feed", actor: "u_b6143fd8f67c8ca4", ctx: '{"pieces":3}' },
		{ seq: 2, t: 1800000030, event: "purchase", actor: null, ctx: '{"robux":25}' },
	]);
	// Every field of the fixture's envelope is one the ingest knows: none is silently dropped but
	// `sentAt`, which the ingest replaces with its own clock.
	assert.deepEqual(Object.keys(JSON.parse(wire)).sort(), [
		"env",
		"events",
		"game",
		"jobId",
		"placeId",
		"placeVersion",
		"schemaVersion",
		"sentAt",
		"serverStart",
		"universeId",
	]);
});
