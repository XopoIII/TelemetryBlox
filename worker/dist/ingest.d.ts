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
import { type Env, type Resolved } from "./config.js";
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
export declare function ingest(config: Resolved, request: Request, env: Env, ctx?: ExecutionContext): Promise<Response>;
