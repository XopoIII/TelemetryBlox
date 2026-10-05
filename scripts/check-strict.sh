#!/usr/bin/env sh
# Every Luau file in this repository is `--!strict`, with no opt-outs.
#
# WHY IT IS ENFORCED RATHER THAN AGREED: Luau's default is `nonstrict`, which silently accepts what
# strict mode would reject. A file that arrives without a directive is not "unannotated", it is
# unchecked - and the type gate then reports the tree as clean while whole files go unexamined.
#
# Line 1 must be exactly `--!strict`, and no `--!nonstrict` or `--!nocheck` may appear anywhere.
#
# Usage: check-strict.sh [<file> ...]   (no arguments: every tracked .luau file)
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

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

	if [ "$(head -1 "$file")" != "--!strict" ]; then
		echo "check-strict: $file does not start with '--!strict' on line 1" >&2
		status=1
	fi
	if grep -nE '^--!(nonstrict|nocheck)' "$file" >/dev/null; then
		echo "check-strict: $file opts out of strict mode" >&2
		status=1
	fi
done

if [ "$status" -ne 0 ]; then
	echo "" >&2
	echo "Every Luau file starts with '--!strict' and never opts out." >&2
fi

exit "$status"
