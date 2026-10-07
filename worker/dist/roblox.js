/**
 * Roblox's own webhooks, read as what they are, for the same chat the game's alerts go to.
 *
 * Roblox posts to a URL and sends no header of ours, so the door is opened by a token in the URL
 * (`/roblox-alert?token=...`), a secret of its own.
 */
import { DEFAULTS, field, short } from "./config.js";
/**
 * An analytics alert (Creator Hub, Alerts): `EventPayload.AlertMessage` is a JSON string with a
 * `summary` ("fired" or "recovered") and the `metric`. Whatever arrives is said, shortened, and a
 * value that was cut ends with `cut`.
 */
export function robloxAlertText(body, cut = DEFAULTS.marks.cut) {
    const payload = field(body, "EventPayload");
    const raw = field(payload, "AlertMessage");
    let message = raw;
    if (typeof raw === "string") {
        try {
            message = JSON.parse(raw);
        }
        catch {
            message = raw;
        }
    }
    const summary = field(message, "summary");
    const metric = field(message, "metric");
    if (typeof summary === "string" || typeof metric === "string") {
        return `Roblox alert: ${short(summary ?? "?", 200, cut)} (${short(metric ?? "?", 80, cut)})`;
    }
    return `Roblox alert: ${short(message ?? body, 400, cut)}`;
}
/** The top-level fields of a webhook's `EventPayload`, as `name: value` lines, ten at most. */
function payloadLines(payload, cut) {
    if (typeof payload !== "object" || payload === null)
        return short(payload, 300, cut);
    const lines = Object.entries(payload)
        .slice(0, 10)
        .map(([name, value]) => `${name}: ${short(value, 120, cut)}`);
    return lines.length > 0 ? lines.join("\n") : "(no fields)";
}
/**
 * What a Roblox webhook says, as the message for the chat (Creator Hub, Settings, Webhooks):
 *   - `RightToErasureRequest`: a player asked for their data to be deleted. It names the user and
 *     the universes, and what the game says to run; this one is an obligation, not a notice.
 *   - an event with "Refund" in its type: Roblox documents no payload for these, so every field it
 *     sends is said as it came.
 *   - `SampleNotification`: the dashboard's Test button.
 *   - anything else, an analytics alert among them: `robloxAlertText`.
 *
 * Each starts with what the game's `robloxPrefix` says of its kind: `marks.roblox` and the game's
 * name, unless the game marks its kinds apart.
 */
export function robloxWebhookText(config, body) {
    const cut = config.marks.cut;
    const type = field(body, "EventType");
    const payload = field(body, "EventPayload");
    if (type === "RightToErasureRequest") {
        const user = short(field(payload, "UserId"), 20, cut);
        const games = field(payload, "GameIds");
        const where = Array.isArray(games) && games.length > 0 ? games.map((id) => short(id, 20, cut)).join(", ") : "?";
        const lines = [
            `${config.robloxPrefix("erasure")} right to erasure. Delete the data of user ${user}.`,
            `Universes named: ${where}`,
        ];
        if (config.erasureHint)
            lines.push(config.erasureHint(user));
        return lines.join("\n");
    }
    if (type === "SampleNotification") {
        const user = short(field(payload, "UserId"), 20, cut);
        return `${config.robloxPrefix("test")} a test notification arrived (user ${user}). The webhook works.`;
    }
    if (typeof type === "string" && /refund/i.test(type)) {
        return `${config.robloxPrefix("refund")} a refund (${short(type, 60, cut)})\n${payloadLines(payload, cut)}`;
    }
    if (typeof type === "string" && type !== "AnalyticsAlert") {
        return `${config.robloxPrefix("event")} ${short(type, 60, cut)}\n${payloadLines(payload, cut)}`;
    }
    return `${config.robloxPrefix("alert")} ${robloxAlertText(body, cut)}`;
}
