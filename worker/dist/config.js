/**
 * What a game hands in, once, and what the Worker makes of it.
 *
 * Everything that is a game's own is here and nowhere else in the kit: its name, which of its
 * events are worth a message and how grave each is, how long a repeat is held, what one player may
 * do in an hour before somebody is told, how long raw rows are kept, and what its bindings and
 * secrets are called. The kit names no event of its own.
 */
export const DEFAULTS = {
    cooldownSeconds: { critical: 600, warning: 1800, info: 0 },
    maxAlertsPerBatch: 8,
    retentionDays: 60,
    maxRawEvents: 2_000_000,
    nightlyHourUtc: 3,
    environments: ["live", "studio", "test"],
    maxBodyBytes: 1_000_000,
    maxEvents: 2000,
    marks: {
        critical: "[critical]",
        warning: "[warning]",
        info: "[info]",
        digest: "[digest]",
        notice: "[notice]",
        roblox: "[roblox]",
    },
    bindings: {
        database: "DB",
        ingestKey: "INGEST_KEY",
        telegramToken: "TELEGRAM_BOT_TOKEN",
        telegramChat: "TELEGRAM_CHAT_ID",
        webhookToken: "ALERT_TOKEN",
    },
};
/** The scan binds three values a rule and D1 takes a hundred in a statement. */
export const MAX_SCAN_RULES = 30;
const WORD = /^[A-Za-z0-9_]+$/;
/** A field of a context, or undefined when there is no such context. */
export function field(ctx, name) {
    return typeof ctx === "object" && ctx !== null ? ctx[name] : undefined;
}
/** A value as a message says it: text as it is, anything else as JSON, cut at `limit`. */
export function short(value, limit = 160) {
    const s = typeof value === "string" ? value : value === undefined ? "?" : JSON.stringify(value);
    return s.length > limit ? `${s.slice(0, limit)}...` : s;
}
/** A player as a message names them: the pseudonym, shortened. */
export function who(actor) {
    return actor ? actor.slice(0, 12) : "nobody";
}
function fail(problem) {
    throw new Error(`TelemetryBlox: ${problem}`);
}
function positive(value, fallback, name) {
    if (value === undefined)
        return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
        fail(`\`${name}\` must be a positive number`);
    return value;
}
function seconds(value, fallback, name) {
    if (value === undefined)
        return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        fail(`\`${name}\` must be zero or more seconds`);
    return value;
}
function rule(name, given, cooldown) {
    const from = typeof given === "string" ? { severity: given } : given;
    if (!(from.severity in cooldown))
        fail(`the alert for ${name} has no such severity: ${String(from.severity)}`);
    const per = from.per ?? "event";
    return {
        severity: from.severity,
        when: from.when ?? (() => true),
        kind: typeof per === "function"
            ? (event) => `${name}:${per(event)}`
            : per === "actor"
                ? (_event, actor) => `${name}:${actor}`
                : () => name,
        text: from.text ?? ((event, actor) => `${name}: ${short(event.ctx)}${event.actor ? `, player ${actor}` : ""}`),
        cooldown: seconds(from.cooldownSeconds, cooldown[from.severity], `alerts.${name}.cooldownSeconds`),
    };
}
/** Checks a game's config and fills the defaults. Throws on the first thing that is wrong. */
export function resolve(config) {
    if (typeof config.game !== "string" || config.game === "")
        fail("`game` must be a non-empty string");
    const cooldown = {
        critical: seconds(config.cooldownSeconds?.critical, DEFAULTS.cooldownSeconds.critical, "cooldownSeconds.critical"),
        warning: seconds(config.cooldownSeconds?.warning, DEFAULTS.cooldownSeconds.warning, "cooldownSeconds.warning"),
        info: seconds(config.cooldownSeconds?.info, DEFAULTS.cooldownSeconds.info, "cooldownSeconds.info"),
    };
    const rules = new Map();
    for (const [name, given] of Object.entries(config.alerts ?? {}))
        rules.set(name, rule(name, given, cooldown));
    const scan = config.scan ?? [];
    if (scan.length > MAX_SCAN_RULES)
        fail(`\`scan\` holds ${scan.length} rules; ${MAX_SCAN_RULES} is the most`);
    const seen = new Set();
    for (const item of scan) {
        if (!WORD.test(item.name) || seen.has(item.name))
            fail(`a scan rule's name must be a word of its own: ${item.name}`);
        seen.add(item.name);
        if (typeof item.event !== "string" || item.event === "")
            fail(`the scan rule ${item.name} names no event`);
        if (!["rows", "sum", "max"].includes(item.measure))
            fail(`the scan rule ${item.name} has no such measure`);
        if (item.measure !== "rows" && !WORD.test(item.field ?? "")) {
            fail(`the scan rule ${item.name} needs a \`field\` to ${item.measure}`);
        }
        if (typeof item.limit !== "number" || !Number.isFinite(item.limit))
            fail(`the scan rule ${item.name} has no limit`);
    }
    const nightly = config.nightlyHourUtc ?? DEFAULTS.nightlyHourUtc;
    if (!Number.isInteger(nightly) || nightly < 0 || nightly > 23)
        fail("`nightlyHourUtc` must be an hour, 0 to 23");
    const environments = config.environments ?? DEFAULTS.environments;
    if (!environments.includes("live"))
        fail('`environments` must hold "live"');
    return {
        game: config.game,
        tag: config.tag ?? config.game,
        rules,
        cooldown,
        maxAlerts: positive(config.maxAlertsPerBatch, DEFAULTS.maxAlertsPerBatch, "maxAlertsPerBatch"),
        scan,
        digest: config.digest === false
            ? null
            : { events: config.digest?.events ?? [...rules.keys()], text: config.digest?.text },
        retentionDays: positive(config.retentionDays, DEFAULTS.retentionDays, "retentionDays"),
        maxRawEvents: positive(config.maxRawEvents, DEFAULTS.maxRawEvents, "maxRawEvents"),
        nightlyHourUtc: nightly,
        environments,
        maxBodyBytes: positive(config.maxBodyBytes, DEFAULTS.maxBodyBytes, "maxBodyBytes"),
        maxEvents: positive(config.maxEvents, DEFAULTS.maxEvents, "maxEvents"),
        marks: { ...DEFAULTS.marks, ...config.marks },
        names: { ...DEFAULTS.bindings, ...config.bindings },
        erasureHint: config.erasureHint,
    };
}
/** The game's D1 database. Throws when the binding is not there: the config and wrangler disagree. */
export function database(env, config) {
    const db = env[config.names.database];
    if (typeof db !== "object" || db === null)
        fail(`no D1 binding called ${config.names.database}`);
    return db;
}
/** A secret's value, or an empty string when it is not set. */
export function secret(env, name) {
    const value = env[name];
    return typeof value === "string" ? value : "";
}
