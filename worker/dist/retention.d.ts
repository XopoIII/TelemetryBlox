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
 * The roll-up keeps its own cursor in `retention_state`: the next day to roll up, and how far into
 * it the six-hour slices reached. A day is collected into `events_slice` one committed slice at a
 * time, so a run D1 cuts off (a big game's day is more than a statement's memory; the free plan's
 * rows-read day runs out too) leaves every finished slice behind, and the next run picks the day up
 * at the next slice: nothing is read twice and no batch is counted twice. A day small enough for
 * one statement (at most EXACT_MAX_EVENTS events by its batches' own counts) is rolled up exactly,
 * players and all; a bigger one is sliced, its events exact and its players counted once at the
 * end if that count fits. A slice that fails is retried at half the width (six hours, three, one,
 * fifteen minutes); when even that fails the run stops and says where, rather than leaving a day
 * that looks partly rolled up and never moves again.
 *
 * A batch counts toward a day only while it arrives within `CLOCK_SLACK_SECONDS` of that day: a
 * batch's window is the day expanded by the slack on both sides. An event whose batch arrives
 * later than that is not counted by the roll-up (the pipe drops a batch it cannot post long
 * before), and the size wall keeps a batch until the roll-up has passed the last day the batch can
 * hold -- received before the cursor day less the slack. No row is pruned before the roll-up has
 * had the chance to read the day it belongs to.
 */
import { type Env, type Resolved } from "./config.js";
/**
 * Batches per delete. A batch holds up to 1000 events, so a chunk can free a lot: at 2000 a night's
 * run can prune some 70,000 batches, against the 480 a server posts in a day.
 */
export declare const PRUNE_CHUNK = 2000;
/** Queries this job may spend; the free plan allows 50 an invocation, and the rest are overhead. */
export declare const QUERY_BUDGET = 40;
/** Events at or under which a day is rolled up exactly, players and all, in one statement. */
export declare const EXACT_MAX_EVENTS = 500000;
/** A day too big for one statement goes in slices: six hours, then half, a sixth, a twenty-fourth. */
export declare const SLICE_SECONDS: number;
/** How far one run got, what it read, and where it stopped. */
export interface RollUp {
    /** Rows written into `events_slice` and `events_daily`: the night's work. */
    rolledUp: number;
    /** The first day the run was for, as a `YYYY-MM-DD` day. */
    rolledFrom: string;
    /** The days it finished in slices, each summed into `events_daily`. */
    sliced: string[];
    /** The days it passed over: no batch can hold an event of them. */
    skipped: string[];
    /** Where the next run starts. */
    state: {
        day: string;
        slice: number;
    };
    queries: number;
    rowsRead: number;
    /** The slice that would not go in, even at fifteen minutes: the cursor stands before it. */
    failed?: {
        day: string;
        from: string;
        error: string;
    };
    /** The first-seen step, which every run drains alongside the roll-up. */
    firsts?: Firsts;
}
/** The rows D1 says the run's big statements read, an expanded event counting once each. */
type Read = (res: {
    meta?: {
        rows_read?: number;
    };
}) => void;
interface Meter {
    queries: number;
    rowsRead: number;
}
/** How far the first-seen step got, and the range it would not take. */
export interface Firsts {
    /** New players kept this run. */
    newActors: number;
    /** The batch id the cursor stands at: everything at or before it is kept. */
    to: number;
    /** The range that would not go in, even one batch at a time. */
    failed?: {
        batch: number;
        error: string;
    };
}
/**
 * Who was first seen when, kept BEFORE the prune can take the rows that say so. The bare
 * `place_version` beside MIN(t) is that oldest row's own (SQLite's rule for a lone MIN). A player
 * already kept is ignored, so each costs one row written, once. The batches go in ranges of at most
 * `chunk` arrivals, and the cursor moves past a range only once that range is in, so a run D1
 * cuts off leaves the rest to the next. With no cursor yet (a new database, or one from before it),
 * the window of the roll-up and the day before it.
 */
export declare function firsts(db: D1Database, meter: Meter, read: Read, ceiling: number, chunk?: number): Promise<Firsts>;
/** The roll-up alone, as every hourly run does it: the backlog drains through the day, not only at night. */
export declare function rollUp(config: Resolved, env: Env): Promise<RollUp>;
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
 * reads a row a stored batch. `used` is what the same invocation's roll-up has spent, so the two
 * together stay inside the plan's queries.
 */
export declare function hourlyWall(config: Resolved, env: Env, used?: number): Promise<Wall>;
/**
 * How fresh the live data is: the newest live batch, its age and the place version it came from.
 * `batches` 0 and the rest null means nothing has ever arrived.
 */
export declare function freshness(config: Resolved, env: Env): Promise<Record<string, unknown>>;
export {};
