/**
 * Roblox's own webhooks, read as what they are, for the same chat the game's alerts go to.
 *
 * Roblox posts to a URL and sends no header of ours, so the door is opened by a token in the URL
 * (`/roblox-alert?token=...`), a secret of its own.
 */
import { type Resolved } from "./config.js";
/**
 * An analytics alert (Creator Hub, Alerts): `EventPayload.AlertMessage` is a JSON string with a
 * `summary` ("fired" or "recovered") and the `metric`. Whatever arrives is said, shortened.
 */
export declare function robloxAlertText(body: unknown): string;
/**
 * What a Roblox webhook says, as the message for the chat (Creator Hub, Settings, Webhooks):
 *   - `RightToErasureRequest`: a player asked for their data to be deleted. It names the user and
 *     the universes, and what the game says to run; this one is an obligation, not a notice.
 *   - an event with "Refund" in its type: Roblox documents no payload for these, so every field it
 *     sends is said as it came.
 *   - `SampleNotification`: the dashboard's Test button.
 *   - anything else, an analytics alert among them: `robloxAlertText`.
 */
export declare function robloxWebhookText(config: Resolved, body: unknown): string;
