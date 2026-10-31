// The pipe's own watchdog: the failure the pipe cannot report itself. A server that cannot post
// leaves no row, so silence is read off the table rather than waited for, and said once an `every`
// rather than every hour.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createKit } from "../dist/index.js";
import { batch, CONFIG, call, environment, NOW, recordTelegram, texts } from "./helpers.mjs";

beforeEach(recordTelegram);

const WATCHED = createKit({ ...CONFIG, silent: { hours: 2, every: 21_600 } });
const UNWATCHED = createKit(CONFIG);

test("a pipe that never sent a batch says so once, and not again inside its every", async () => {
	const env = environment();
	const first = await WATCHED.silent(env);
	assert.deepEqual([first.watched, first.last, first.waited, first.sent], [true, null, null, 1]);
	assert.match(texts()[0], /No live batch has ever arrived/);
	assert.match(texts()[0], /\[critical\] Example Game: /);
	// the same silence inside the cool-down is held, not said again
	assert.equal((await WATCHED.silent(env)).sent, 0);
	assert.equal(texts().length, 1);
});

test("a fresh batch keeps it quiet, and one past its hours does not", async () => {
	const env = environment();
	await call(env, "/ingest", { body: batch([{ event: "feed", actor: "u_fed_000001", ctx: { food: "sugar" } }]) });
	assert.equal((await WATCHED.silent(env)).sent, 0);
	assert.equal(texts().length, 0);
	// the last batch three hours ago: the pipe is silent by the watchdog's measure
	await env.DB.prepare("UPDATE batches SET received_at = ?1")
		.bind(NOW - 3 * 3600)
		.run();
	const said = await WATCHED.silent(env);
	assert.deepEqual([said.watched, said.sent], [true, 1]);
	assert.match(texts()[0], /No live batch for 3 h \(last at .*Z\)/);
	// and the ingest taking a batch again ends the silence, its key past its cool-down at once
	await call(env, "/ingest", { body: batch([{ event: "feed", actor: "u_fed_000002", ctx: {} }]) });
	assert.equal((await WATCHED.silent(env)).sent, 0);
});

test("a table whose read is refused is said at once, past the gate it cannot ask", async () => {
	// D1 refusing every read of the day (the free plan's row budget spent): no row can name it and
	// the cool-down gate is as unreadable as the table, so the chat is written directly
	const refused = {
		DB: {
			prepare: () => {
				throw new Error("D1_ERROR: exceeded D1's free tier daily row read limit");
			},
		},
	};
	const said = await WATCHED.silent(environment(refused));
	assert.deepEqual([said.watched, said.unreadable, said.sent], [true, true, 1]);
	assert.match(texts()[0], /\[critical\] Example Game: The batches table cannot be read \(D1_ERROR/);
	assert.match(texts()[0], /every alert is held with it/);
	// and again the next hourly run: nothing counts the repeats while every read is refused
	assert.equal((await WATCHED.silent(environment(refused))).sent, 1);
	assert.equal(texts().length, 2);
	// a game that did not ask for the watchdog is told nothing of it
	assert.deepEqual(await UNWATCHED.silent(environment(refused)), { message: "silent", watched: false });
});

test("a game that did not ask for the watchdog is never told", async () => {
	const env = environment();
	assert.deepEqual(await UNWATCHED.silent(env), { message: "silent", watched: false });
	assert.equal(texts().length, 0);
});
