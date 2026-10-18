// A release told to the players: the game's tools post a title and its lines, and the Worker sends
// them to the Discord webhook its secret names. What must hold: the post is one embed that pings
// nobody, the caps are Discord's, a bad body and a missing key send nothing, a Worker without the
// secret says so, and a refusal from Discord is told back with its status.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { ANNOUNCE_TEXT, ANNOUNCE_TITLE, createWorker } from "../dist/index.js";
import { CONFIG, call, environment, recordTelegram, telegram } from "./helpers.mjs";

beforeEach(recordTelegram);

const HOOK = "https://discord.test/api/webhooks/1/made-up";
const withHook = (overrides = {}) => environment({ ANNOUNCE_WEBHOOK: HOOK, ...overrides });

test("an announcement is one embed to the webhook, and pings nobody", async () => {
	const env = withHook();
	const posted = await call(env, "/announce", {
		body: { title: "Update 272", text: "- Stars @everyone", url: "https://example.test/games/1" },
	});
	assert.deepEqual(posted, { status: 200, body: { ok: true } });
	assert.deepEqual(telegram.sent, [
		{
			url: HOOK,
			body: {
				embeds: [
					{ title: "Update 272", description: "- Stars @everyone", url: "https://example.test/games/1" },
				],
				allowed_mentions: { parse: [] },
			},
		},
	]);
	// Without an address the embed carries none.
	await call(env, "/announce", { body: { title: "Update 273", text: "- Bees" } });
	assert.deepEqual(telegram.sent[1].body.embeds, [{ title: "Update 273", description: "- Bees" }]);
});

test("a title and lines longer than Discord takes are cut to its caps, with the cut mark", async () => {
	await call(withHook(), "/announce", { body: { title: "t".repeat(300), text: "x".repeat(5000) } });
	const [embed] = telegram.sent[0].body.embeds;
	assert.equal(embed.title, `${"t".repeat(ANNOUNCE_TITLE - 3)}...`);
	assert.equal(embed.description, `${"x".repeat(ANNOUNCE_TEXT - 3)}...`);
	assert.equal(ANNOUNCE_TITLE, 256);
	assert.equal(ANNOUNCE_TEXT, 4096);
	// Exactly at the cap nothing is cut.
	await call(withHook(), "/announce", { body: { title: "Update", text: "y".repeat(ANNOUNCE_TEXT) } });
	assert.equal(telegram.sent[1].body.embeds[0].description, "y".repeat(ANNOUNCE_TEXT));
});

test("a bad body or a missing key sends nothing", async () => {
	const env = withHook();
	assert.equal((await call(env, "/announce", { key: null, body: { title: "a", text: "b" } })).status, 401);
	assert.equal((await call(env, "/announce", { key: "wrong-key", body: { title: "a", text: "b" } })).status, 401);
	assert.deepEqual(await call(env, "/announce"), { status: 405, body: { error: "method_not_allowed" } });
	const refused = [
		[{ text: "b" }, "title must be a non-empty string"],
		[{ title: " ", text: "b" }, "title must be a non-empty string"],
		[{ title: "a", text: 5 }, "text must be a non-empty string"],
		[{ title: "a", text: "" }, "text must be a non-empty string"],
		[{ title: "a", text: "b", url: "http://example.test" }, "url must be an https address"],
		[{ title: "a", text: "b", url: 7 }, "url must be an https address"],
	];
	for (const [body, error] of refused) {
		assert.deepEqual(await call(env, "/announce", { body }), { status: 400, body: { error } }, error);
	}
	assert.deepEqual(await call(env, "/announce", { raw: "not json" }), {
		status: 400,
		body: { error: "title must be a non-empty string" },
	});
	assert.equal(telegram.sent.length, 0);
});

test("a Worker without the webhook's secret says so and sends nothing", async () => {
	assert.deepEqual(await call(environment(), "/announce", { body: { title: "a", text: "b" } }), {
		status: 503,
		body: { error: "announce_unconfigured" },
	});
	assert.equal(telegram.sent.length, 0);
});

test("the webhook's secret is called what the game calls it", async () => {
	const renamed = createWorker({ ...CONFIG, bindings: { announceWebhook: "GAME_HOOK" } });
	// The default name reaches nothing on this Worker.
	const unset = await call(withHook(), "/announce", { body: { title: "a", text: "b" }, handler: renamed });
	assert.equal(unset.status, 503);
	const sent = await call(environment({ GAME_HOOK: HOOK }), "/announce", {
		body: { title: "a", text: "b" },
		handler: renamed,
	});
	assert.equal(sent.status, 200);
	assert.equal(telegram.sent.length, 1);
	assert.equal(telegram.sent[0].url, HOOK);
});

test("Discord's refusal is told back with its status, and no answer at all is status 0", async () => {
	telegram.answer = () => new Response("{}", { status: 404 });
	assert.deepEqual(await call(withHook(), "/announce", { body: { title: "a", text: "b" } }), {
		status: 502,
		body: { error: "discord_refused", status: 404 },
	});
	globalThis.fetch = async () => {
		throw new TypeError(`fetch failed for ${HOOK}`);
	};
	assert.deepEqual(await call(withHook(), "/announce", { body: { title: "a", text: "b" } }), {
		status: 502,
		body: { error: "discord_refused", status: 0 },
	});
});
