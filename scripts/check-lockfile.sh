#!/usr/bin/env sh
# Every package in package-lock.json is fetched from the public npm registry.
#
# WHY IT IS ENFORCED: npm writes into the lockfile the host each archive was downloaded from. A lock
# made on a machine whose npm points at a mirror names that mirror for every new package, and
# `npm ci` then asks it again, wherever it runs. A mirror that is not public does not resolve in CI
# or on anyone else's machine, so the install fails before a single gate has run. That happened
# once; this is the gate that finds it before the push.
#
# It runs before `npm ci` in CI and needs nothing installed.
#
# Usage: check-lockfile.sh [<lockfile>]   (no argument: package-lock.json of the repository)
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="${1:-$ROOT/package-lock.json}"
REGISTRY="https://registry.npmjs.org/"

if [ ! -f "$LOCK" ]; then
	echo "check-lockfile: $LOCK is missing" >&2
	exit 1
fi

total="$(grep -c '"resolved": "' "$LOCK" || true)"
if [ "$total" -eq 0 ]; then
	echo "check-lockfile: $LOCK names no package: a gate that checks nothing is not green" >&2
	exit 1
fi

foreign="$(grep '"resolved": "' "$LOCK" | grep -v "\"resolved\": \"$REGISTRY" || true)"
if [ -n "$foreign" ]; then
	echo "$foreign" >&2
	echo "" >&2
	echo "check-lockfile: the lines above are not fetched from $REGISTRY" >&2
	echo "Make the lock again with 'npm install --registry=$REGISTRY'." >&2
	exit 1
fi

echo "check-lockfile: all $total packages come from $REGISTRY"
