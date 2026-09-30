#!/usr/bin/env bash
# What an assistant shows the person, measured: real headless Claude Code (try-claude.sh's -p) walks ana's and bob's
# story on a throwaway sandbox, and every answer bob gets is saved for score.mjs. Run it on two checkouts to compare
# their words (e.g. main and a branch):
#   qa/person-eval/run.sh <checkout> <out dir> [tries (3)] [model (haiku)]
# Spends a little on your Claude login (about 7 short answers per try, each capped at $0.50 by try-claude.sh); score.mjs
# says what it cost. Each answer is saved as its stream-json trace (<try>-<ask>.jsonl, ana's setup as <try>-setup-*.jsonl)
# and as the text the person read (<try>-<ask>.md); meta.json says which checkout and model.
set -euo pipefail
REPO=$(cd "${1:?checkout}" && pwd); OUT=${2:?out dir}; TRIES=${3:-3}; MODEL=${4:-haiku}
mkdir -p "$OUT"
TRY="$REPO/qa/try-claude.sh"
HERE=$(cd "$(dirname "$0")" && pwd)
printf '{"sha": "%s", "model": "%s", "tries": %s, "started": "%s"}\n' "$(git -C "$REPO" rev-parse --short HEAD)" "$MODEL" "$TRIES" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$OUT/meta.json"
export SC_TRY_TRACE=1
# The text of a saved trace's answer (the product's own trace parser)
text_of() { node --input-type=module -e "import { readAnswer } from '$HERE/measure.ts'; import { readFileSync } from 'node:fs'; process.stdout.write(readAnswer(readFileSync(process.argv[1], 'utf8')).text.trimEnd() + '\n')" "$1"; }
# bob's asks, in story order (setup steps between them are ana's and aren't scored)
for t in $(seq 1 "$TRIES"); do
  export SC_TRY_DIR; SC_TRY_DIR=$(mktemp -d /tmp/sc-eval.XXXXXX); rmdir "$SC_TRY_DIR"
  "$TRY" install >/dev/null
  n=0
  ask() {  # who scenario [extra words]: the trace saved (bob's as <try>-<ask>, ana's as <try>-setup-<ask>-<n>)
    local who=$1 s=$2 out f; shift 2
    # ana's steps are setup, not scored, and run on Haiku, which publishes in one answer (a larger model shows the preview
    # and waits for a yes that a one-answer claude -p can't give)
    local model=$MODEL; [ "$who" = ana ] && model=haiku
    out=$("$TRY" launch "$who" "$s" "$@" -p --model "$model" </dev/null 2>&1) || true   # no stdin: claude -p would wait on it
    if [ "$who" = bob ]; then f="$OUT/$t-$s.jsonl"; else n=$((n + 1)); f="$OUT/$t-setup-$s-$n.jsonl"; fi
    printf '%s\n' "$out" >"$f"
    [ "$who" = bob ] && text_of "$f" >"$OUT/$t-$s.md"
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
