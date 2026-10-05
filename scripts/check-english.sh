#!/usr/bin/env sh
# Every artefact in this repository is written in English.
#
# Code, comments, documentation, commit bodies, agent instructions - all of it. The rule is enforced
# rather than agreed because a stray non-English word is invisible to a reviewer who does not read
# that language, and it is permanent once it lands.
#
# WHAT IT LOOKS FOR: a LETTER outside ASCII - Cyrillic, Greek, CJK, a Latin letter carrying a
# diacritic. Not "any byte above 127": box-drawing characters and em dashes are punctuation and stay
# allowed, and `\p{L}` matches neither. `-CSD` is load-bearing: without it perl reads bytes, and every
# multi-byte character decodes into Latin-1 bytes that ARE letters.
#
# Test data that exists to exercise Unicode handling builds its strings from escapes (`\u{...}`),
# so it needs no exemption.
#
# Usage: check-english.sh [<file> ...]   (no arguments: every tracked file)
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ "$#" -eq 0 ]; then
	set -- $(git ls-files)
fi

status=0
for file in "$@"; do
	[ -f "$file" ] || continue
	case "$file" in
		# Files that are not prose.
		*.lock | *.png | *.ico | *.rbxl | *.rbxm | *.rbxlx | *.rbxmx) continue ;;
	esac

	hits=$(perl -CSD -ne 'if (/(?=\P{ASCII})\p{L}/) { print "  $ARGV:$.: $_" }' -- "$file" 2>/dev/null || true)
	if [ -n "$hits" ]; then
		echo "check-english: non-English text in $file" >&2
		echo "$hits" >&2
		status=1
	fi
done

if [ "$status" -ne 0 ]; then
	echo "" >&2
	echo "Everything in this repository is written in English. Rewrite the lines above." >&2
fi

exit "$status"
