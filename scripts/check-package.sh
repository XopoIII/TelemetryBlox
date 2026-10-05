#!/usr/bin/env sh
# The package carries every file of the library: each tracked file under src/ is in the pesde archive.
#
# WHY IT IS CHECKED: pesde reads `includes` as globs, so `"src"` matches the folder and nothing in
# it. A package built that way holds only what the glob names, its first `require("@self/...")` fails
# in any game that installs it, and every spec here still passes against the source tree. Only a look
# at the built package finds that. (KeepBlox shipped three such versions before it had this check.)
#
# `pesde publish --dry-run` packs the archive and publishes nothing.
#
# Usage: check-package.sh
set -e
export PATH="$HOME/.rokit/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git ls-files src | sort >"$WORK/expected"
if [ ! -s "$WORK/expected" ]; then
	echo "check-package: no tracked files under src/" >&2
	exit 1
fi

# pesde writes package.tar.gz next to the manifest, so it packs a copy of the tracked files (with
# rokit.toml, which rokit reads to find the pinned pesde).
mkdir "$WORK/pesde"
git ls-files src pesde.toml pesde.lock rokit.toml README.md LICENSE | while read -r file; do
	mkdir -p "$WORK/pesde/$(dirname "$file")"
	cp "$file" "$WORK/pesde/$file"
done
(cd "$WORK/pesde" && pesde publish --dry-run --yes >"$WORK/pesde.log" 2>&1) || {
	cat "$WORK/pesde.log" >&2
	echo "check-package: pesde publish --dry-run failed" >&2
	exit 1
}
tar -tzf "$WORK/pesde/package.tar.gz" | grep '^src/.*\.luau$' | sort >"$WORK/pesde.list"

missing="$(comm -23 "$WORK/expected" "$WORK/pesde.list")"
if [ -n "$missing" ]; then
	echo "check-package: the pesde package leaves out:" >&2
	echo "$missing" | sed 's/^/  /' >&2
	exit 1
fi

echo "check-package: the pesde package carries all $(wc -l <"$WORK/expected" | tr -d ' ') files of src/"
