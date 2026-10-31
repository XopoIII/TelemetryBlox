/**
 * Retention, every night: roll each finished day up into `events_daily` FIRST, then prune old
 * batches, so trends outlive the raw rows.
 *
 * Two walls, whichever comes first: age (`retentionDays`) and size (`maxRawEvents`). The size wall
 * is counted in events, not bytes, because D1 will not report its page count to a Worker. An event
 * takes some 150 to 160 bytes of D1's pages, so the default of two million is roughly 300 MB.
 *
 * The size wall runs every hour as well as at night, and takes only batches every job is done
 * with: at or before the `actors` cursor, and received before the first day still to roll up. So
 * what D1 holds is `maxRawEvents` plus the day being collected, and that sum, not the option alone,
 * must fit the plan: on the free plan's 500 MB a day of more than about two million events leaves
 * no room, and the wall says so rather than take rows no roll-up has counted.
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
/** Seconds of a day in one slice of the fallback roll-up: a day too big for one statement. */
export declare const SLICE_SECONDS: number;
export declare function retention(config: Resolved, env: Env): Promise<Record<string, unknown>>;
/** What the size wall did. `warn` says why events are still over budget, if they are. */
export interface Wall {
    rawEvents: number;
    rawBatches: number;
    overBudgetBatches: number;
    queries: number;
    warn: string | undefined;
}
/**
 * The size wall alone, every hour: a day's rows past `maxRawEvents` go before the night, so D1
 * holds the budget plus the day being collected. When under budget it costs one statement, which
 * reads a row a stored batch.
 */
export declare function hourlyWall(config: Resolved, env: Env): Promise<Wall>;
/**
 * How fresh the live data is: the newest live batch, its age and the place version it came from.
 * `batches` 0 and the rest null means nothing has ever arrived.
 */
export declare function freshness(config: Resolved, env: Env): Promise<Record<string, unknown>>;
