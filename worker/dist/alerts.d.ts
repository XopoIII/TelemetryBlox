/**
 * Alerts to Telegram: what the owner should hear of without opening a query.
 *
 * The Worker sends, the game does not: a row arrives with a batch and the game's alert table says
 * whether it is worth a message. Only a live batch asks for any; Studio's and a test place's rows
 * are a developer's own doing.
 *
 * Quiet by rule. Each kind of alert has a cool-down; a repeat inside it is held and counted, and the
 * next one past it says how many were held. A batch sends a handful at most.
 *
 * Nothing here may break the ingest: every path catches, and a batch is stored before an alert is
 * thought about. The free plan again: an alert costs one D1 query and one row written.
 */
import { type Env, type Resolved, type SeenEvent, type Severity } from "./config.js";
export interface Alert {
    /** What a repeat is counted by: the same key inside its cool-down is held, not sent. */
    key: string;
    severity: Severity;
    text: string;
    /** Seconds the key stays quiet after it was sent. 0: never held. */
    cooldown: number;
}
export interface BatchMeta {
    env: string;
    placeVersion: number | null;
    jobId: string;
}
/** The gravest first; alerts of one weight keep their order. */
export declare function bySeverity(alerts: Alert[]): Alert[];
/**
 * The alerts a batch asks for, gravest first, one for each key with how many events stood behind
 * it. An event outside the game's table asks for none, and so does any batch that is not live.
 */
export declare function alertsFor(config: Resolved, events: SeenEvent[], meta: BatchMeta): Alert[];
/**
 * One message to the chat. False when it did not go, for whatever reason; never throws. Without
 * the bot's token and the chat's id the message is written to the Worker's log and nothing else
 * happens: both are secrets of the Worker and are never in code.
 */
export declare function send(config: Resolved, env: Env, message: string): Promise<boolean>;
/** Sends the alerts their cool-downs allow, `maxAlerts` of them at most. Returns how many went. */
export declare function deliver(config: Resolved, env: Env, alerts: Alert[], now?: number): Promise<number>;
/** Old cool-down rows, dropped nightly: a key not sent for a week starts over. */
export declare function pruneAlertState(config: Resolved, env: Env): Promise<void>;
