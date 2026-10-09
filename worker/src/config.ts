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
	/**
	 * Batches the ingest takes a minute, over every server. 1,200 by default. A compromised key or a
	 * game stuck in a posting loop would otherwise spend the day's written rows in minutes; the
	 * surplus is refused with a 429, which the pipe holds and posts again.
	 */
	maxBatchesPerMinute?: number;
	/**
	 * Batches the ingest takes from one server a minute. 60 by default: the shutdown drain retries
	 * every two seconds, and nothing in the pipe posts faster. Counted by the batch's job id.
	 */
	maxServerBatchesPerMinute?: number;
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
	digest: { events: string[]; text?: (day: DigestDay) => string } | null;
	retentionDays: number;
	maxRawEvents: number;
	nightlyHourUtc: number;
	environments: string[];
	maxBodyBytes: number;
	maxEvents: number;
	maxBatchesPerMinute: number;
	maxServerBatchesPerMinute: number;
	marks: Marks;
	robloxPrefix: (kind: RobloxKind) => string;
	channels: Map<string, ChannelNames>;
	robloxChannel: (kind: RobloxKind) => string | undefined;
	names: BindingNames;
	erasureHint?: (userId: string) => string;
}

export const DEFAULTS = {
	cooldownSeconds: { critical: 600, warning: 1800, info: 0 } as Record<Severity, number>,
	maxAlertsPerBatch: 8,
	retentionDays: 60,
	maxRawEvents: 2_000_000,
	nightlyHourUtc: 3,
	environments: ["live", "studio", "test"],
	maxBodyBytes: 1_000_000,
	maxEvents: 2000,
	maxBatchesPerMinute: 1200,
	maxServerBatchesPerMinute: 60,
	marks: {
		critical: "[critical]",
		warning: "[warning]",
		info: "[info]",
		digest: "[digest]",
		notice: "[notice]",
		roblox: "[roblox]",
		cut: "...",
	} as Marks,
	bindings: {
		database: "DB",
		ingestKey: "INGEST_KEY",
		telegramToken: "TELEGRAM_BOT_TOKEN",
		telegramChat: "TELEGRAM_CHAT_ID",
		webhookToken: "ALERT_TOKEN",
	} as BindingNames,
};

/** The scan binds three values a rule and D1 takes a hundred in a statement. */
export const MAX_SCAN_RULES = 30;

const WORD = /^[A-Za-z0-9_]+$/;

/** A field of a context, or undefined when there is no such context. */
export function field(ctx: unknown, name: string): unknown {
	return typeof ctx === "object" && ctx !== null ? (ctx as Record<string, unknown>)[name] : undefined;
}

/**
 * A value as a message says it: text as it is, anything else as JSON, cut at `limit` and ended with
 * `cut` when it was longer (a game's own mark is `marks.cut`).
 */
export function short(value: unknown, limit = 160, cut = DEFAULTS.marks.cut): string {
	const s = typeof value === "string" ? value : value === undefined ? "?" : JSON.stringify(value);
	return s.length > limit ? `${s.slice(0, limit)}${cut}` : s;
}

/** A player as a message names them: the pseudonym, shortened. */
export function who(actor: string | undefined): string {
	return actor ? actor.slice(0, 12) : "nobody";
}

function fail(problem: string): never {
	throw new Error(`TelemetryBlox: ${problem}`);
}

function positive(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
		fail(`\`${name}\` must be a positive number`);
	return value;
}

function seconds(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
		fail(`\`${name}\` must be zero or more seconds`);
	return value;
}

function rule(
	name: string,
	given: Severity | AlertRule,
	cooldown: Record<Severity, number>,
	cut: string,
	channels: Map<string, ChannelNames>,
): ResolvedRule {
	const from: AlertRule = typeof given === "string" ? { severity: given } : given;
	if (!(from.severity in cooldown)) fail(`the alert for ${name} has no such severity: ${String(from.severity)}`);
	if (from.channel !== undefined && !channels.has(from.channel))
		fail(`the alert for ${name} names a channel that \`channels\` does not hold: ${String(from.channel)}`);
	const per = from.per ?? "event";
	return {
		severity: from.severity,
		when: from.when ?? (() => true),
		kind:
			typeof per === "function"
				? (event) => `${name}:${per(event)}`
				: per === "actor"
					? (_event, actor) => `${name}:${actor}`
					: () => name,
		text:
			from.text ??
			((event, actor) => `${name}: ${short(event.ctx, 160, cut)}${event.actor ? `, player ${actor}` : ""}`),
		cooldown: seconds(from.cooldownSeconds, cooldown[from.severity], `alerts.${name}.cooldownSeconds`),
		channel: from.channel,
	};
}

