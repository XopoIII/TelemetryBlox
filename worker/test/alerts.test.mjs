// Alerts to Telegram, run for real: batches through the Worker's own ingest against SQLite, with
// `fetch` to Telegram replaced by a recorder. What must hold: an event of the game's table raises
// its message at its weight and any other raises none, a repeat is held and counted, a Telegram
// outage never costs a batch, and Studio, a test place and an unconfigured chat send nothing.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createKit, createWorker, DEFAULTS } from "../dist/index.js";
import {
	batch,
	CONFIG,
	call,
	environment,
	kit,
	LIVE,
	recordTelegram,
	rows,
	stored,
	telegram,
	texts,
} from "./helpers.mjs";

beforeEach(recordTelegram);

test("a server error is sent at once, to the configured chat, with the game and the place version", async () => {
	const env = environment();
	const result = await call(env, "/ingest", {
		body: batch([{ event: "server_error", ctx: { message: "attempt to index nil", script: "Server.World" } }]),
	});
	assert.equal(result.status, 200);
	assert.equal(telegram.sent.length, 1);
	assert.equal(telegram.sent[0].url, "https://api.telegram.org/botbot-token/sendMessage");
	assert.deepEqual(telegram.sent[0].body, {
		chat_id: "42",
		text: "[critical] Example Game: Server error in Server.World: attempt to index nil [v49]",
		disable_web_page_preview: true,
	});
});

test("each event of the table maps to its weight, and an event outside the table sends nothing", () => {
	const alerts = kit.alertsFor(
		[
			{ event: "purchase", actor: "u_buyer_0001xx", ctx: { key: "boost", purchase_id: "p1" } },
			{ event: "join", actor: "u_plain_0001xx", ctx: {} },
			{ event: "telemetry_drop", ctx: { count: 3, overflow: 3, send_failed: 0, refused: 0 } },
			{ event: "save_failed", actor: "u_saver_0001xx", ctx: { what: "load" } },
			{ event: "feed", actor: "u_plain_0001xx", ctx: { pieces: 2 } },
			{ event: "receipt", actor: "u_payer_0001xx", ctx: { outcome: "unknown" } },
			{ event: "server_error", ctx: { message: "boom", script: "Server.Pen" } },
			{ event: "no_such_event", ctx: {} },
		],
		LIVE,
	);
	assert.deepEqual(
		alerts.map((alert) => [alert.severity, alert.key, alert.cooldown]),
		[
			["critical", "save_failed", 600],
			["critical", "server_error:Server.Pen:boom", 600],
			["warning", "telemetry_drop", 1800],
			["warning", "receipt:u_payer_0001", 1800],
			["info", "purchase:p1", 0],
		],
	);
	assert.deepEqual(
		alerts.map((alert) => alert.text),
		[
			'save_failed: {"what":"load"}, player u_saver_0001 [v49]',
			"Server error in Server.Pen: boom [v49]",
			'telemetry_drop: {"count":3,"overflow":3,"send_failed":0,"refused":0} [v49]',
			'receipt: {"outcome":"unknown"}, player u_payer_0001 [v49]',
			"Purchase: boost, player u_buyer_0001 [v49]",
		],
	);
	// A batch of nothing but ordinary play asks for nothing.
	assert.deepEqual(
		kit.alertsFor(
			[
				{ event: "join", ctx: {} },
				{ event: "feed", ctx: {} },
			],
			LIVE,
		),
		[],
	);
});

test("a rule's own condition decides which rows of its event are worth a message", () => {
	const receipt = (outcome) => ({ event: "receipt", actor: "u_payer_0001xx", ctx: { outcome } });
	assert.equal(kit.alertsFor([receipt("unknown")], LIVE).length, 1);
	assert.deepEqual(kit.alertsFor([receipt("granted")], LIVE), []);
	assert.deepEqual(kit.alertsFor([{ event: "receipt", ctx: {} }], LIVE), []);
});

