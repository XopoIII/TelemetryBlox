// What a game imports: the package by its name, as package.json's `exports` leads to it, and the
// testing helpers beside it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createKit, createWorker, DEFAULTS, field, short, who } from "telemetryblox";
import { checkQueries, freshDatabase } from "telemetryblox/testing";
import { recordTelegram, telegram } from "./helpers.mjs";

recordTelegram();

test("the package's name leads to the built Worker, which stores a batch and raises its alert", async () => {
	const worker = createWorker({ game: "cn", alerts: { save_failed: "critical" }, retentionDays: 60 });
	const env = { DB: freshDatabase(), INGEST_KEY: "k", TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_CHAT_ID: "42" };
	const post = (key) =>
		worker.fetch(
			new Request("https://ingest.test/ingest", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": key },
				body: JSON.stringify({
					schemaVersion: 1,
					game: "cn",
					universeId: "1",
					placeId: "2",
					placeVersion: 3,
					jobId: "j",
					env: "live",
					serverStart: 5,
					events: [
						{ seq: 1, t: 10, event: "save_failed", actor: "u_0123456789abcdef", ctx: { what: "load" } },
					],
				}),
			}),
			env,
		);
	assert.equal((await post("wrong")).status, 401);
	assert.deepEqual(await (await post("k")).json(), { ok: true, accepted: 1, skipped: 0, duplicate: false });
	assert.equal((await (await post("k")).json()).duplicate, true);
	assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM batches").get().n, 1);
	assert.deepEqual(
		telegram.sent.map((message) => message.body.text),
		['[critical] cn: save_failed: {"what":"load"}, player u_0123456789 [v3]'],
	);
});

test("the package exports the parts a game's rules and tests are written with", () => {
	assert.equal(createKit({ game: "cn" }).config.retentionDays, 60);
	assert.equal(DEFAULTS.retentionDays, 60);
	assert.equal(field({ a: 1 }, "a"), 1);
	assert.equal(field(null, "a"), undefined);
	assert.equal(short("abcdef", 3), "abc...");
	assert.equal(short(undefined), "?");
	assert.equal(who("u_0123456789abcdef"), "u_0123456789");
	assert.equal(who(undefined), "nobody");
	assert.equal(typeof checkQueries, "function");
});
