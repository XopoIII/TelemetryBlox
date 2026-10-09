// What only shows over many rows: the hourly scan, the nightly digest, the one cron that runs both,
// and Roblox's own webhooks. Telegram is a recorder here too.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createKit, createWorker, robloxAlertText } from "../dist/index.js";
import {
	batch,
	CONFIG,
	call,
	DAY,
	environment,
	kit,
	NOW,
	recordTelegram,
	rows,
	TOKEN,
	telegram,
	texts,
	worker,
	YESTERDAY,
} from "./helpers.mjs";

beforeEach(recordTelegram);

/** `count` rows of `event` for one player. */
const repeat = (count, event) => Array.from({ length: count }, () => event);

test("the hourly scan reads only batches newer than its last, and says who stood at a limit", async () => {
	const env = environment();
	// A first run on an empty table only sets the cursor.
	assert.deepEqual((await call(env, "/anomalies")).body, { message: "anomalies", from: 0, to: 0, found: 0, sent: 0 });
	await call(env, "/ingest", {
		body: batch([
			// A sum: 150 + 49 and one row with no count, which this rule counts as one. 200 in all.
			{ event: "net_reject", actor: "u_flood_0001", ctx: { count: 150 } },
			{ event: "net_reject", actor: "u_flood_0001", ctx: { count: 49 } },
			{ event: "net_reject", actor: "u_flood_0001" },
			// One short of the limit.
			{ event: "net_reject", actor: "u_under_0001", ctx: { count: 199 } },
			// Rows: six looks at the limit of six, five under it.
			...repeat(6, { event: "watch", actor: "u_looks_0001" }),
			...repeat(5, { event: "watch", actor: "u_under_0001" }),
			// A largest value: one row past the limit among smaller ones.
			{ event: "away_income", actor: "u_rich_00001", ctx: { coins: 5 } },
			{ event: "away_income", actor: "u_rich_00001", ctx: { coins: 2.5e9 } },
			{ event: "away_income", actor: "u_under_0001", ctx: { coins: 999_999_999 } },
		]),
	});
	const first = (await call(env, "/anomalies")).body;
	assert.deepEqual(first, { message: "anomalies", from: 0, to: 1, found: 3, sent: 3 });
	assert.deepEqual(texts().sort(), [
		"[warning] Example Game: Income 2.50e+9 while away, player u_rich_00001",
		"[warning] Example Game: rejects: 200 in the last scan (limit 200), player u_flood_0001",
		"[warning] Example Game: watching: 6 in the last scan (limit 6), player u_looks_0001",
	]);
	// Nothing new: nothing read, nothing said again.
	assert.deepEqual((await call(env, "/anomalies")).body, { message: "anomalies", from: 1, to: 1, found: 0, sent: 0 });
	assert.equal(telegram.sent.length, 3);
	assert.deepEqual(rows(env, "SELECT name, batch_id FROM alert_cursor"), [{ name: "anomaly", batch_id: 1 }]);
});

test("the scan leaves Studio's and a test place's batches out, and rows about no player", async () => {
	const env = environment();
	await call(env, "/anomalies");
	const flood = repeat(50, { event: "watch", actor: "u_dev_000001" });
	await call(env, "/ingest", { body: batch(flood, { env: "studio" }) });
	await call(env, "/ingest", { body: batch(flood, { env: "test" }) });
	await call(env, "/ingest", { body: batch(repeat(50, { event: "watch" })) });
	assert.equal((await call(env, "/anomalies")).body.found, 0);
	assert.equal(telegram.sent.length, 0);
	// The same flood from a player on a live server is found.
	await call(env, "/ingest", { body: batch(flood) });
	assert.equal((await call(env, "/anomalies")).body.found, 1);
});

test("a scan counts only what came since the last one, and the first one counts nothing", async () => {
	const env = environment();
	// What was already there when the scan first ran is not asked about.
	await call(env, "/ingest", { body: batch(repeat(50, { event: "watch", actor: "u_early_0001" })) });
	assert.deepEqual((await call(env, "/anomalies")).body, { message: "anomalies", from: 1, to: 1, found: 0, sent: 0 });
	// Five looks in one hour and five in the next are each under the limit of six: an hour is not
	// added to the one before it.
	const five = repeat(5, { event: "watch", actor: "u_looks_0001" });
	await call(env, "/ingest", { body: batch(five) });
	assert.equal((await call(env, "/anomalies")).body.found, 0);
	await call(env, "/ingest", { body: batch(five) });
	assert.deepEqual((await call(env, "/anomalies")).body, { message: "anomalies", from: 2, to: 3, found: 0, sent: 0 });
	assert.equal(telegram.sent.length, 0);
});