test("a batch of ordinary play is stored and sends nothing", async () => {
	const env = environment();
	await call(env, "/ingest", {
		body: batch([
			{ event: "join", actor: "u_a" },
			{ event: "feed", actor: "u_a", ctx: { pieces: 3 } },
			{ event: "receipt", actor: "u_a", ctx: { outcome: "granted" } },
		]),
	});
	assert.equal(stored(env), 1);
	assert.equal(telegram.sent.length, 0);
});

test("the same kind many times in a batch is one message with its count, a kind each its own", () => {
	const error = { event: "server_error", ctx: { message: "boom", script: "Server.Pen" } };
	const other = { event: "server_error", ctx: { message: "bang", script: "Server.Pen" } };
	const alerts = kit.alertsFor([error, error, other, error], LIVE);
	assert.deepEqual(
		alerts.map((alert) => alert.text),
		["Server error in Server.Pen: boom (x3) [v49]", "Server error in Server.Pen: bang [v49]"],
	);
	// One alert a player where the rule says so.
	const unknown = (actor) => ({ event: "receipt", actor, ctx: { outcome: "unknown" } });
	const perPlayer = kit.alertsFor([unknown("u_one_000001"), unknown("u_two_000002"), unknown("u_one_000001")], LIVE);
	assert.deepEqual(
		perPlayer.map((alert) => alert.key),
		["receipt:u_one_000001", "receipt:u_two_000002"],
	);
});

test("a batch from Studio or from a test place alerts nobody, and the same batch live does", async () => {
	const error = [{ event: "server_error", ctx: { message: "boom", script: "X" } }];
	for (const name of ["studio", "test"]) {
		const env = environment();
		assert.equal((await call(env, "/ingest", { body: batch(error, { env: name }) })).status, 200);
		assert.equal(stored(env), 1);
		assert.equal(telegram.sent.length, 0, name);
		assert.deepEqual(kit.alertsFor([{ event: "save_failed", ctx: {} }], { ...LIVE, env: name }), []);
	}
	await call(environment(), "/ingest", { body: batch(error) });
	assert.equal(telegram.sent.length, 1);
});

test("a repeat inside the cool-down is held and counted, and the next one past it says how many", async () => {
	const env = environment();
	const alert = { key: "server_error:X:boom", severity: "critical", text: "Server error in X: boom", cooldown: 600 };
	assert.equal(await kit.deliver(env, [alert], 1000), 1);
	// In the very second it went, too: its time alone could not tell this one from the first.
	assert.equal(await kit.deliver(env, [alert], 1000), 0);
	assert.equal(await kit.deliver(env, [alert], 1001), 0);
	assert.equal(await kit.deliver(env, [alert], 1599), 0);
	assert.equal(telegram.sent.length, 1);
	assert.deepEqual(rows(env, "SELECT key, sent_at, held FROM alert_state"), [
		{ key: "server_error:X:boom", sent_at: 1000, held: 3 },
	]);
	assert.equal(await kit.deliver(env, [alert], 1600), 1);
	assert.equal(texts()[1], "[critical] Example Game: Server error in X: boom (+3 held since the last)");
	// The count starts again.
	assert.equal(await kit.deliver(env, [alert], 2200), 1);
	assert.equal(texts()[2], "[critical] Example Game: Server error in X: boom");
});

test("a different kind is not held by another's cool-down", async () => {
	const env = environment();
	const one = { key: "save_failed:load", severity: "critical", text: "one", cooldown: 600 };
	const two = { key: "save_failed:apply", severity: "critical", text: "two", cooldown: 600 };
	assert.equal(await kit.deliver(env, [one], 1000), 1);
	assert.equal(await kit.deliver(env, [two], 1001), 1);
	assert.equal(telegram.sent.length, 2);
});

