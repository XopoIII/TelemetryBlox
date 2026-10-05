/**
 * The ingest: receives a batch from the game server's pipe (`src/Pipe.luau`) and stores it as ONE
 * row in D1 (`batches`), the events inside it as a JSON array; the `events` view expands them back
 * for queries. It checks the key, bounds the body, validates, de-duplicates and inserts, nothing
 * more: aggregating on write would throw away the raw rows the pipe exists to keep.
 *
 * Cloudflare's free plan shaped it:
 *   - 100,000 rows WRITTEN a day, index writes included -> a row per batch, one index.
 *   - 50 D1 queries per invocation                       -> one INSERT per ingest.
 *   - 10 ms CPU per invocation                           -> one JSON parse, a light per-event
 *                                                           check, one stringify.
 */
import { alertsFor, deliver } from "./alerts.js";
import { database, secret } from "./config.js";
const INSERT_SQL = `INSERT OR IGNORE INTO batches
	(received_at, env, schema_version, universe_id, place_id, place_version, job_id, server_start,
	 first_seq, last_seq, n, events)
	VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`;
export function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
async function digestOf(text) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
/**
 * Whether two secrets are the same, in constant time. A plain `===` leaks the key one byte at a time
 * to anyone who can measure the answer's delay. Both are hashed first, so the comparison is always
 * over 32 bytes and says nothing of either one's length. An absent secret matches nothing.
 */
export async function secretsMatch(presented, expected) {
    if (!presented || !expected)
        return false;
    const [a, b] = await Promise.all([digestOf(presented), digestOf(expected)]);
    let difference = 0;
    for (let i = 0; i < a.length; i++)
        difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
    return difference === 0;
}
/** Whether the request carries the ingest key in `x-api-key`. */
export function authorised(config, request, env) {
    return secretsMatch(request.headers.get("x-api-key"), secret(env, config.names.ingestKey));
}
export function asInt(value, fallback = null) {
    return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}
export function asText(value) {
    return typeof value === "string" ? value : null;
}
/** Validates the envelope. Returns what is wrong with it, or null when it is usable. */
function validateEnvelope(config, body) {
    if (typeof body !== "object" || body === null)
        return "the body must be an object";
    if (asInt(body.schemaVersion) === null)
        return "schemaVersion must be a number";
    if (!asText(body.universeId))
        return "universeId must be a string";
    if (!asText(body.placeId))
        return "placeId must be a string";
    if (typeof body.env !== "string" || !config.environments.includes(body.env)) {
        return `env must be one of ${config.environments.join(", ")}`;
    }
    // A batch that says whose it is must be this game's: a key pasted into the wrong game's secret
    // would otherwise fill this database with another game's rows.
    if (body.game !== undefined && body.game !== config.tag)
        return `this ingest is ${config.tag}'s`;
    if (!Array.isArray(body.events))
        return "events must be an array";
    if (body.events.length > config.maxEvents)
        return `events exceeds ${config.maxEvents}`;
    return null;
}
/**
 * One event, reduced to the fields the view reads. Null for a malformed one: it is dropped, and the
 * rest of the batch still lands. Roblox encodes an empty context as an empty array, which is read
 * here as the empty context it was.
 */
function clean(raw) {
    if (typeof raw !== "object" || raw === null)
        return null;
    const r = raw;
    const seq = asInt(r.seq);
    const t = asInt(r.t);
    const event = asText(r.event);
    if (seq === null || t === null || !event)
        return null;
    const actor = asText(r.actor);
    const ctx = typeof r.ctx === "object" && r.ctx !== null && !Array.isArray(r.ctx) ? r.ctx : {};
    return actor ? { seq, t, event, actor, ctx } : { seq, t, event, ctx };
}
export async function ingest(config, request, env, ctx) {
    if (!(await authorised(config, request, env)))
        return json({ error: "unauthorized" }, 401);
    // The body is the sender's to choose, so it is bounded twice: by what it says of itself before a
    // byte is read, and by what it turned out to be before it is parsed.
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > config.maxBodyBytes)
        return json({ error: "payload_too_large" }, 413);
    const text = await request.text();
    if (text.length > config.maxBodyBytes || new TextEncoder().encode(text).byteLength > config.maxBodyBytes) {
        return json({ error: "payload_too_large" }, 413);
    }
    let body;
    try {
        body = JSON.parse(text);
    }
    catch {
        return json({ error: "invalid_json" }, 400);
    }
    const invalid = validateEnvelope(config, body);
    if (invalid)
        return json({ error: "invalid_envelope", detail: invalid }, 400);
    const incoming = body.events;
    const events = [];
    let firstSeq = Number.POSITIVE_INFINITY;
    let lastSeq = Number.NEGATIVE_INFINITY;
    for (const raw of incoming) {
        const event = clean(raw);
        if (!event)
            continue;
        events.push(event);
        firstSeq = Math.min(firstSeq, event.seq);
        lastSeq = Math.max(lastSeq, event.seq);
    }
    const skipped = incoming.length - events.length;
    if (events.length === 0)
        return json({ ok: true, accepted: 0, skipped });
    const jobId = asText(body.jobId) ?? "";
    let stored;
    try {
        // ONE query. The same batch sent again hits the unique index and is ignored: the pipe holds a
        // refused batch and posts the same rows, so a post that landed without its answer comes twice.
        const result = await database(env, config)
            .prepare(INSERT_SQL)
            .bind(Math.floor(Date.now() / 1000), body.env, asInt(body.schemaVersion), body.universeId, body.placeId, asInt(body.placeVersion), jobId, asInt(body.serverStart, 0), firstSeq, lastSeq, events.length, JSON.stringify(events))
            .run();
        stored = result.meta?.changes ?? 1;
    }
    catch (error) {
        // Structured, because this is the line that explains a hole in the game's data later. A
        // "daily limit exceeded" from D1 lands here too.
        console.error(JSON.stringify({
            message: "ingest_insert_failed",
            error: error instanceof Error ? error.message : String(error),
            jobId,
            count: events.length,
        }));
        // 5xx on purpose: the pipe sends the batch again, and the unique index makes that free.
        return json({ error: "insert_failed" }, 500);
    }
    if (skipped > 0)
        console.log(JSON.stringify({ message: "ingest_skipped_events", skipped, jobId }));
    // After the batch is stored, and never in its way: what in it the owner should hear of now. A
    // batch that was already here raised its alerts the first time.
    if (stored > 0) {
        const alerts = alertsFor(config, events, {
            env: body.env,
            placeVersion: asInt(body.placeVersion),
            jobId,
        });
        if (alerts.length > 0) {
            const delivery = deliver(config, env, alerts);
            if (ctx)
                ctx.waitUntil(delivery);
            else
                await delivery;
        }
    }
    return json({ ok: true, accepted: events.length, skipped, duplicate: stored === 0 });
}
