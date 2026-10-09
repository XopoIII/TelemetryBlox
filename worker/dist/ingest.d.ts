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
import { type Env, type Resolved } from "./config.js";
/**
 * The newest envelope this ingest reads: the pipe's `Pipe.SCHEMA_VERSION`. A batch from a newer
 * pipe is refused rather than stored half-understood; one from an older pipe still lands, so an
 * old game server keeps working against an updated Worker.
 */
export declare const SCHEMA_VERSION = 1;
export declare function json(body: unknown, status?: number): Response;
/**
 * Whether two secrets are the same, in constant time. A plain `===` leaks the key one byte at a time
 * to anyone who can measure the answer's delay. Both are hashed first, so the comparison is always
 * over 32 bytes and says nothing of either one's length. An absent secret matches nothing.
 */
export declare function secretsMatch(presented: string | null, expected: string): Promise<boolean>;
/** Whether the request carries the ingest key in `x-api-key`. */
export declare function authorised(config: Resolved, request: Request, env: Env): Promise<boolean>;
export declare function asInt(value: unknown, fallback?: number | null): number | null;
export declare function asText(value: unknown): string | null;
/**
 * A bound on how fast batches may arrive. What it protects is the free plan: the day's written
 * rows are a hundred thousand, and a compromised key or a game stuck in a posting loop would spend
 * them in minutes, after which every honest server's batch is refused until midnight. A refused
 * post is a 429. The pipe holds that batch and posts it again without spending one of its tries,
 * for up to ten posts of one batch, so a false positive costs a running server a delay. A closing
 * server has only its drain's budget (twenty seconds by default) to wait in: a batch still refused
 * when that ends is lost with the server.
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
export declare function createLimiter(config: Resolved): IngestLimiter;
export declare function ingest(config: Resolved, request: Request, env: Env, ctx?: ExecutionContext, limiter?: IngestLimiter): Promise<Response>;