test("a kind with no cool-down is never held, and keeps no state", async () => {
	const env = environment();
	const purchase = { key: "purchase:p1", severity: "info", text: "Purchase", cooldown: 0 };
	assert.equal(await kit.deliver(env, [purchase], 1000), 1);
	assert.equal(await kit.deliver(env, [purchase], 1000), 1);
	assert.equal(await kit.deliver(env, [purchase], 1001), 1);
	assert.equal(telegram.sent.length, 3);
	assert.equal(rows(env, "SELECT COUNT(*) AS n FROM alert_state")[0].n, 0);
});

test("the cool-downs are the game's to set, by weight and by rule", async () => {
	assert.deepEqual(DEFAULTS.cooldownSeconds, { critical: 600, warning: 1800, info: 0 });
	const quick = createKit({
		game: "Example Game",
		cooldownSeconds: { critical: 60, info: 30 },
		alerts: {
			save_failed: "critical",
			telemetry_drop: "warning",
			purchase: "info",
			// Critical, and yet every one of them is sent.
			server_error: { severity: "critical", cooldownSeconds: 0 },
			feast: { severity: "info", cooldownSeconds: 900 },
		},
	});
	const events = ["save_failed", "telemetry_drop", "purchase", "server_error", "feast"].map((event) => ({
		event,
		ctx: {},
	}));
	const alerts = quick.alertsFor(events, LIVE);
	assert.deepEqual(
		alerts.map((alert) => [alert.key, alert.cooldown]),
		[
			["save_failed", 60],
			["server_error", 0],
			["telemetry_drop", 1800],
			["purchase", 30],
			["feast", 900],
		],
	);
	const env = environment();
	assert.equal(await quick.deliver(env, alerts, 1000), 5);
	// A minute later: the critical one's minute is up, the error was never held, the rest still are.
	assert.equal(await quick.deliver(env, alerts, 1060), 3);
	assert.deepEqual(texts().slice(5), [
		"[critical] Example Game: save_failed: {} [v49]",
		"[critical] Example Game: server_error: {} [v49]",
		"[info] Example Game: purchase: {} [v49]",
	]);
});

test("a batch raises eight messages at most, or as many as the game says", async () => {
	const many = Array.from({ length: 20 }, (_, i) => ({
		key: `k${i}`,
		severity: "warning",
		text: `t${i}`,
		cooldown: 1800,
	}));
	assert.equal(DEFAULTS.maxAlertsPerBatch, 8);
	assert.equal(await kit.deliver(environment(), many, 1000), 8);
	assert.deepEqual(texts().slice(-1), ["[warning] Example Game: t7"]);
	const two = createKit({ game: "Example Game", maxAlertsPerBatch: 2 });
	assert.equal(await two.deliver(environment(), many, 1000), 2);
	assert.equal(telegram.sent.length, 10);
});

test("the same batch arriving twice raises its alerts once", async () => {
	const env = environment();
	const bought = batch([{ event: "purchase", actor: "u_buyer_0001xx", ctx: { key: "boost", purchase_id: "p1" } }]);
	await call(env, "/ingest", { body: bought });
	await call(env, "/ingest", { body: bought });
	// A purchase is never held, so only the ingest knowing its batch keeps the second one quiet.
	assert.deepEqual(texts(), ["[info] Example Game: Purchase: boost, player u_buyer_0001 [v49]"]);
});

test("a Telegram outage costs no batch: it is stored and answered 200", async () => {
	const env = environment();
	telegram.answer = () => new Response("down", { status: 502 });
	const refused = await call(env, "/ingest", { body: batch([{ event: "save_failed", ctx: { what: "load" } }]) });
	assert.equal(refused.status, 200);
	assert.equal(refused.body.accepted, 1);
	globalThis.fetch = async () => {
		throw new Error("network down");
	};
	const thrown = await call(env, "/ingest", {
		body: batch([{ event: "server_error", ctx: { message: "x", script: "Y" } }]),
	});
	assert.equal(thrown.status, 200);
	assert.equal(stored(env), 2);
});

