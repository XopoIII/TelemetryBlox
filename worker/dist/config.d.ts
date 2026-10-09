/**
 * What a game hands in, once, and what the Worker makes of it.
 *
 * Everything that is a game's own is here and nowhere else in the kit: its name, which of its
 * events are worth a message and how grave each is, how long a repeat is held, what one player may
 * do in an hour before somebody is told, how long raw rows are kept, and what its bindings and
 * secrets are called. The kit names no event of its own.
 */
export type Severity = "critical" | "warning" | "info";
/** One event of a batch, as an alert rule sees it. */
export interface SeenEvent {
    event: string;
    /** The player's pseudonym, when the row is about a player. */
    actor?: string;
    ctx: Record<string, unknown>;
}
/** How one event becomes an alert. */
export interface AlertRule {
    severity: Severity;
    /** Whether this row asks for the alert at all. Absent: every row of the event does. */
    when?: (event: SeenEvent) => boolean;
    /**
     * What a repeat is counted by: "event" (the default: one alert a kind), "actor" (one a player),
     * or a function that names the kind itself (an error's script and message, say).
     */
    per?: "event" | "actor" | ((event: SeenEvent) => string);
    /** The message. `who` is the pseudonym, shortened. Absent: the event's name and its context. */
    text?: (event: SeenEvent, who: string) => string;
    /** Seconds a repeat is held, in place of the severity's. 0: never held. */
    cooldownSeconds?: number;
    /** The channel of `channels` this alert is sent to. Absent: the chat. */
    channel?: string;
}
/**
 * Another chat of the game's, by what its two secrets are called: a bot's token and a chat's id.
 * The values are secrets of the Worker, as the chat's own are.
 */
export interface ChannelNames {
    token: string;
    chat: string;
}
/** One thing the hourly scan counts for each player, and the count that is worth a message. */
export interface ScanRule {
    /** Names the finding in its alert's key (`anomaly:<name>:<who>`). Letters, digits, `_`. */
    name: string;
    /** The event counted. */
    event: string;
    /** "rows": how many rows. "sum": the total of `field`. "max": the largest `field`. */
    measure: "rows" | "sum" | "max";
    /** The context field read by "sum" and "max". Letters, digits, `_`. */
    field?: string;
    /** What a row without the field adds to a "sum". 0 by default. */
    missing?: number;
    /** A player at or above this is told of. */
    limit: number;
    /** "warning" by default. */
    severity?: Severity;
    /** The message. Absent: the rule's name, the value and the limit. */
    text?: (value: number, who: string) => string;
}
/** Yesterday, as the nightly digest's own text function is given it. */
export interface DigestDay {
    /** Distinct players across every event. */
    players: number;
    /** Every row of the day. */
    rows: number;
    /** Rows of one of the listed events. */
    count: (event: string) => number;
}
export interface DigestConfig {
    /** The events counted in the message. Absent: the events of the alert table. */
    events?: string[];
    /** The message, in place of the default lines. */
    text?: (day: DigestDay) => string;
}
/** What each binding and secret is called in the game's wrangler config. */
export interface BindingNames {
    /** The D1 database. "DB" by default. */
    database: string;
    /** The ingest key. "INGEST_KEY" by default. */
    ingestKey: string;
    /** The Telegram bot's token. "TELEGRAM_BOT_TOKEN" by default. */
    telegramToken: string;
    /** The Telegram chat's id. "TELEGRAM_CHAT_ID" by default. */
    telegramChat: string;
    /** The token in the URL Roblox's webhooks post to. "ALERT_TOKEN" by default. */
    webhookToken: string;
}
/** What starts each kind of message. Plain text by default; a game may put its own marks here. */
export interface Marks {
    critical: string;
    warning: string;
    info: string;
    digest: string;
    notice: string;
    roblox: string;
    /** What ends a value that was cut short. Three dots by default. */
    cut: string;
}
/**
 * What a Roblox webhook turned out to be: a right-to-erasure request, the dashboard's Test button,
 * a refund, any other named event, or an analytics alert (and anything unrecognised).
 */
