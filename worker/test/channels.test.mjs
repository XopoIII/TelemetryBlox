// More chats than the one: a game keeps what it wants apart (its purchases, say) in a channel of its
// own, named by the secrets of another bot and chat. What must hold: a rule that names a channel is
// sent there and nothing else is, a channel whose secrets are not set loses no message, a webhook
// kind follows the game's say, and a config that names a channel it does not hold is refused as the
// Worker is made.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createKit, createWorker, robloxKind } from "../dist/index.js";
import { batch, CONFIG, call, environment, LIVE, recordTelegram, stored, TOKEN, telegram } from "./helpers.mjs";

beforeEach(recordTelegram);

const MONEY = { token: "MONEY_BOT_TOKEN", chat: "MONEY_CHAT_ID" };
/** The example game with its purchases, and its refunds, in a chat of their own. */
const SPLIT = {
	...CONFIG,
	channels: { money: MONEY },
	alerts: { ...CONFIG.alerts, purchase: { ...CONFIG.alerts.purchase, channel: "money" } },
	robloxChannel: (kind) => (kind === "refund" ? "money" : undefined),
};
const split = createWorker(SPLIT);
const splitKit = createKit(SPLIT);
const withMoney = (overrides = {}) =>
	environment({ MONEY_BOT_TOKEN: "money-token", MONEY_CHAT_ID: "77", ...overrides });

/** Where each message went: the bot in the URL and the chat in the body. */
const routes = () =>
	telegram.sent.map((message) => [
		message.url.replace("https://api.telegram.org/bot", "").replace("/sendMessage", ""),
		message.body.chat_id,
		message.body.text,
	]);

const PURCHASE = { event: "purchase", actor: "u_buyer_0001xx", ctx: { key: "boost", purchase_id: "p1" } };
const ERROR = { event: "server_error", ctx: { message: "boom", script: "Server.Pen" } };

test("a rule that names a channel is sent to that bot and chat, and every other alert to the chat", async () => {
	const env = withMoney();
	const result = await call(env, "/ingest", { body: batch([PURCHASE, ERROR]), handler: split });
	assert.equal(result.status, 200);
	assert.deepEqual(routes(), [
		["bot-token", "42", "[critical] Example Game: Server error in Server.Pen: boom [v49]"],
		["money-token", "77", "[info] Example Game: Purchase: boost, player u_buyer_0001 [v49]"],
	]);
});

test("an alert carries its rule's channel, and one without carries none", () => {
	const alerts = splitKit.alertsFor([PURCHASE, ERROR], LIVE);
	assert.deepEqual(
		alerts.map((alert) => [alert.key, alert.channel]),
		[
			["server_error:Server.Pen:boom", undefined],
			["purchase:p1", "money"],
		],
	);
	assert.equal("channel" in alerts[0], false);
});

test("without the channel in the config the same rows all go to the chat", async () => {
	const env = withMoney();
	await call(env, "/ingest", { body: batch([PURCHASE, ERROR]) });
	assert.deepEqual(
		routes().map(([bot, chat]) => [bot, chat]),
		[
			["bot-token", "42"],
			["bot-token", "42"],
		],
	);
});

test("a channel missing either secret sends to the chat and says so by its name alone", async () => {
	const logged = [];
	const realLog = console.log;
	console.log = (line) => logged.push(JSON.parse(line));
	try {
		for (const missing of ["MONEY_BOT_TOKEN", "MONEY_CHAT_ID"]) {
			const env = withMoney({ [missing]: undefined });
			const result = await call(env, "/ingest", { body: batch([PURCHASE]), handler: split });
			assert.equal(result.status, 200);
			assert.equal(stored(env), 1);
		}
	} finally {
		console.log = realLog;
	}
	assert.deepEqual(
		routes().map(([bot, chat]) => [bot, chat]),
		[
			["bot-token", "42"],
			["bot-token", "42"],
		],
	);
	assert.deepEqual(logged, [
		{ message: "alert_channel_unconfigured", channel: "money" },
		{ message: "alert_channel_unconfigured", channel: "money" },
	]);
});

test("with neither the channel nor the chat set up nothing is sent and the batch still lands", async () => {
	const logged = [];
	const realLog = console.log;
	console.log = (line) => logged.push(JSON.parse(line));
	const env = environment({ TELEGRAM_BOT_TOKEN: undefined });
	try {
		assert.equal((await call(env, "/ingest", { body: batch([PURCHASE]), handler: split })).status, 200);
	} finally {
		console.log = realLog;
	}
	assert.equal(stored(env), 1);
	assert.equal(telegram.sent.length, 0);
	assert.deepEqual(
		logged.map((line) => line.message),
		["alert_channel_unconfigured", "alert_unconfigured"],
	);
});

