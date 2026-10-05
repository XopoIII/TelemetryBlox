/**
 * Retention, every night: roll each finished day up into `events_daily` FIRST, then prune old
 * batches, so trends outlive the raw rows.
 *
 * Two walls, whichever comes first: age (`retentionDays`) and size (`maxRawEvents`). The size wall
 * is counted in events, not bytes, because D1 will not report its page count to a Worker. An event
 * is about 150 bytes of JSON, so the default of two million is roughly 300 MB, inside the free
 * plan's 500 MB.
 *
 * Deletes are rows written too, and every statement is one of the 50 queries an invocation may
 * make on the free plan, so both loops are bounded by QUERY_BUDGET.
 */
import { type Env, type Resolved } from "./config.js";
/**
 * Batches per delete. A batch holds up to 1000 events, so a chunk can free a lot: at 2000 a night's
 * run can prune some 70,000 batches, against the 480 a server posts in a day.
 */
export declare const PRUNE_CHUNK = 2000;
/** Queries this job may spend; the free plan allows 50 an invocation, and the rest are overhead. */
export declare const QUERY_BUDGET = 40;
export declare function retention(config: Resolved, env: Env): Promise<Record<string, unknown>>;
/**
 * How fresh the live data is: the newest live batch, its age and the place version it came from.
 * `batches` 0 and the rest null means nothing has ever arrived.
 */
export declare function freshness(config: Resolved, env: Env): Promise<Record<string, unknown>>;
