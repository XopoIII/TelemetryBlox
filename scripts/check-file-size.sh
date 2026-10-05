#!/usr/bin/env sh
# Keeps source files at a size a person can hold in their head.
#
# The limit is 300 lines for Luau files, with no exceptions. A file that reaches it is split into
# modules; it is not listed here.
#
# Usage: check-file-size.sh [<file> ...]   (no arguments: every tracked .luau file)
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LIMIT=300

if [ "$#" -eq 0 ]; then
	set -- $(git ls-files '*.luau')
fi

status=0
for file in "$@"; do
	[ -f "$file" ] || continue
	case "$file" in
		*.luau) ;;
		*) continue ;;
	esac

	lines=$(wc -l < "$file" | tr -d ' ')
	if [ "$lines" -gt "$LIMIT" ]; then
		echo "check-file-size: $file is $lines lines, over the $LIMIT line limit" >&2
		echo "  Split it into modules." >&2
		status=1
	fi
done

exit "$status"