/** Checks a game's config and fills the defaults. Throws on the first thing that is wrong. */
export function resolve(config: WorkerConfig): Resolved {
	if (typeof config.game !== "string" || config.game === "") fail("`game` must be a non-empty string");
	const cooldown: Record<Severity, number> = {
		critical: seconds(
			config.cooldownSeconds?.critical,
			DEFAULTS.cooldownSeconds.critical,
			"cooldownSeconds.critical",
		),
		warning: seconds(config.cooldownSeconds?.warning, DEFAULTS.cooldownSeconds.warning, "cooldownSeconds.warning"),
		info: seconds(config.cooldownSeconds?.info, DEFAULTS.cooldownSeconds.info, "cooldownSeconds.info"),
	};
	const marks: Marks = { ...DEFAULTS.marks, ...config.marks };
	const channels = new Map<string, ChannelNames>();
	for (const [name, given] of Object.entries(config.channels ?? {})) {
		if (!WORD.test(name)) fail(`a channel's name must be a word: ${name}`);
		for (const part of ["token", "chat"] as const) {
			if (typeof given?.[part] !== "string" || given[part] === "")
				fail(`the channel ${name} must name the secret of its ${part}`);
		}
		channels.set(name, { token: given.token, chat: given.chat });
	}
	const rules = new Map<string, ResolvedRule>();
	for (const [name, given] of Object.entries(config.alerts ?? {})) {
		rules.set(name, rule(name, given, cooldown, marks.cut, channels));
	}

	const scan = config.scan ?? [];
	if (scan.length > MAX_SCAN_RULES) fail(`\`scan\` holds ${scan.length} rules; ${MAX_SCAN_RULES} is the most`);
	const seen = new Set<string>();
	for (const item of scan) {
		if (!WORD.test(item.name) || seen.has(item.name))
			fail(`a scan rule's name must be a word of its own: ${item.name}`);
		seen.add(item.name);
		if (typeof item.event !== "string" || item.event === "") fail(`the scan rule ${item.name} names no event`);
		if (!["rows", "sum", "max"].includes(item.measure)) fail(`the scan rule ${item.name} has no such measure`);
		if (item.measure !== "rows" && !WORD.test(item.field ?? "")) {
			fail(`the scan rule ${item.name} needs a \`field\` to ${item.measure}`);
		}
		if (typeof item.limit !== "number" || !Number.isFinite(item.limit))
			fail(`the scan rule ${item.name} has no limit`);
	}

	const nightly = config.nightlyHourUtc ?? DEFAULTS.nightlyHourUtc;
	if (!Number.isInteger(nightly) || nightly < 0 || nightly > 23) fail("`nightlyHourUtc` must be an hour, 0 to 23");
	const environments = config.environments ?? DEFAULTS.environments;
	if (!environments.includes("live")) fail('`environments` must hold "live"');

	return {
		game: config.game,
		tag: config.tag ?? config.game,
		rules,
		cooldown,
		maxAlerts: positive(config.maxAlertsPerBatch, DEFAULTS.maxAlertsPerBatch, "maxAlertsPerBatch"),
		scan,
		digest:
			config.digest === false
				? null
				: { events: config.digest?.events ?? [...rules.keys()], text: config.digest?.text },
		retentionDays: positive(config.retentionDays, DEFAULTS.retentionDays, "retentionDays"),
		maxRawEvents: positive(config.maxRawEvents, DEFAULTS.maxRawEvents, "maxRawEvents"),
		nightlyHourUtc: nightly,
		environments,
		maxBodyBytes: positive(config.maxBodyBytes, DEFAULTS.maxBodyBytes, "maxBodyBytes"),
		maxEvents: positive(config.maxEvents, DEFAULTS.maxEvents, "maxEvents"),
		maxBatchesPerMinute: positive(config.maxBatchesPerMinute, DEFAULTS.maxBatchesPerMinute, "maxBatchesPerMinute"),
		maxServerBatchesPerMinute: positive(
			config.maxServerBatchesPerMinute,
			DEFAULTS.maxServerBatchesPerMinute,
			"maxServerBatchesPerMinute",
		),
		marks,
		robloxPrefix: config.robloxPrefix ?? (() => `${marks.roblox} ${config.game}:`),
		channels,
		robloxChannel: config.robloxChannel ?? (() => undefined),
		names: { ...DEFAULTS.bindings, ...config.bindings },
		erasureHint: config.erasureHint,
	};
}

/** The Worker's environment: the bindings and secrets, under whatever names the game gave them. */
export type Env = Record<string, unknown>;

/** The game's D1 database. Throws when the binding is not there: the config and wrangler disagree. */
export function database(env: Env, config: Resolved): D1Database {
	const db = env[config.names.database];
	if (typeof db !== "object" || db === null) fail(`no D1 binding called ${config.names.database}`);
	return db as D1Database;
}

/** A secret's value, or an empty string when it is not set. */
export function secret(env: Env, name: string): string {
	const value = env[name];
	return typeof value === "string" ? value : "";
}