test("with no token or no chat nothing is sent, the message is logged, and the batch still lands", async () => {
	const logged = [];
	const realLog = console.log;
	console.log = (line) => logged.push(JSON.parse(line));
	try {
		for (const missing of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
			const env = environment({ [missing]: undefined });
			const result = await call(env, "/ingest", {
				body: batch([{ event: "server_error", ctx: { message: "x", script: "Y" } }]),
			});
			assert.equal(result.status, 200);
			assert.equal(stored(env), 1);
		}
	} finally {
		console.log = realLog;
	}
	assert.equal(telegram.sent.length, 0);
	assert.deepEqual(logged, [
		{ message: "alert_unconfigured", text: "[critical] Example Game: Server error in Y: x [v49]" },
		{ message: "alert_unconfigured", text: "[critical] Example Game: Server error in Y: x [v49]" },
	]);
});

test("a failed send never writes the bot's token to the log", async () => {
	const lines = [];
	const realError = console.error;
	console.error = (line) => lines.push(String(line));
	try {
		globalThis.fetch = async (url) => {
			throw new Error(`request to ${url} failed`);
		};
		assert.equal(await kit.send(environment(), "hello"), false);
		recordTelegram();
		telegram.answer = () => new Response("no", { status: 401 });
		assert.equal(await kit.send(environment(), "hello"), false);
	} finally {
		console.error = realError;
	}
	assert.deepEqual(
		lines.map((line) => JSON.parse(line)),
		[
			{ message: "alert_send_failed", error: "Error" },
			{ message: "alert_send_failed", status: 401 },
		],
	);
	assert.equal(lines.join("").includes("bot-token"), false);
});

test("a rule of the game's that throws costs its own alert and nothing else", async () => {
	const fragile = createWorker({
		game: "Example Game",
		alerts: {
			feast: { severity: "warning", text: (event) => event.ctx.where.toUpperCase() },
			save_failed: "critical",
		},
	});
	const env = environment();
	const realError = console.error;
	console.error = () => {};
	try {
		const result = await call(env, "/ingest", {
			handler: fragile,
			body: batch([{ event: "feast" }, { event: "save_failed" }, { event: "feast", ctx: { where: "yard" } }], {
				game: undefined,
			}),
		});
		assert.deepEqual(result.body, { ok: true, accepted: 3, skipped: 0, duplicate: false });
	} finally {
		console.error = realError;
	}
	assert.deepEqual(texts(), ["[critical] Example Game: save_failed: {} [v49]", "[warning] Example Game: YARD [v49]"]);
});

test("the marks that start a message are the game's to change", async () => {
	const marked = createKit({ ...CONFIG, marks: { critical: "!!", notice: ">>" } });
	await marked.deliver(environment(), [{ key: "k", severity: "critical", text: "down", cooldown: 0 }], 1000);
	await marked.deliver(environment(), [{ key: "k", severity: "warning", text: "odd", cooldown: 0 }], 1000);
	assert.deepEqual(texts(), ["!! Example Game: down", "[warning] Example Game: odd"]);
});

test("a notice from the game's own tools needs the key and a text", async () => {
	const env = environment();
	assert.equal((await call(env, "/notify", { key: null, body: { text: "hi" } })).status, 401);
	assert.deepEqual(await call(env, "/notify", { body: { text: 5 } }), {
		status: 400,
		body: { error: "text must be a string" },
	});
	assert.equal(telegram.sent.length, 0);
	const ok = await call(env, "/notify", { body: { text: "Version 50 is published" } });
	assert.deepEqual(ok, { status: 200, body: { ok: true, sent: true } });
	assert.deepEqual(texts(), ["[notice] Example Game: Version 50 is published"]);
	await call(env, "/notify", { body: { text: "x".repeat(5000) } });
	assert.equal(texts()[1].length, "[notice] Example Game: ".length + 1000);
});
