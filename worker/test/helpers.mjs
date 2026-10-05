// What the Worker's tests share: an example game's config, an environment over SQLite, and a
// recorder in place of Telegram. No test here reaches the network: `fetch` is replaced when this
// file loads, for good, and the token is a made-up word.
import { createKit, createWorker, field, short } from "../dist/index.js";
import { freshDatabase } from "../testing/index.mjs";

export const KEY = "test-key";
export const TOKEN = "hook-token";
export const HOST = "https://ingest.test";
export const DAY = 86400;
export const NOW = Math.floor(Date.now() / 1000);
/** Noon yesterday, UTC: a finished day, which is what the nightly job rolls up. */
export const YESTERDAY = Math.floor(NOW / DAY) * DAY - DAY / 2;
export const LIVE = { env: "live", placeVersion: 49, jobId: "job-a" };

/** An example game's config: every way a rule can be written, and three scan rules. */
export const CONFIG = {
	game: "Example Game",
	tag: "example",
	alerts: {
		// A rule in full: its own kind (one alert a script and message) and its own words.
		server_error: {
			severity: "critical",
			per: (event) => `${short(field(event.ctx, "script"), 80)}:${short(field(event.ctx, "message"), 60)}`,
			text: (event) =>
				`Server error in ${short(field(event.ctx, "script"), 80)}: ${short(field(event.ctx, "message"))}`,
		},
		// The shortest rule: a weight, the default words, one alert a kind.
		save_failed: "critical",
		telemetry_drop: "warning",
		// Only some rows of the event, and one alert a player.
		receipt: {
			severity: "warning",
			when: (event) => field(event.ctx, "outcome") === "unknown",
			per: "actor",
		},
		purchase: {
			severity: "info",
			per: (event) => short(field(event.ctx, "purchase_id"), 60),
			text: (event, who) => `Purchase: ${short(field(event.ctx, "key"), 30)}, player ${who}`,
		},
	},
	scan: [
		{ name: "rejects", event: "net_reject", measure: "sum", field: "count", missing: 1, limit: 200 },
		{ name: "watching", event: "watch", measure: "rows", limit: 6 },
		{
			name: "income",
			event: "away_income",
			measure: "max",
			field: "coins",
			limit: 1e9,
			text: (value) => `Income ${value.toExponential(2)} while away`,
		},
	],
};

export const worker = createWorker(CONFIG);
export const kit = createKit(CONFIG);

/** Every message Telegram was asked to send, and what it answers. */
export const telegram = { sent: [], answer: () => new Response("{}", { status: 200 }) };

/**
 * Puts the recorder in `fetch`'s place and empties it. It is first called here, as this file loads,
 * and the real `fetch` is never put back: a test file that forgets to ask still reaches no network.
 */
export function recordTelegram() {
	telegram.sent = [];
	telegram.answer = () => new Response("{}", { status: 200 });
	globalThis.fetch = async (url, init) => {
		telegram.sent.push({ url: String(url), body: JSON.parse(init.body) });
		return telegram.answer();
	};
}
recordTelegram();

/** The texts sent so far. */
export const texts = () => telegram.sent.map((message) => message.body.text);

export function environment(overrides = {}) {
	return {
		DB: freshDatabase(),
		INGEST_KEY: KEY,
		ALERT_TOKEN: TOKEN,
		TELEGRAM_BOT_TOKEN: "bot-token",
		TELEGRAM_CHAT_ID: "42",
		...overrides,
	};
}

export function envelope(overrides, events) {
	return {
		schemaVersion: 1,
		game: "example",
		universeId: "111",
		placeId: "222",
		placeVersion: 49,
		jobId: "job-a",
		env: "live",
		serverStart: 1000,
		sentAt: NOW,
		events,
		...overrides,
	};
}

let seq = 0;
/** A live batch of `events`, each given the next row number, the time and an empty context. */
export function batch(events, overrides = {}) {
	return envelope(
		overrides,
		events.map((event) => ({ seq: ++seq, t: NOW, ctx: {}, ...event })),
	);
}

/** One request to `handler` (the example Worker by default). `body` undefined: a GET. */
export async function call(env, path, { key = KEY, body, raw, headers = {}, handler = worker } = {}) {
	const all = { "content-type": "application/json", ...headers };
	if (key) all["x-api-key"] = key;
	const sent = raw ?? (body === undefined ? undefined : JSON.stringify(body));
	const response = await handler.fetch(
		new Request(HOST + path, { method: sent === undefined ? "GET" : "POST", headers: all, body: sent }),
		env,
	);
	return { status: response.status, body: await response.json() };
}

export const rows = (env, sql) =>
	env.DB.raw
		.prepare(sql)
		.all()
		.map((row) => ({ ...row }));

export const stored = (env) => rows(env, "SELECT COUNT(*) AS n FROM batches")[0].n;