test("a message sent by hand goes to the channel it names, and to the chat for a name nobody declared", async () => {
	const env = withMoney();
	assert.equal(await splitKit.send(env, "to the money chat", "money"), true);
	assert.equal(await splitKit.send(env, "to the chat"), true);
	assert.equal(await splitKit.send(env, "to nowhere known", "elsewhere"), true);
	assert.deepEqual(routes(), [
		["money-token", "77", "to the money chat"],
		["bot-token", "42", "to the chat"],
		["bot-token", "42", "to nowhere known"],
	]);
});

test("a held repeat is counted the same in a channel as in the chat", async () => {
	const held = createKit({ ...SPLIT, cooldownSeconds: { info: 60 } });
	const env = withMoney();
	const alert = { key: "purchase:p9", severity: "info", text: "Purchase", cooldown: 60, channel: "money" };
	assert.equal(await held.deliver(env, [alert], 1000), 1);
	assert.equal(await held.deliver(env, [alert], 1010), 0);
	assert.equal(await held.deliver(env, [alert], 1061), 1);
	assert.deepEqual(routes(), [
		["money-token", "77", "[info] Example Game: Purchase"],
		["money-token", "77", "[info] Example Game: Purchase (+1 held since the last)"],
	]);
});

test("a Roblox webhook is sent where the game says its kind goes", async () => {
	const env = withMoney();
	const post = (body) => call(env, `/roblox-alert?token=${TOKEN}`, { key: null, body, handler: split });
	assert.deepEqual(await post({ EventType: "TransactionRefunded", EventPayload: { Amount: 10 } }), {
		status: 200,
		body: { ok: true, sent: true },
	});
	await post({ EventType: "RightToErasureRequest", EventPayload: { UserId: 7, GameIds: [1] } });
	await post({ EventType: "SampleNotification", EventPayload: { UserId: 1 } });
	assert.deepEqual(
		routes().map(([bot, chat, text]) => [bot, chat, text.split("\n")[0]]),
		[
			["money-token", "77", "[roblox] Example Game: a refund (TransactionRefunded)"],
			["bot-token", "42", "[roblox] Example Game: right to erasure. Delete the data of user 7."],
			["bot-token", "42", "[roblox] Example Game: a test notification arrived (user 1). The webhook works."],
		],
	);
});

test("a webhook's kind is read off its type, and the kit says its channel", () => {
	const alert = { EventPayload: { AlertMessage: JSON.stringify({ summary: "fired", metric: "Memory" }) } };
	assert.deepEqual(
		[
			{ EventType: "RightToErasureRequest" },
			{ EventType: "SampleNotification" },
			{ EventType: "TransactionRefunded" },
			{ EventType: "refundIssued" },
			{ EventType: "SubscriptionPurchased" },
			{ EventType: "AnalyticsAlert", ...alert },
			{},
			null,
		].map(robloxKind),
		["erasure", "test", "refund", "refund", "event", "alert", "alert", "alert"],
	);
	assert.equal(splitKit.robloxWebhookChannel({ EventType: "TransactionRefunded" }), "money");
	assert.equal(splitKit.robloxWebhookChannel({ EventType: "SampleNotification" }), undefined);
	// A game that says nothing of kinds sends every webhook to the chat.
	assert.equal(createKit(CONFIG).robloxWebhookChannel({ EventType: "TransactionRefunded" }), undefined);
});

test("a config that names a channel wrongly fails when the Worker is made", () => {
	const wrong = (config, problem) =>
		assert.throws(() => createWorker(config), { message: `TelemetryBlox: ${problem}` });
	wrong(
		{ game: "x", alerts: { purchase: { severity: "info", channel: "money" } } },
		"the alert for purchase names a channel that `channels` does not hold: money",
	);
	wrong(
		{ game: "x", channels: { money: MONEY }, alerts: { purchase: { severity: "info", channel: "cash" } } },
		"the alert for purchase names a channel that `channels` does not hold: cash",
	);
	wrong({ game: "x", channels: { "two words": MONEY } }, "a channel's name must be a word: two words");
	wrong({ game: "x", channels: { money: { token: "T" } } }, "the channel money must name the secret of its chat");
	wrong(
		{ game: "x", channels: { money: { token: "", chat: "C" } } },
		"the channel money must name the secret of its token",
	);
	wrong({ game: "x", channels: { money: null } }, "the channel money must name the secret of its token");
	// Declared and unused is no fault: a game may send to it by hand.
	assert.equal(
		createKit({ game: "x", channels: { money: MONEY } }).config.channels.get("money").chat,
		"MONEY_CHAT_ID",
	);
});
