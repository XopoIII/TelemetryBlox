/**
 * The ingest: receives a batch from the game server's pipe (`src/Pipe.luau`) and stores it as ONE
 * row in D1 (`batches`), the events inside it as a JSON array; the `events` view expands them back
 * for queries. It checks the key, bounds the body, refuses a batch from a newer pipe or from a
 * server posting past its minute's share, validates, de-duplicates and inserts, nothing more:
 * aggregating on write would throw away the raw rows the pipe exists to keep.
 *
 * Cloudflare's free plan shaped it:
 *   - 100,000 rows WRITTEN a day, index writes included -> a row per batch, one index.
 *   - 50 D1 queries per invocation                       -> one INSERT per ingest.
 *   - 10 ms CPU per invocation                           -> one JSON parse, a light per-event
 *                                                           check, one stringify.
 */

import { alertsFor, deliver } from "./alerts.js";
import { database, type Env, type Resolved, type SeenEvent, secret } from "./config.js";

/**
 * The newest envelope this ingest reads: the pipe's `Pipe.SCHEMA_VERSION`. A batch from a newer
 * pipe is refused rather than stored half-understood; one from an older pipe still lands, so an
 * old game server keeps working against an updated Worker.
 */
export const SCHEMA_VERSION = 1;

const INSERT_SQL = `INSERT OR IGNORE INTO batches
	(received_at, env, schema_version, universe_id, place_id, place_version, job_id, server_start,
	 first_seq, last_seq, n, events)
	VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`;

interface Envelope {
	schemaVersion?: unknown;
	game?: unknown;
	universeId?: unknown;
	placeId?: unknown;
	placeVersion?: unknown;
	jobId?: unknown;
	env?: unknown;
	serverStart?: unknown;
	events?: unknown;
}

