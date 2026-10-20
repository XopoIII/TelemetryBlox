/**
 * Alerts to Telegram: what the owner should hear of without opening a query.
 *
 * The Worker sends, the game does not: a row arrives with a batch and the game's alert table says
 * whether it is worth a message. Only a live batch asks for any; Studio's and a test place's rows
 * are a developer's own doing.
 *
 * Quiet by rule. Each kind of alert has a cool-down; a repeat inside it is held and counted, and the
 * next one past it says how many were held. A kind with a burst is sent only once enough of its rows
 * came inside its window. A batch sends a handful at most.
 *
 * Nothing here may break the ingest: every path catches, and a batch is stored before an alert is
 * thought about. The free plan again: an alert costs one D1 query and one row written.
 */

import { type Burst, database, type Env, type Resolved, type SeenEvent, type Severity, secret, who } from "./config.js";

export interface Alert {
	/** What a repeat is counted by: the same key inside its cool-down is held, not sent. */
	key: string;
	severity: Severity;
	text: string;
	/** Seconds the key stays quiet after it was sent. 0: never held. */
	cooldown: number;
	/** The channel it is sent to. Absent: the chat. */
	channel?: string;
	/** Sent only once this many rows came inside its window (`AlertRule.burst`). */
	burst?: Burst;
	/** How many rows of the batch stand behind it: what a burst counts. 1 when left out. */
	rows?: number;
}

export interface BatchMeta {
	env: string;
	placeVersion: number | null;
	jobId: string;
}

const ORDER: Severity[] = ["critical", "warning", "info"];

/** The gravest first; alerts of one weight keep their order. */
export function bySeverity(alerts: Alert[]): Alert[] {
	return [...alerts].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
}

/**
 * The alerts a batch asks for, gravest first, one for each key with how many events stood behind
 * it. An event outside the game's table asks for none, and so does any batch that is not live.
 */
export function alertsFor(config: Resolved, events: SeenEvent[], meta: BatchMeta): Alert[] {
	if (meta.env !== "live") return [];
	const byKey = new Map<string, { alert: Alert; n: number }>();
	for (const event of events) {
		const rule = config.rules.get(event.event);
		if (!rule) continue;
		let alert: Alert;
		try {
			if (!rule.when(event)) continue;
			const actor = who(event.actor);
			alert = {
				key: rule.kind(event, actor),
				severity: rule.severity,
				text: rule.text(event, actor),
				cooldown: rule.cooldown,
				...(rule.channel === undefined ? {} : { channel: rule.channel }),
				...(rule.burst === undefined ? {} : { burst: rule.burst }),
			};
		} catch (error) {
			// A game's rule that throws on a row it did not expect costs that alert, not the batch.
			console.error(JSON.stringify({ message: "alert_rule_failed", event: event.event, error: String(error) }));
			continue;
		}
		const seen = byKey.get(alert.key);
		if (seen) seen.n++;
		else byKey.set(alert.key, { alert, n: 1 });
	}
	return bySeverity(
		[...byKey.values()].map(({ alert, n }) => ({
			...alert,
			text: `${alert.text}${n > 1 ? ` (x${n})` : ""} [v${meta.placeVersion ?? "?"}]`,
			...(alert.burst === undefined ? {} : { rows: n }),
		})),
	);
}

/**
 * Whether `key` may be sent now, and how many of it were held since it last was. One statement:
 * a key inside its cool-down counts one more held and keeps its time; one past it takes `now` and
 * hands its count over in `released`. Every right-hand side reads the row as it was.
 */
const GATE_SQL = `INSERT INTO alert_state (key, sent_at, held, released) VALUES (?1, ?2, 0, 0)
	ON CONFLICT(key) DO UPDATE SET
		released = CASE WHEN ?2 - sent_at < ?3 THEN 0 ELSE held END,
		held     = CASE WHEN ?2 - sent_at < ?3 THEN held + 1 ELSE 0 END,
		sent_at  = CASE WHEN ?2 - sent_at < ?3 THEN sent_at ELSE ?2 END
	RETURNING held, released`;

/** How many were held when the alert may go (0 for a kind that is never held); null when it may not. */
async function gate(config: Resolved, env: Env, alert: Alert, now: number): Promise<number | null> {
	if (alert.cooldown <= 0) return 0;
	const row = await database(env, config)
		.prepare(GATE_SQL)
		.bind(alert.key, now, alert.cooldown)
		.first<{ held: number; released: number }>();
	// A key that was sent has nothing held; one that was held has at least this one. Its time cannot
	// tell them apart: a repeat in the same second carries the same `sent_at` as the one that went.
	return row && row.held === 0 ? row.released : null;
}