test("a finding is held like any alert of its weight, a player each", async () => {
	const env = environment();
	await call(env, "/anomalies");
	const flood = (actor) => repeat(6, { event: "watch", actor });
	await call(env, "/ingest", { body: batch(flood("u_looks_0001")) });
	assert.equal((await call(env, "/anomalies")).body.sent, 1);
	await call(env, "/ingest", { body: batch([...flood("u_looks_0001"), ...flood("u_other_0001")]) });
	const second = (await call(env, "/anomalies")).body;
	// Both are found; the first player's is inside its half hour and is held.
	assert.deepEqual([second.found, second.sent], [2, 1]);
	assert.deepEqual(rows(env, "SELECT key, held FROM alert_state ORDER BY key"), [
		{ key: "anomaly:watching:u_looks_0001", held: 1 },
		{ key: "anomaly:watching:u_other_0001", held: 0 },
	]);
});

test("a game with no scan rules only moves the cursor, and one rule may be graver than a warning", async () => {
	const none = createWorker({ game: "Example Game" });
	const env = environment();
	await call(env, "/anomalies", { handler: none });
	await call(env, "/ingest", {
		body: batch(repeat(50, { event: "watch", actor: "u_looks_0001" }), { game: undefined }),
	});
	assert.deepEqual((await call(env, "/anomalies", { handler: none })).body, {
		message: "anomalies",
		from: 0,
		to: 1,
		found: 0,
		sent: 0,
	});
	const grave = createKit({
		game: "Example Game",
		scan: [{ name: "watching", event: "watch", measure: "rows", limit: 6, severity: "critical" }],
	});
	env.DB.raw.exec("UPDATE alert_cursor SET batch_id = 0");
	assert.equal((await grave.anomalies(env)).sent, 1);
	assert.deepEqual(texts(), [
		"[critical] Example Game: watching: 50 in the last scan (limit 6), player u_looks_0001",
	]);
});

test("the nightly digest says yesterday in one message, and nothing of a day with no players", async () => {
	const env = environment();
	assert.equal(await kit.digest(env), false);
	assert.equal(telegram.sent.length, 0);
	const insert = env.DB.raw.prepare(
		"INSERT INTO events_daily (day, event, env, universe_id, events, actors) VALUES (date('now','-1 day'), ?, ?, 'u', ?, ?)",
	);
	insert.run("*", "live", 900, 12);
	insert.run("purchase", "live", 3, 2);
	insert.run("server_error", "live", 1, 0);
	insert.run("feed", "live", 400, 12);
	insert.run("purchase", "studio", 50, 1);
	insert.run("*", "test", 70, 1);
	assert.equal(await kit.digest(env), true);
	// The events of the alert table, in its order; `feed` is not in it.
	assert.deepEqual(texts(), [
		[
			"[digest] Example Game, yesterday: 12 players, 900 rows",
			"server_error 1; save_failed 0; telemetry_drop 0; receipt 0; purchase 3",
		].join("\n"),
	]);
});

test("the digest's events and words are the game's to say, and it can be turned off", async () => {
	const fill = (env) =>
		env.DB.raw.exec(
			`INSERT INTO events_daily (day, event, env, universe_id, events, actors) VALUES
			 (date('now','-1 day'), '*', 'live', 'u', 900, 12), (date('now','-1 day'), 'feed', 'live', 'u', 400, 12)`,
		);
	const listed = createKit({ ...CONFIG, digest: { events: ["feed", "feast"] } });
	const own = createKit({
		...CONFIG,
		digest: {
			events: ["feed"],
			text: (day) => `${day.players} came and fed ${day.count("feed")} times in ${day.rows} rows`,
		},
	});
	const off = createKit({ ...CONFIG, digest: false });
	const bare = createKit({ game: "Example Game" });
	for (const made of [listed, own, off, bare]) {
		const env = environment();
		fill(env);
		assert.equal(await made.digest(env), made !== off);
	}
	assert.deepEqual(texts(), [
		"[digest] Example Game, yesterday: 12 players, 900 rows\nfeed 400; feast 0",
		"[digest] Example Game, yesterday: 12 came and fed 400 times in 900 rows",
		"[digest] Example Game, yesterday: 12 players, 900 rows",
	]);
});