interface CleanEvent extends SeenEvent {
	seq: number;
	t: number;
}

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function digestOf(text: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * Whether two secrets are the same, in constant time. A plain `===` leaks the key one byte at a time
 * to anyone who can measure the answer's delay. Both are hashed first, so the comparison is always
 * over 32 bytes and says nothing of either one's length. An absent secret matches nothing.
 */
export async function secretsMatch(presented: string | null, expected: string): Promise<boolean> {
	if (!presented || !expected) return false;
	const [a, b] = await Promise.all([digestOf(presented), digestOf(expected)]);
	let difference = 0;
	for (let i = 0; i < a.length; i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return difference === 0;
}

/** Whether the request carries the ingest key in `x-api-key`. */
export function authorised(config: Resolved, request: Request, env: Env): Promise<boolean> {
	return secretsMatch(request.headers.get("x-api-key"), secret(env, config.names.ingestKey));
}

export function asInt(value: unknown, fallback: number | null = null): number | null {
	return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

export function asText(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

interface Window {
	count: number;
	resetAt: number;
}

/**
 * A bound on how fast batches may arrive. What it protects is the free plan: the day's written
 * rows are a hundred thousand, and a compromised key or a game stuck in a posting loop would spend
 * them in minutes, after which every honest server's batch is refused until midnight. A refused
 * post is a 429, which the pipe holds and posts again, so the cost of a false positive is a delay.
 *
 * The counts live in the Worker's memory: one more table would spend the very rows being saved.
 * That makes the bound per isolate and best-effort — Cloudflare runs as many isolates as it likes —
 * which is enough against a loop, if not against a determined flood. Nothing here replaces the
 * key; it only slows what the key's holder can break.
 */
export interface IngestLimiter {
	/** Whether one more batch of `jobId` may arrive this minute. */
	allow: (jobId: string, now?: number) => boolean;
}

/** One limiter per Worker (per game), over one minute windows. */
export function createLimiter(config: Resolved): IngestLimiter {
	const servers = new Map<string, Window>();
	let all: Window = { count: 0, resetAt: 0 };

	const fresh = (now: number): Window => ({ count: 0, resetAt: now + 60 });

	return {
		allow(jobId, now = Math.floor(Date.now() / 1000)) {
			if (now >= all.resetAt) all = fresh(now);
			if (all.count >= config.maxBatchesPerMinute) return false;
			let server = servers.get(jobId);
			if (!server || now >= server.resetAt) {
				server = fresh(now);
				servers.set(jobId, server);
				// A flood of made-up job ids must not grow the map without end.
				if (servers.size > 10_000) {
					for (const [id, kept] of servers) if (now >= kept.resetAt) servers.delete(id);
					if (servers.size > 10_000) servers.clear();
				}
			}
			if (server.count >= config.maxServerBatchesPerMinute) return false;
			all.count++;
			server.count++;
			return true;
		},
	};
}

/** Validates the envelope. Returns what is wrong with it, or null when it is usable. */
function validateEnvelope(config: Resolved, body: Envelope): string | null {
	if (typeof body !== "object" || body === null) return "the body must be an object";
	const version = asInt(body.schemaVersion);
	if (version === null) return "schemaVersion must be a number";
	if (version > SCHEMA_VERSION)
		return `schemaVersion ${version} is newer than this ingest reads (${SCHEMA_VERSION}): update the Worker`;
	if (!asText(body.universeId)) return "universeId must be a string";
	if (!asText(body.placeId)) return "placeId must be a string";
	if (typeof body.env !== "string" || !config.environments.includes(body.env)) {
		return `env must be one of ${config.environments.join(", ")}`;
	}
	// A batch that says whose it is must be this game's: a key pasted into the wrong game's secret
	// would otherwise fill this database with another game's rows.
	if (body.game !== undefined && body.game !== config.tag) return `this ingest is ${config.tag}'s`;
	if (!Array.isArray(body.events)) return "events must be an array";
	if (body.events.length > config.maxEvents) return `events exceeds ${config.maxEvents}`;
	return null;
}

/**
 * One event, reduced to the fields the view reads. Null for a malformed one: it is dropped, and the
 * rest of the batch still lands. Roblox encodes an empty context as an empty array, which is read
 * here as the empty context it was.
 */
function clean(raw: unknown): CleanEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	const seq = asInt(r.seq);
	const t = asInt(r.t);
	const event = asText(r.event);
	if (seq === null || t === null || !event) return null;
	const actor = asText(r.actor);
	const ctx =
		typeof r.ctx === "object" && r.ctx !== null && !Array.isArray(r.ctx) ? (r.ctx as Record<string, unknown>) : {};
	return actor ? { seq, t, event, actor, ctx } : { seq, t, event, ctx };
}

export async function ingest(
	config: Resolved,
	request: Request,
	env: Env,
	ctx?: ExecutionContext,
	limiter?: IngestLimiter,
): Promise<Response> {
	if (!(await authorised(config, request, env))) return json({ error: "unauthorized" }, 401);

	// The body is the sender's to choose, so it is bounded twice: by what it says of itself before a
	// byte is read, and by what it turned out to be before it is parsed.
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > config.maxBodyBytes) return json({ error: "payload_too_large" }, 413);
	const text = await request.text();
	if (text.length > config.maxBodyBytes || new TextEncoder().encode(text).byteLength > config.maxBodyBytes) {
		return json({ error: "payload_too_large" }, 413);
	}

	let body: Envelope;
	try {
		body = JSON.parse(text) as Envelope;
	} catch {
		return json({ error: "invalid_json" }, 400);
	}

	const invalid = validateEnvelope(config, body);
	if (invalid) return json({ error: "invalid_envelope", detail: invalid }, 400);

	const jobId = asText(body.jobId) ?? "";
	// After validation (the limit is the pipe's problem only once the batch says whose it is) and
	// before the insert (the write is what is being saved). A 429 is held and posted again.
	if (limiter && !limiter.allow(jobId)) {
		console.log(JSON.stringify({ message: "ingest_rate_limited", jobId }));
		return json({ error: "rate_limited" }, 429);
	}

	const incoming = body.events as unknown[];
	const events: CleanEvent[] = [];
	let firstSeq = Number.POSITIVE_INFINITY;
	let lastSeq = Number.NEGATIVE_INFINITY;
	for (const raw of incoming) {
		const event = clean(raw);
		if (!event) continue;
		events.push(event);
		firstSeq = Math.min(firstSeq, event.seq);
		lastSeq = Math.max(lastSeq, event.seq);
	}
	const skipped = incoming.length - events.length;
	if (events.length === 0) return json({ ok: true, accepted: 0, skipped });

	let stored: number;
	try {
		// ONE query. The same batch sent again hits the unique index and is ignored: the pipe holds a
		// refused batch and posts the same rows, so a post that landed without its answer comes twice.
		const result = await database(env, config)
			.prepare(INSERT_SQL)
			.bind(
				Math.floor(Date.now() / 1000),
				body.env as string,
				asInt(body.schemaVersion),
				body.universeId as string,
				body.placeId as string,
				asInt(body.placeVersion),
				jobId,
				asInt(body.serverStart, 0),
				firstSeq,
				lastSeq,
				events.length,
				JSON.stringify(events),
			)
			.run();
		stored = result.meta?.changes ?? 1;
	} catch (error) {
		// Structured, because this is the line that explains a hole in the game's data later. A
		// "daily limit exceeded" from D1 lands here too.
		console.error(
			JSON.stringify({
				message: "ingest_insert_failed",
				error: error instanceof Error ? error.message : String(error),
				jobId,
				count: events.length,
			}),
		);
		// 5xx on purpose: the pipe sends the batch again, and the unique index makes that free.
		return json({ error: "insert_failed" }, 500);
	}

	if (skipped > 0) console.log(JSON.stringify({ message: "ingest_skipped_events", skipped, jobId }));

	// After the batch is stored, and never in its way: what in it the owner should hear of now. A
	// batch that was already here raised its alerts the first time.
	if (stored > 0) {
		const alerts = alertsFor(config, events, {
			env: body.env as string,
			placeVersion: asInt(body.placeVersion),
			jobId,
		});
		if (alerts.length > 0) {
			const delivery = deliver(config, env, alerts);
			if (ctx) ctx.waitUntil(delivery);
			else await delivery;
		}
	}
	return json({ ok: true, accepted: events.length, skipped, duplicate: stored === 0 });
}