/**
 * A burst's window, kept in `alert_state` beside the cool-downs under its own key: `sent_at` is
 * when the window began and `held` how many rows came in it; `released` hands back what it held
 * before this batch. A window past its seconds starts again with this batch's rows. One statement,
 * and every right-hand side reads the row as it was.
 */
const BURST_SQL = `INSERT INTO alert_state (key, sent_at, held, released) VALUES (?1, ?2, ?3, 0)
	ON CONFLICT(key) DO UPDATE SET
		released = CASE WHEN ?2 - sent_at < ?4 THEN held ELSE 0 END,
		held     = CASE WHEN ?2 - sent_at < ?4 THEN held + ?3 ELSE ?3 END,
		sent_at  = CASE WHEN ?2 - sent_at < ?4 THEN sent_at ELSE ?2 END
	RETURNING held, released`;

/**
 * How many rows the window holds when this batch's take it to the burst's count, so the alert may
 * go on; null below the count, and past it, so a window sends once.
 */
async function burstGate(config: Resolved, env: Env, alert: Alert, burst: Burst, now: number): Promise<number | null> {
	const row = await database(env, config)
		.prepare(BURST_SQL)
		.bind(`burst:${alert.key}`, now, Math.max(1, alert.rows ?? 1), burst.seconds)
		.first<{ held: number; released: number }>();
	return row && row.released < burst.count && row.held >= burst.count ? row.held : null;
}

/**
 * The bot's token and the chat's id a message for `channel` goes with: the channel's own when both
 * of its secrets are set, the chat's otherwise. A channel the game named and has not set up yet is
 * said in the log, by its name alone, and its messages still arrive.
 */
function addressOf(config: Resolved, env: Env, channel?: string): { token?: string; chat?: string } {
	const named = channel === undefined ? undefined : config.channels.get(channel);
	if (named) {
		const token = secret(env, named.token);
		const chat = secret(env, named.chat);
		if (token && chat) return { token, chat };
		console.log(JSON.stringify({ message: "alert_channel_unconfigured", channel }));
	}
	return { token: secret(env, config.names.telegramToken), chat: secret(env, config.names.telegramChat) };
}

/**
 * One message to the chat, or to `channel` of the game's `channels`. False when it did not go, for
 * whatever reason; never throws. Without the bot's token and the chat's id the message is written
 * to the Worker's log and nothing else happens: both are secrets of the Worker and are never in
 * code. A channel nobody declared is the chat.
 */
export async function send(config: Resolved, env: Env, message: string, channel?: string): Promise<boolean> {
	const { token, chat } = addressOf(config, env, channel);
	if (!token || !chat) {
		console.log(JSON.stringify({ message: "alert_unconfigured", text: message }));
		return false;
	}
	try {
		const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chat_id: chat, text: message.slice(0, 4000), disable_web_page_preview: true }),
		});
		if (!response.ok) {
			console.error(JSON.stringify({ message: "alert_send_failed", status: response.status }));
			return false;
		}
		return true;
	} catch (error) {
		// The error's own text is not logged: a fetch failure may quote the URL, and the URL holds the token.
		console.error(
			JSON.stringify({ message: "alert_send_failed", error: error instanceof Error ? error.name : "error" }),
		);
		return false;
	}
}

/** Sends the alerts their cool-downs allow, `maxAlerts` of them at most. Returns how many went. */
export async function deliver(
	config: Resolved,
	env: Env,
	alerts: Alert[],
	now = Math.floor(Date.now() / 1000),
): Promise<number> {
	let sent = 0;
	try {
		for (const alert of alerts.slice(0, config.maxAlerts)) {
			let crowd = "";
			if (alert.burst) {
				const seen = await burstGate(config, env, alert, alert.burst, now);
				if (seen === null) continue;
				crowd = ` (${seen} within ${alert.burst.seconds} s)`;
			}
			const released = await gate(config, env, alert, now);
			if (released === null) continue;
			const held = released > 0 ? ` (+${released} held since the last)` : "";
			const said = `${config.marks[alert.severity]} ${config.game}: ${alert.text}${crowd}${held}`;
			if (await send(config, env, said, alert.channel)) sent++;
		}
	} catch (error) {
		console.error(
			JSON.stringify({
				message: "alert_deliver_failed",
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	}
	return sent;
}

/** Old cool-down rows, dropped nightly: a key not sent for `alertStateDays` starts over, and so does
 * a burst whose window began that long ago. */
export async function pruneAlertState(config: Resolved, env: Env): Promise<void> {
	await database(env, config)
		.prepare(`DELETE FROM alert_state WHERE sent_at < unixepoch('now', ?1)`)
		.bind(`-${config.alertStateDays} days`)
		.run();
}