test("one cron an hour: only the run in the third UTC hour is the nightly one, or the hour the game says", () => {
	assert.equal(kit.isNightly(Date.UTC(2026, 9, 4, 3, 17)), true);
	assert.equal(kit.isNightly(Date.UTC(2026, 9, 4, 2, 17)), false);
	assert.equal(kit.isNightly(Date.UTC(2026, 9, 4, 4, 17)), false);
	const nights = (made) =>
		Array.from({ length: 24 }, (_, hour) => hour).filter((hour) => made.isNightly(Date.UTC(2026, 9, 4, hour, 17)));
	assert.deepEqual(nights(kit), [3]);
	assert.deepEqual(nights(createKit({ game: "x", nightlyHourUtc: 0 })), [0]);
	assert.deepEqual(nights(createKit({ game: "x", nightlyHourUtc: 23 })), [23]);
});

/** Runs the Worker's cron handler at `hour` UTC and waits for everything it started. */
async function cron(env, hour) {
	const waited = [];
	await worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 4, hour, 17) }, env, {
		waitUntil: (p) => waited.push(p),
	});
	await Promise.all(waited);
}

test("an hourly run scans and nothing else; the nightly run also rolls up, prunes and sends the digest", async () => {
	const env = environment();
	await call(env, "/ingest", {
		body: batch([
			{ event: "feed", actor: "u_a", t: YESTERDAY },
			{ event: "feed", actor: "u_b", t: YESTERDAY },
		]),
	});
	env.DB.raw.exec("INSERT INTO alert_state (key, sent_at, held, released) VALUES ('old', 1000, 0, 0)");
	await cron(env, 14);
	assert.deepEqual(rows(env, "SELECT batch_id FROM alert_cursor"), [{ batch_id: 1 }]);
	assert.equal(rows(env, "SELECT COUNT(*) AS n FROM events_daily")[0].n, 0);
	assert.equal(telegram.sent.length, 0);
	assert.equal(rows(env, "SELECT COUNT(*) AS n FROM alert_state")[0].n, 1);

	await cron(env, 3);
	assert.deepEqual(rows(env, "SELECT event, events, actors FROM events_daily ORDER BY event"), [
		{ event: "*", events: 2, actors: 2 },
		{ event: "feed", events: 2, actors: 2 },
	]);
	assert.deepEqual(texts(), [
		[
			"[digest] Example Game, yesterday: 2 players, 2 rows",
			"server_error 0; save_failed 0; telemetry_drop 0; receipt 0; purchase 0",
		].join("\n"),
	]);
	// A cool-down row not touched for a week is dropped with the night.
	assert.equal(rows(env, "SELECT COUNT(*) AS n FROM alert_state")[0].n, 0);
});

test("a game says how many days a cool-down's state is kept", async () => {
	const keeper = createWorker({ game: "example", alertStateDays: 30 });
	const env = environment();
	env.DB.raw.exec(
		`INSERT INTO alert_state (key, sent_at, held, released) VALUES
		 ('eight-days', ${NOW - 8 * DAY}, 0, 0),
		 ('forty-days', ${NOW - 40 * DAY}, 0, 0)`,
	);
	const waited = [];
	await keeper.scheduled({ scheduledTime: Date.UTC(2026, 9, 4, 3, 17) }, env, {
		waitUntil: (p) => waited.push(p),
	});
	await Promise.all(waited);
	// Eight days quiet: past the week's default, inside the game's thirty, so kept. Forty is gone
	// under both.
	assert.deepEqual(rows(env, "SELECT key FROM alert_state"), [{ key: "eight-days" }]);
});

test("a cron run that fails is logged and breaks nothing", async () => {
	const lines = [];
	const realError = console.error;
	console.error = (line) => lines.push(JSON.parse(line).message);
	try {
		await cron({ INGEST_KEY: "k" }, 14);
		await cron({ INGEST_KEY: "k" }, 3);
	} finally {
		console.error = realError;
	}
	assert.deepEqual(lines, ["anomalies_failed", "anomalies_failed", "nightly_failed"]);
});

