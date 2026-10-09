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
import { type Alert, type BatchMeta } from "./alerts.js";
import { type Env, type Resolved, type SeenEvent, type WorkerConfig } from "./config.js";
export type { Alert, BatchMeta } from "./alerts.js";
export type { AlertRule, BindingNames, ChannelNames, DigestConfig, DigestDay, Env, Marks, Resolved, RobloxKind, ScanRule, SeenEvent, Severity, WorkerConfig, } from "./config.js";
export { DEFAULTS, field, MAX_SCAN_RULES, short, who } from "./config.js";
export { SCHEMA_VERSION } from "./ingest.js";
export { robloxAlertText, robloxKind } from "./roblox.js";
/** The Worker's parts over one game's config, for a game's own tests and tools. */
export interface Kit {
    /** The config, checked, with its defaults filled. */
    config: Resolved;
    /** The alerts a batch asks for, gravest first. */
    alertsFor: (events: SeenEvent[], meta: BatchMeta) => Alert[];
    /** Sends the alerts their cool-downs allow. Returns how many went. */
    deliver: (env: Env, alerts: Alert[], now?: number) => Promise<number>;
    /** One message to the chat, or to `channel` of the game's `channels`. */
    send: (env: Env, message: string, channel?: string) => Promise<boolean>;
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
    /** The channel a Roblox webhook's body is sent to, by the game's `robloxChannel`; undefined: the chat. */
    robloxWebhookChannel: (body: unknown) => string | undefined;
}
/** Checks a game's config (it throws on a wrong one, when the Worker loads) and binds the parts to it. */
export declare function createKit(given: WorkerConfig): Kit;
/** A game's Worker: what its `src/index.ts` exports as default. */
export declare function createWorker(given: WorkerConfig): ExportedHandler<Env>;
