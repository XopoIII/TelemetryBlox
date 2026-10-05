#!/usr/bin/env sh
# Runs the whole suite on LuneBlox: every spec listed in tests/Run.luau.
#
# `--yes` answers LuneBlox's prompts, which would otherwise throw with no TTY (hooks and CI).
#
# Usage: run-tests.sh   (no arguments)
set -e
export PATH="$HOME/.rokit/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

luneblox run tests/Run --yes