test("Roblox's alert webhook is relayed, and only with the token", async () => {
	const env = environment();
	const payload = {
		NotificationId: "n1",
		EventType: "AnalyticsAlert",
		EventPayload: { AlertMessage: JSON.stringify({ summary: "Client crashes fired", metric: "ClientCrashRate" }) },
	};
	assert.equal((await call(env, "/roblox-alert", { key: null, body: payload })).status, 401);
	assert.equal((await call(env, "/roblox-alert?token=wrong", { key: null, body: payload })).status, 401);
	// The ingest key is not the webhook's token.
	assert.equal((await call(env, "/roblox-alert?token=test-key", { body: payload })).status, 401);
	assert.equal(telegram.sent.length, 0);
	const ok = await call(env, `/roblox-alert?token=${TOKEN}`, { key: null, body: payload });
	assert.deepEqual(ok, { status: 200, body: { ok: true, sent: true } });
	assert.deepEqual(texts(), ["[roblox] Example Game: Roblox alert: Client crashes fired (ClientCrashRate)"]);
	assert.equal((await call(env, `/roblox-alert?token=${TOKEN}`, { key: null })).status, 405);
	// With no token set on the Worker, the door is shut to everyone.
	const shut = environment({ ALERT_TOKEN: undefined });
	assert.equal((await call(shut, `/roblox-alert?token=${TOKEN}`, { key: null, body: payload })).status, 401);
	assert.equal((await call(shut, "/roblox-alert?token=", { key: null, body: payload })).status, 401);
});

test("a webhook body of an unknown shape is still said, shortened", () => {
	assert.equal(robloxAlertText({ hello: "world" }), 'Roblox alert: {"hello":"world"}');
	assert.equal(robloxAlertText(null), "Roblox alert: null");
	assert.equal(robloxAlertText({ EventPayload: { AlertMessage: "plain words" } }), "Roblox alert: plain words");
	assert.equal(robloxAlertText({ x: "y".repeat(1000) }).length, "Roblox alert: ".length + 403);
});

test("a right-to-erasure request names the user, the universes and what the game says to run", () => {
	const body = {
		NotificationId: "n2",
		EventType: "RightToErasureRequest",
		EventTime: "2026-10-04T05:00:00Z",
		EventPayload: { UserId: 4242, GameIds: [111, 333] },
	};
	assert.equal(
		kit.robloxWebhookText(body),
		"[roblox] Example Game: right to erasure. Delete the data of user 4242.\nUniverses named: 111, 333",
	);
	const hinted = createKit({ ...CONFIG, erasureHint: (user) => `Run: sh scripts/erase.sh ${user}` });
	assert.equal(hinted.robloxWebhookText(body).split("\n")[2], "Run: sh scripts/erase.sh 4242");
	// A request that names no universe still names the user.
	assert.equal(
		kit.robloxWebhookText({ EventType: "RightToErasureRequest", EventPayload: { UserId: 7 } }).split("\n")[1],
		"Universes named: ?",
	);
});

test("a game's own prefix starts each kind of webhook, in place of the mark and the name", () => {
	const kinds = [];
	const marked = createKit({
		...CONFIG,
		robloxPrefix: (kind) => {
			kinds.push(kind);
			return `<${kind}>`;
		},
	});
	const alert = { EventPayload: { AlertMessage: JSON.stringify({ summary: "fired", metric: "Memory" }) } };
	assert.deepEqual(
		[
			marked
				.robloxWebhookText({ EventType: "RightToErasureRequest", EventPayload: { UserId: 7 } })
				.split("\n")[0],
			marked.robloxWebhookText({ EventType: "SampleNotification", EventPayload: { UserId: 1 } }),
			marked.robloxWebhookText({ EventType: "TransactionRefunded", EventPayload: {} }).split("\n")[0],
			marked.robloxWebhookText({ EventType: "SubscriptionPurchased", EventPayload: {} }).split("\n")[0],
			marked.robloxWebhookText({ EventType: "AnalyticsAlert", ...alert }),
			marked.robloxWebhookText(null),
		],
		[
			"<erasure> right to erasure. Delete the data of user 7.",
			"<test> a test notification arrived (user 1). The webhook works.",
			"<refund> a refund (TransactionRefunded)",
			"<event> SubscriptionPurchased",
			"<alert> Roblox alert: fired (Memory)",
			"<alert> Roblox alert: null",
		],
	);
	assert.deepEqual(kinds, ["erasure", "test", "refund", "event", "alert", "alert"]);
	// Without one, every kind starts with the Roblox mark and the game's name.
	assert.equal(kit.config.robloxPrefix("erasure"), "[roblox] Example Game:");
	assert.equal(kit.config.robloxPrefix("alert"), "[roblox] Example Game:");
	assert.equal(createKit({ ...CONFIG, marks: { roblox: "R" } }).config.robloxPrefix("refund"), "R Example Game:");
});

