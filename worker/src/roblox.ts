/**
 * Roblox's own webhooks, read as what they are, for the same chat the game's alerts go to.
 *
 * Roblox posts to a URL and sends no header of ours, so the door is opened by a token in the URL
 * (`/roblox-alert?token=...`), a secret of its own.
 */

import { field, type Resolved, short } from "./config.js";

/**
 * An analytics alert (Creator Hub, Alerts): `EventPayload.AlertMessage` is a JSON string with a
 * `summary` ("fired" or "recovered") and the `metric`. Whatever arrives is said, shortened.
 */
export function robloxAlertText(body: unknown): string {
	const payload = field(body, "EventPayload");
	const raw = field(payload, "AlertMessage");
	let message: unknown = raw;
	if (typeof raw === "string") {
		try {
			message = JSON.parse(raw);
		} catch {
			message = raw;
		}
	}
	const summary = field(message, "summary");
	const metric = field(message, "metric");
	if (typeof summary === "string" || typeof metric === "string") {
		return `Roblox alert: ${short(summary ?? "?", 200)} (${short(metric ?? "?", 80)})`;
	}
	return `Roblox alert: ${short(message ?? body, 400)}`;
}

/** The top-level fields of a webhook's `EventPayload`, as `name: value` lines, ten at most. */
function payloadLines(payload: unknown): string {
	if (typeof payload !== "object" || payload === null) return short(payload, 300);
	const lines = Object.entries(payload as Record<string, unknown>)
		.slice(0, 10)
		.map(([name, value]) => `${name}: ${short(value, 120)}`);
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
 */
export function robloxWebhookText(config: Resolved, body: unknown): string {
	const mark = config.marks.roblox;
	const type = field(body, "EventType");
	const payload = field(body, "EventPayload");
	if (type === "RightToErasureRequest") {
		const user = short(field(payload, "UserId"), 20);
		const games = field(payload, "GameIds");
		const where = Array.isArray(games) && games.length > 0 ? games.map((id) => short(id, 20)).join(", ") : "?";
		const lines = [
			`${mark} ${config.game}: right to erasure. Delete the data of user ${user}.`,
			`Universes named: ${where}`,
		];
		if (config.erasureHint) lines.push(config.erasureHint(user));
		return lines.join("\n");
	}
	if (type === "SampleNotification") {
		return `${mark} ${config.game}: a test notification arrived (user ${short(field(payload, "UserId"), 20)}). The webhook works.`;
	}
	if (typeof type === "string" && /refund/i.test(type)) {
		return `${mark} ${config.game}: a refund (${short(type, 60)})\n${payloadLines(payload)}`;
	}
	if (typeof type === "string" && type !== "AnalyticsAlert") {
		return `${mark} ${config.game}: ${short(type, 60)}\n${payloadLines(payload)}`;
	}
	return `${mark} ${config.game}: ${robloxAlertText(body)}`;
}
