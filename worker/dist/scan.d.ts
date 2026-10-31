/**
 * What only shows over many rows: the hourly scan, and yesterday in one message.
 *
 * The scan counts, for each player, what the game's rules name (rows of an event, a field's total,
 * a field's largest value) over the live batches since the last scan, and says who stood at or over
 * a limit. It reads only batches newer than its cursor, by the primary key, so its cost is the
 * hour's batches and not the table: three queries and the alerts'. A finding is a message for a
 * person, never a sanction.
 *
 * The digest reads the roll-up the retention job just made, so it follows it.
 */
import { type Alert } from "./alerts.js";
import { type Env, type Resolved, type ScanRule } from "./config.js";
/** The scan's one statement over the game's rules. `?1` is the cursor. */
export declare function scanSql(rules: ScanRule[]): {
    sql: string;
    values: unknown[];
};
/** What one player's row of the scan says, as alerts. Pure, so a test holds every limit. */
export declare function findings(config: Resolved, row: Record<string, unknown>): Alert[];
/** The hourly scan: every live batch since the last one, by player. */
export declare function anomalies(config: Resolved, env: Env): Promise<Record<string, unknown>>;
/** Yesterday (UTC) in one message, from `events_daily`. Nothing is sent of a day with no live row. */
export declare function digest(config: Resolved, env: Env): Promise<boolean>;
/**
 * The pipe's own watchdog (`silent`): the one failure the pipe cannot report itself, since a refused
 * post leaves no row to carry a `telemetry_drop` — which is exactly what happened on 2026-10-28 and
 * again on 2026-10-29, hours of silence while the game had its biggest days. One message once no
 * live batch came for `hours`, then no more than one every `every` seconds while it lasts. Off
 * unless the game asks for it. Yields.
 *
 * A table that cannot be read at all is the same silence one level up: the plan's day of reads
 * spent or the database at its size wall, and every read refused. On 2026-10-31 that mute lasted a
 * whole day, this watchdog included, for its own question is a read and its cool-down gate another.
 * The message then goes straight to the chat, once an hourly run while it lasts, past a gate that
 * cannot be asked.
 */
export declare function silent(config: Resolved, env: Env): Promise<Record<string, unknown>>;
