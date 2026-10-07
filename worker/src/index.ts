/**
 * TelemetryBlox's Worker: the ingest for the batches a game server's pipe posts, and the sender of
 * its alerts. Reusable code; each game deploys it as a project of its own (its own Worker name, its
 * own D1 database, its own secrets), and a game's whole Worker is a few lines:
 *
 *     import { createWorker } from "telemetryblox";
 *
 *     export default createWorker({
 *         game: "example",
 *         alerts: { server_error: "critical", purchase: "info" },
 *         retentionDays: 60,
 *     });
 *
 * One cron trigger, every hour: Cloudflare's free plan allows five an account. Every run is the
 * hourly scan; the run in `nightlyHourUtc` is also the nightly retention and yesterday's digest.
 *
 * The doors:
 *   POST /ingest            a batch, with the ingest key in `x-api-key`
 *   GET  /health            the Worker is up; `?deep=1` with the key: how fresh the live data is
 *   GET  /retention         the nightly job, by hand, with the key (it deletes rows)
 *   GET  /anomalies         the hourly scan, by hand, with the key
 *   POST /notify            a line from the game's own tools (`{"text": "..."}`), with the key
 *   POST /roblox-alert      Roblox's webhooks, with the webhook token in `?token=`
 */

import { type Alert, alertsFor, type BatchMeta, deliver, pruneAlertState, send } from "./alerts.js";
import { type Env, type Resolved, resolve, type SeenEvent, secret, type WorkerConfig } from "./config.js";
import { asText, authorised, ingest, json, secretsMatch } from "./ingest.js";
import { freshness, retention } from "./retention.js";
import { robloxWebhookText } from "./roblox.js";
import { anomalies, digest } from "./scan.js";

export type { Alert, BatchMeta } from "./alerts.js";
export type {
	AlertRule,
	BindingNames,
	DigestConfig,
	DigestDay,
	Env,
	Marks,
	Resolved,
	RobloxKind,
	ScanRule,
	SeenEvent,
	Severity,
	WorkerConfig,
} from "./config.js";
export { DEFAULTS, field, MAX_SCAN_RULES, short, who } from "./config.js";
export { robloxAlertText } from "./roblox.js";

/** The Worker's parts over one game's config, for a game's own tests and tools. */
export interface Kit {
	/** The config, checked, with its defaults filled. */
	config: Resolved;
	/** The alerts a batch asks for, gravest first. */
	alertsFor: (events: SeenEvent[], meta: BatchMeta) => Alert[];
	/** Sends the alerts their cool-downs allow. Returns how many went. */
	deliver: (env: Env, alerts: Alert[], now?: number) => Promise<number>;
	/** One message to the chat. */
	send: (env: Env, message: string) => Promise<boolean>;
	/** The hourly scan. */
	anomalies: (env: Env) => Promise<Record<string, unknown>>;
	/** Yesterday's digest. */
	digest: (env: Env) => Promise<boolean>;
	/** The nightly roll-up and pruning. */
	retention: (env: Env) => Promise<Record<string, unknown>>;
	/** Whether the run scheduled at `scheduledTime` (ms) is the nightly one. */
	isNightly: (scheduledTime: number) => boolean;
	/** What a Roblox webhook's body says, as a message. */
	robloxWebhookText: (body: unknown) => string;
}

/** Checks a game's config (it throws on a wrong one, when the Worker loads) and binds the parts to it. */
export function createKit(given: WorkerConfig): Kit {
	const config = resolve(given);
	return {
		config,
		alertsFor: (events, meta) => alertsFor(config, events, meta),
		deliver: (env, alerts, now) => deliver(config, env, alerts, now),
		send: (env, message) => send(config, env, message),
		anomalies: (env) => anomalies(config, env),
		digest: (env) => digest(config, env),
		retention: (env) => retention(config, env),
		isNightly: (scheduledTime) => new Date(scheduledTime).getUTCHours() === config.nightlyHourUtc,
		robloxWebhookText: (body) => robloxWebhookText(config, body),
	};
}

function logged(message: string) {
	return (error: unknown) => console.error(JSON.stringify({ message, error: String(error) }));
}

/** A game's Worker: what its `src/index.ts` exports as default. */
export function createWorker(given: WorkerConfig): ExportedHandler<Env> {
	const kit = createKit(given);
	const { config } = kit;

	async function route(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Roblox's webhooks: an analytics alert, a refund, a right-to-erasure request. The token is in
		// the URL because that is all Roblox lets a game set; it is not the ingest key.
		if (url.pathname === "/roblox-alert") {
			const expected = secret(env, config.names.webhookToken);
			if (!(await secretsMatch(url.searchParams.get("token"), expected)))
				return json({ error: "unauthorized" }, 401);
			if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
			const body = await request.json().catch(() => null);
			return json({ ok: true, sent: await kit.send(env, kit.robloxWebhookText(body)) });
		}
		if (url.pathname === "/health" && url.searchParams.get("deep") !== "1") return json({ ok: true });
		if (!["/ingest", "/health", "/retention", "/anomalies", "/notify"].includes(url.pathname)) {
			return json({ error: "not_found" }, 404);
		}
		if (url.pathname === "/ingest") {
			if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
			return ingest(config, request, env, ctx);
		}

		// Every other door needs the key: they read the data, delete rows or write to the chat.
		if (!(await authorised(config, request, env))) return json({ error: "unauthorized" }, 401);
		// `?deep=1`: is anything ARRIVING? The plain answer only says the Worker is up, which it is
		// while every batch is refused.
		if (url.pathname === "/health") return json(await freshness(config, env));
		if (url.pathname === "/retention") return json(await kit.retention(env));
		if (url.pathname === "/anomalies") return json(await kit.anomalies(env));
		// A notice from the game's own tools (a publish). `text` is said as it is, shortened.
		if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
		const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
		const said = asText(body?.text);
		if (!said) return json({ error: "text must be a string" }, 400);
		return json({
			ok: true,
			sent: await kit.send(env, `${config.marks.notice} ${config.game}: ${said.slice(0, 1000)}`),
		});
	}

	return {
		async scheduled(event, env, ctx) {
			const hourly = kit.anomalies(env).catch(logged("anomalies_failed"));
			if (!kit.isNightly(event.scheduledTime)) {
				ctx.waitUntil(hourly);
				return;
			}
			// The digest reads the roll-up, so it follows the retention that makes it.
			ctx.waitUntil(
				hourly
					.then(() => kit.retention(env))
					.then(() => kit.digest(env))
					.then(() => pruneAlertState(config, env))
					.catch(logged("nightly_failed")),
			);
		},

		async fetch(request, env, ctx) {
			try {
				return await route(request, env, ctx);
			} catch (error) {
				// Explicit, never passed through: an unhandled throw here would be invisible.
				console.error(
					JSON.stringify({
						message: "unhandled",
						path: new URL(request.url).pathname,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
				return json({ error: "internal" }, 500);
			}
		},
	};
}
