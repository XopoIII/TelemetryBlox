#!/usr/bin/env sh
# The Worker's gate: types, format and lint, its tests, and the build a game really runs.
#
# WHY THE BUILD IS CHECKED: a game installs this repository by tag, and Node will not strip types
# from a file under node_modules, so what a game imports is the JavaScript committed in worker/dist.
# The tests read that JavaScript too. A change to worker/src that is not built again would pass
# them and ship the old Worker, so the source is built into a scratch folder and compared with what
# is committed, file by file, before the tests run.
#
# Deliberately loud rather than skip-on-missing-deps: a gate that passes when it cannot run reads as
# green.
#
# Usage: check-worker.sh   (no arguments)
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -d node_modules ]; then
	echo "check-worker: node_modules is missing; run 'npm ci' in the repository root" >&2
	exit 1
fi

npx tsc -p worker/tsconfig.json
npx biome check

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
npx tsc -p worker/tsconfig.build.json --outDir "$WORK/dist"
if ! diff -r "$WORK/dist" worker/dist >"$WORK/diff" 2>&1; then
	cat "$WORK/diff" >&2
	echo "check-worker: worker/dist is not what worker/src builds; run 'npm run build' and commit it" >&2
	exit 1
fi

node --test worker/test/ >"$WORK/tests" 2>&1 || {
	cat "$WORK/tests" >&2
	echo "check-worker: the Worker's tests failed" >&2
	exit 1
}
passed="$(sed -n 's/^.*pass \([0-9][0-9]*\).*$/\1/p' "$WORK/tests" | tail -1)"
if [ -z "$passed" ] || [ "$passed" -eq 0 ]; then
	cat "$WORK/tests" >&2
	echo "check-worker: no test ran: a suite that checks nothing is not green" >&2
	exit 1
fi

node worker/bin/check-queries.mjs worker/queries

echo "check-worker: types, format, build and $passed tests are clean"
