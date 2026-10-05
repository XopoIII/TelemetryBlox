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
import { bySeverity, deliver, send } from "./alerts.js";
import { database, who } from "./config.js";
const EVENT = "json_extract(e.value,'$.event')";
/** One column of the scan and the values it binds, numbered from `at`. */
function column(rule, index, at) {
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
export function scanSql(rules) {
    const columns = [];
    const values = [];
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
export function findings(config, row) {
    const actor = who(typeof row.actor === "string" ? row.actor : undefined);
    const found = [];
    config.scan.forEach((rule, index) => {
        const value = row[`m${index}`];
        if (typeof value !== "number" || value < rule.limit)
            return;
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
export async function anomalies(config, env) {
    const db = database(env, config);
    const cursor = await db.prepare(`SELECT batch_id FROM alert_cursor WHERE name = 'anomaly'`).first();
    const newest = await db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM batches`).first();
    // A first run only sets the cursor: what came before the scan existed is not asked about.
    const from = cursor?.batch_id ?? newest?.id ?? 0;
    const to = newest?.id ?? 0;
    let alerts = [];
    if (to > from && config.scan.length > 0) {
        const { sql, values } = scanSql(config.scan);
        const scanned = await db
            .prepare(sql)
            .bind(from, ...values)
            .all();
        alerts = bySeverity((scanned.results ?? []).flatMap((row) => findings(config, row)));
    }
    await db.prepare(`INSERT OR REPLACE INTO alert_cursor (name, batch_id) VALUES ('anomaly', ?1)`).bind(to).run();
    const sent = await deliver(config, env, alerts);
    const report = { message: "anomalies", from, to, found: alerts.length, sent };
    console.log(JSON.stringify(report));
    return report;
}
/** Yesterday (UTC) in one message, from `events_daily`. Nothing is sent of a day with no live row. */
export async function digest(config, env) {
    if (!config.digest)
        return false;
    const names = ["*", ...config.digest.events];
    const marks = names.map((_, i) => `?${i + 1}`).join(", ");
    const res = await database(env, config)
        .prepare(`SELECT event, SUM(events) AS events, SUM(actors) AS actors FROM events_daily
			 WHERE day = date('now', '-1 day') AND env = 'live' AND event IN (${marks}) GROUP BY event`)
        .bind(...names)
        .all();
    const rows = new Map((res.results ?? []).map((row) => [row.event, row]));
    const all = rows.get("*");
    if (!all)
        return false;
    const day = {
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
