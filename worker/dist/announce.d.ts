/**
 * A release told to a game's players: one post to a Discord channel's webhook, sent by the game's
 * own tools through `POST /announce`. The webhook's URL is a secret of the Worker, named by
 * `bindings.announceWebhook`; it holds the webhook's token, so it is never logged.
 */
import { type Env, type Resolved } from "./config.js";
/** Discord's own caps on an embed's title and description. */
export declare const ANNOUNCE_TITLE = 256;
export declare const ANNOUNCE_TEXT = 4096;
/** What a post says: a title, its lines and, when given, the address the title links to. */
export interface Announcement {
    title: string;
    text: string;
    url?: string;
}
/** The announcement a request's body holds, or what is wrong with it. */
export declare function announcementOf(body: unknown): Announcement | string;
/**
 * Posts the announcement. "sent" when Discord took it, "unconfigured" without the secret, and
 * Discord's HTTP status when it refused (0: no answer at all). Never throws. Nobody is pinged:
 * the lines are the game's changelog, and an "@everyone" in them stays text.
 */
export declare function announce(config: Resolved, env: Env, announcement: Announcement): Promise<"sent" | "unconfigured" | number>;