export type RobloxKind = "erasure" | "test" | "refund" | "event" | "alert";
export interface WorkerConfig {
    /** The game's name, said in every message. A batch tagged for another game is refused. */
    game: string;
    /** The game's tag as its server says it in a batch, when that is not `game`. */
    tag?: string;
    /** Event name to weight, or to a rule. An event outside the table sends nothing. */
    alerts?: Record<string, Severity | AlertRule>;
    /** Seconds a repeat of each weight is held. Critical 600, warning 1800, info 0 (never held). */
    cooldownSeconds?: Partial<Record<Severity, number>>;
    /** Alerts one batch, or one scan, may send. 8 by default: each is a query and a row written. */
    maxAlertsPerBatch?: number;
    /** The hourly scan's thresholds. None by default: the scan then only moves its cursor. */
    scan?: ScanRule[];
    /** The nightly digest. `false`: none is sent. */
    digest?: DigestConfig | false;
    /** Days raw batches are kept. 60 by default. */
    retentionDays?: number;
    /**
     * Days an alert's cool-down state is kept after it last went. 7 by default: a key quiet for
     * that long starts over, and its row is dropped with the night.
     */
    alertStateDays?: number;
    /** Raw events kept whatever their age. 2,000,000 by default, about 300 MB. */
    maxRawEvents?: number;
    /** The UTC hour whose run is also the nightly one. 3 by default. */
    nightlyHourUtc?: number;
    /** The environments a batch may name. Only "live" alerts. "live", "studio", "test" by default. */
    environments?: string[];
    /** Bytes a body may be. 1,000,000 by default. */
    maxBodyBytes?: number;
    /** Events a batch may hold. 2000 by default. */
    maxEvents?: number;
    marks?: Partial<Marks>;
    /**
     * What starts the message of a Roblox webhook, by its kind, in place of `marks.roblox` and the
     * game's name: a game may mark an obligation (an erasure) apart from a notice.
     */
    robloxPrefix?: (kind: RobloxKind) => string;
    /**
     * More chats than the one, by name: a game may keep its purchases apart from its faults. An
     * alert rule or a webhook kind that names one is sent there; everything else goes to the chat.
     * A channel whose secrets are not set sends to the chat, so a message is never lost to it.
     */
    channels?: Record<string, ChannelNames>;
    /** The channel a Roblox webhook of a kind is sent to. Absent, or nothing for a kind: the chat. */
    robloxChannel?: (kind: RobloxKind) => string | undefined;
    bindings?: Partial<BindingNames>;
    /** The line a right-to-erasure message ends with: what to run for this user. */
    erasureHint?: (userId: string) => string;
}
export interface ResolvedRule {
    severity: Severity;
    when: (event: SeenEvent) => boolean;
    kind: (event: SeenEvent, who: string) => string;
    text: (event: SeenEvent, who: string) => string;
    cooldown: number;
    channel?: string;
}
export interface Resolved {
    game: string;
    tag: string;
    rules: Map<string, ResolvedRule>;
    cooldown: Record<Severity, number>;
    maxAlerts: number;
    scan: ScanRule[];
    digest: {
        events: string[];
        text?: (day: DigestDay) => string;
    } | null;
    retentionDays: number;
    alertStateDays: number;
    maxRawEvents: number;
    nightlyHourUtc: number;
    environments: string[];
    maxBodyBytes: number;
    maxEvents: number;
    marks: Marks;
    robloxPrefix: (kind: RobloxKind) => string;
    channels: Map<string, ChannelNames>;
    robloxChannel: (kind: RobloxKind) => string | undefined;
    names: BindingNames;
    erasureHint?: (userId: string) => string;
}
export declare const DEFAULTS: {
    cooldownSeconds: Record<Severity, number>;
    maxAlertsPerBatch: number;
    retentionDays: number;
    alertStateDays: number;
    maxRawEvents: number;
    nightlyHourUtc: number;
    environments: string[];
    maxBodyBytes: number;
    maxEvents: number;
    marks: Marks;
    bindings: BindingNames;
};
/** The scan binds three values a rule and D1 takes a hundred in a statement. */
export declare const MAX_SCAN_RULES = 30;
/** A field of a context, or undefined when there is no such context. */
export declare function field(ctx: unknown, name: string): unknown;
/**
 * A value as a message says it: text as it is, anything else as JSON, cut at `limit` and ended with
 * `cut` when it was longer (a game's own mark is `marks.cut`).
 */
export declare function short(value: unknown, limit?: number, cut?: string): string;
/** A player as a message names them: the pseudonym, shortened. */
export declare function who(actor: string | undefined): string;
/** Checks a game's config and fills the defaults. Throws on the first thing that is wrong. */
export declare function resolve(config: WorkerConfig): Resolved;
/** The Worker's environment: the bindings and secrets, under whatever names the game gave them. */
export type Env = Record<string, unknown>;
/** The game's D1 database. Throws when the binding is not there: the config and wrangler disagree. */
export declare function database(env: Env, config: Resolved): D1Database;
/** A secret's value, or an empty string when it is not set. */
export declare function secret(env: Env, name: string): string;
