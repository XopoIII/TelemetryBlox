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

import { type Alert, bySeverity, deliver, send } from "./alerts.js";
import { type DigestDay, database, type Env, type Resolved, type ScanRule, short, who } from "./config.js";

const EVENT = "json_extract(e.value,'$.event')";

/** One column of the scan and the values it binds, numbered from `at`. */
function column(rule: ScanRule, index: number, at: number): { sql: string; values: unknown[] } {
	const name = `m${index}`;
	if (rule.measure === "rows") {
		return { sql: `SUM(${EVENT} = ?${at}) AS ${name}`, values: [rule.event] };
	}
	const path = `$.ctx.${rule.field}`;
	if (rule.measure === "sum") {
		return {
			sql: `SUM(CASE WHEN ${EVENT} = ?${at} THEN COALESCE(json_extract(e.value, ?${at + 1}), ?${at + 2}) ELSE 0 END) AS ${name}`,
			values: [rule.event, path, rule.missing ?? 0],
		};
	}
	return {
		sql: `MAX(CASE WHEN ${EVENT} = ?${at} THEN json_extract(e.value, ?${at + 1}) END) AS ${name}`,
		values: [rule.event, path],
	};
}

/** The scan's one statement over the game's rules. `?1` is the cursor. */
export function scanSql(rules: ScanRule[]): { sql: string; values: unknown[] } {
	const columns: string[] = [];
	const values: unknown[] = [];
	rules.forEach((rule, index) => {
		const built = column(rule, index, values.length + 2);
		columns.push(built.sql);
		values.push(...built.values);
	});
	const sql = `SELECT json_extract(e.value,'$.actor') AS actor, ${columns.join(", ")}
		FROM batches b, json_each(b.events) e
		WHERE b.id > ?1 AND b.env = 'live' AND json_extract(e.value,'$.actor') IS NOT NULL
		GROUP BY actor`;
	return { sql, values };
}

/** What one player's row of the scan says, as alerts. Pure, so a test holds every limit. */
export function findings(config: Resolved, row: Record<string, unknown>): Alert[] {
	const actor = who(typeof row.actor === "string" ? row.actor : undefined);
	const found: Alert[] = [];
	config.scan.forEach((rule, index) => {
		const value = row[`m${index}`];
		if (typeof value !== "number" || value < rule.limit) return;
		const severity = rule.severity ?? "warning";
		const said = rule.text
			? rule.text(value, actor)
			: `${rule.name}: ${value} in the last scan (limit ${rule.limit})`;
		found.push({
			key: `anomaly:${rule.name}:${actor}`,
			severity,
			text: `${said}, player ${actor}`,
			cooldown: config.cooldown[severity],
		});
	});
	return found;
}

/** The hourly scan: every live batch since the last one, by player. */
export async function anomalies(config: Resolved, env: Env): Promise<Record<string, unknown>> {
	const db = database(env, config);
	const cursor = await db.prepare(`SELECT batch_id FROM alert_cursor WHERE name = 'anomaly'`).first<{
		batch_id: number;
	}>();
	const newest = await db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM batches`).first<{ id: number }>();
	// A first run only sets the cursor: what came before the scan existed is not asked about.
	const from = cursor?.batch_id ?? newest?.id ?? 0;
	const to = newest?.id ?? 0;
	let alerts: Alert[] = [];
	if (to > from && config.scan.length > 0) {
		const { sql, values } = scanSql(config.scan);
		const scanned = await db
			.prepare(sql)
			.bind(from, ...values)
			.all<Record<string, unknown>>();
		alerts = bySeverity((scanned.results ?? []).flatMap((row) => findings(config, row)));
	}
	await db.prepare(`INSERT OR REPLACE INTO alert_cursor (name, batch_id) VALUES ('anomaly', ?1)`).bind(to).run();
	const sent = await deliver(config, env, alerts);
	const report = { message: "anomalies", from, to, found: alerts.length, sent };
	console.log(JSON.stringify(report));
	return report;
}

/** Yesterday (UTC) in one message, from `events_daily`. Nothing is sent of a day with no live row. */
export async function digest(config: Resolved, env: Env): Promise<boolean> {
	if (!config.digest) return false;
	const names = ["*", ...config.digest.events];
	const marks = names.map((_, i) => `?${i + 1}`).join(", ");
	const res = await database(env, config)
		.prepare(
			`SELECT event, SUM(events) AS events, SUM(actors) AS actors FROM events_daily
			 WHERE day = date('now', '-1 day') AND env = 'live' AND event IN (${marks}) GROUP BY event`,
		)
		.bind(...names)
		.all<{ event: string; events: number; actors: number }>();
	const rows = new Map((res.results ?? []).map((row) => [row.event, row]));
	const all = rows.get("*");
	if (!all) return false;
	const day: DigestDay = {
		players: all.actors,
		rows: all.events,
		count: (event) => rows.get(event)?.events ?? 0,
	};
	const lines = [`${day.players} players, ${day.rows} rows`];
	if (config.digest.events.length > 0) {
		lines.push(config.digest.events.map((event) => `${event} ${day.count(event)}`).join("; "));
	}
	const said = config.digest.text ? config.digest.text(day) : lines.join("\n");
	return send(config, env, `${config.marks.digest} ${config.game}, yesterday: ${said}`);
}

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
export async function silent(config: Resolved, env: Env): Promise<Record<string, unknown>> {
	if (!config.silent) return { message: "silent", watched: false };
	let row: { last: number | null; now: number } | null = null;
	try {
		row = await database(env, config)
			.prepare(`SELECT MAX(received_at) AS last, unixepoch('now') AS now FROM batches WHERE env = 'live'`)
			.first<{ last: number | null; now: number }>();
	} catch (error) {
		// No row can name a refused read, and the gate's table is as unreadable as the batches table,
		// so the chat is written directly: one message an hourly run, the rate a wall that is not
		// lifted has always been allowed (the `telemetry_drop` cool-down is an hour for that reason).
		const why = short(error instanceof Error ? error.message : String(error), 90);
		const said = await send(
			config,
			env,
			`${config.marks.critical} ${config.game}: The batches table cannot be read (${why}); every alert is held with it`,
		);
		return { message: "silent", watched: true, unreadable: true, sent: said ? 1 : 0 };
	}
	const now = row?.now ?? Math.floor(Date.now() / 1000);
	const last = row?.last ?? null;
	const waited = last === null ? null : Math.max(0, now - last);
	if (waited !== null && waited < config.silent.hours * 3600) {
		return { message: "silent", watched: true, last, waited, sent: 0 };
	}
	const text =
		last === null
			? "No live batch has ever arrived: the ingest key, the Worker's address or HTTP in the place"
			: `No live batch for ${Math.floor((waited ?? 0) / 3600)} h (last at ${new Date(last * 1000).toISOString()}): the pipe is refused or the game is not posting`;
	const sent = await deliver(
		config,
		env,
		[{ key: "silent", severity: "critical", text, cooldown: config.silent.every }],
		now,
	);
	return { message: "silent", watched: true, last, waited, sent };
}
