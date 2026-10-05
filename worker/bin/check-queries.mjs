#!/usr/bin/env node
// Runs every saved query of a game against an empty copy of the kit's schema, so one that names a
// table or a column that does not exist fails in the game's gate and not on launch day.
//
//     npx telemetryblox-check-queries queries
//
// Exits 1 when a statement does not run, or when the folder holds no query at all.
import { resolve } from "node:path";
import { checkQueries } from "../testing/index.mjs";

const directory = process.argv[2];
if (!directory || process.argv.length > 3) {
	console.error("usage: telemetryblox-check-queries <folder of .sql files>");
	process.exit(2);
}

const failures = checkQueries(resolve(directory));
for (const failure of failures) {
	console.error(`check-queries: ${failure.file}: ${failure.error}`);
	if (failure.statement) console.error(`  ${failure.statement.split("\n").join("\n  ")}`);
}
if (failures.length > 0) process.exit(1);
console.log(`check-queries: every query in ${directory} runs against the schema`);