test("a value that was cut ends with the game's own mark, in a webhook and in a rule's default text", () => {
	const cut = createKit({ game: "Example Game", marks: { cut: "~" }, alerts: { feed: "info" } });
	assert.equal(cut.config.marks.cut, "~");
	assert.equal(kit.config.marks.cut, "...");
	const long = "x".repeat(500);
	const refund = cut.robloxWebhookText({ EventType: `Refund${"d".repeat(80)}`, EventPayload: { f: long } });
	assert.deepEqual(refund.split("\n"), [
		`[roblox] Example Game: a refund (Refund${"d".repeat(54)}~)`,
		`f: ${"x".repeat(120)}~`,
	]);
	assert.equal(
		cut.robloxWebhookText({ EventType: "E".repeat(70), EventPayload: long }),
		`[roblox] Example Game: ${"E".repeat(60)}~\n${"x".repeat(300)}~`,
	);
	assert.equal(
		cut.robloxWebhookText({ EventType: "RightToErasureRequest", EventPayload: { UserId: "9".repeat(30) } }),
		`[roblox] Example Game: right to erasure. Delete the data of user ${"9".repeat(20)}~.\nUniverses named: ?`,
	);
	assert.equal(
		cut.robloxWebhookText({ EventType: "SampleNotification", EventPayload: { UserId: "9".repeat(30) } }),
		`[roblox] Example Game: a test notification arrived (user ${"9".repeat(20)}~). The webhook works.`,
	);
	assert.equal(
		cut.robloxWebhookText({
			EventPayload: { AlertMessage: JSON.stringify({ summary: "s".repeat(300), metric: "m".repeat(100) }) },
		}),
		`[roblox] Example Game: Roblox alert: ${"s".repeat(200)}~ (${"m".repeat(80)}~)`,
	);
	assert.equal(robloxAlertText({ EventPayload: { AlertMessage: long } }, "~"), `Roblox alert: ${"x".repeat(400)}~`);
	assert.equal(robloxAlertText({ EventPayload: { AlertMessage: long } }), `Roblox alert: ${"x".repeat(400)}...`);
	// A rule with no text of its own says the context, cut the same way.
	const [alert] = cut.alertsFor([{ event: "feed", ctx: { note: long } }], {
		env: "live",
		placeVersion: 3,
		jobId: "j",
	});
	assert.equal(alert.text, `feed: ${JSON.stringify({ note: long }).slice(0, 160)}~ [v3]`);
});

test("a refund says every field Roblox sent, whatever they are called", () => {
	const body = {
		EventType: "TransactionRefunded",
		EventPayload: { UserId: 99, ProductId: 3714139905, Amount: 49, Nested: { a: 1 } },
	};
	assert.equal(
		kit.robloxWebhookText(body),
		[
			"[roblox] Example Game: a refund (TransactionRefunded)",
			"UserId: 99",
			"ProductId: 3714139905",
			"Amount: 49",
			'Nested: {"a":1}',
		].join("\n"),
	);
	assert.equal(
		kit.robloxWebhookText({ EventType: "SubscriptionRefunded", EventPayload: {} }).split("\n")[1],
		"(no fields)",
	);
	// Ten fields at most, each shortened.
	const wide = Object.fromEntries(Array.from({ length: 30 }, (_, n) => [`f${n}`, "x".repeat(500)]));
	const lines = kit.robloxWebhookText({ EventType: "TransactionRefunded", EventPayload: wide }).split("\n");
	assert.equal(lines.length, 11);
	assert.equal(lines[1].length, "f0: ".length + 123);
});

test("the dashboard's test button, an alert and an unknown event each read as what they are", () => {
	assert.equal(
		kit.robloxWebhookText({ EventType: "SampleNotification", EventPayload: { UserId: 1 } }),
		"[roblox] Example Game: a test notification arrived (user 1). The webhook works.",
	);
	const alert = {
		EventType: "AnalyticsAlert",
		EventPayload: { AlertMessage: JSON.stringify({ summary: "fired", metric: "Memory" }) },
	};
	assert.equal(kit.robloxWebhookText(alert), "[roblox] Example Game: Roblox alert: fired (Memory)");
	assert.equal(
		kit.robloxWebhookText({ EventType: "SubscriptionPurchased", EventPayload: { Subscriber: 5 } }),
		"[roblox] Example Game: SubscriptionPurchased\nSubscriber: 5",
	);
	assert.equal(kit.robloxWebhookText({ hello: "world" }), '[roblox] Example Game: Roblox alert: {"hello":"world"}');
	assert.equal(kit.robloxWebhookText(null), "[roblox] Example Game: Roblox alert: null");
});
