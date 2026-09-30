#!/usr/bin/env bash
# What an assistant shows the person, measured: real headless Claude Code (try-claude.sh's -p) walks ana's and bob's
# story on a throwaway sandbox, and every answer bob gets is saved for score.mjs. Run it on two checkouts to compare
# their words (e.g. main and a branch):
#   qa/person-eval/run.sh <checkout> <out dir> [tries (3)] [model (haiku)]
# Spends a little on your Claude login (about 7 short answers per try, each capped at $0.50 by try-claude.sh).
set -euo pipefail
REPO=$(cd "${1:?checkout}" && pwd); OUT=${2:?out dir}; TRIES=${3:-3}; MODEL=${4:-haiku}
mkdir -p "$OUT"
TRY="$REPO/qa/try-claude.sh"
# bob's asks, in story order (setup steps between them are ana's and aren't scored)
for t in $(seq 1 "$TRIES"); do
  export SC_TRY_DIR; SC_TRY_DIR=$(mktemp -d /tmp/sc-eval.XXXXXX); rmdir "$SC_TRY_DIR"
  "$TRY" install >/dev/null
  ask() {  # who scenario [extra words]: the answer, saved when it's bob's
    local who=$1 s=$2 out; shift 2
    # ana's steps are setup, not scored, and run on Haiku, which publishes in one answer (a larger model shows the preview
    # and waits for a yes that a one-answer claude -p can't give)
    local model=$MODEL; [ "$who" = ana ] && model=haiku
    out=$("$TRY" launch "$who" "$s" "$@" -p --model "$model" </dev/null 2>&1) || true   # no stdin: claude -p would wait on it
    [ "$who" = bob ] && printf '%s\n' "$out" >"$OUT/$t-$s.md"
    return 0
  }
  # ana's publish is setup: asked again (up to 3 times) while her assistant only previews it
  published() { grep -qE "ana +publish_skill_to_catalog +published +release-note-draft v$1" "$SC_TRY_DIR/activity.log" 2>/dev/null; }
  setup() {  # scenario version
    for _ in 1 2 3; do ask ana "$1" "Yes, go ahead, I confirm."; published "$2" && return 0; done
    echo "person-eval: try $t: ana's $1 never published (the try will be left out)" >&2
  }
  setup publish 1
  ask bob search
  ask bob search-miss
  ask bob install
  setup publish-v2 2
  ask bob diff
  ask bob update
  ask bob list
  cp "$SC_TRY_DIR/activity.log" "$OUT/$t-activity.log"
  "$TRY" uninstall >/dev/null
  echo "person-eval: try $t of $TRIES done ($REPO)"
done
