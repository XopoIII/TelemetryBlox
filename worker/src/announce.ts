/**
 * A release told to a game's players: one post to a Discord channel's webhook, sent by the game's
 * own tools through `POST /announce`. The webhook's URL is a secret of the Worker, named by
 * `bindings.announceWebhook`; it holds the webhook's token, so it is never logged.
 */

import { type Env, type Resolved, secret } from "./config.js";

/** Discord's own caps on an embed's title and description. */
export const ANNOUNCE_TITLE = 256;
export const ANNOUNCE_TEXT = 4096;

/** What a post says: a title, its lines and, when given, the address the title links to. */
export interface Announcement {
	title: string;
	text: string;
	url?: string;
}

/** The announcement a request's body holds, or what is wrong with it. */
export function announcementOf(body: unknown): Announcement | string {
	const given = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
	const { title, text, url } = given;
	if (typeof title !== "string" || title.trim() === "") return "title must be a non-empty string";
	if (typeof text !== "string" || text.trim() === "") return "text must be a non-empty string";
	if (url === undefined) return { title, text };
	if (typeof url !== "string" || !url.startsWith("https://")) return "url must be an https address";
	return { title, text, url };
}

function cut(value: string, limit: number, mark: string): string {
	return value.length <= limit ? value : value.slice(0, limit - mark.length) + mark;
}

/**
 * Posts the announcement. "sent" when Discord took it, "unconfigured" without the secret, and
 * Discord's HTTP status when it refused (0: no answer at all). Never throws. Nobody is pinged:
 * the lines are the game's changelog, and an "@everyone" in them stays text.
 */
export async function announce(
	config: Resolved,
	env: Env,
	announcement: Announcement,
): Promise<"sent" | "unconfigured" | number> {
	const webhook = secret(env, config.names.announceWebhook);
	if (!webhook) {
		console.log(JSON.stringify({ message: "announce_unconfigured", title: announcement.title }));
		return "unconfigured";
	}
	const embed: Record<string, string> = {
		title: cut(announcement.title, ANNOUNCE_TITLE, config.marks.cut),
		description: cut(announcement.text, ANNOUNCE_TEXT, config.marks.cut),
	};
	if (announcement.url !== undefined) embed.url = announcement.url;
	try {
		const response = await fetch(webhook, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
		});
		if (response.ok) return "sent";
		console.error(JSON.stringify({ message: "announce_failed", status: response.status }));
		return response.status;
	} catch (error) {
		// The error's own text is not logged: a fetch failure may quote the URL, and the URL holds the token.
		console.error(
			JSON.stringify({ message: "announce_failed", error: error instanceof Error ? error.name : "error" }),
		);
		return 0;
	}
}
