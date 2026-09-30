#!/usr/bin/env bash
# Records the README's reels: real Claude Code sessions (no stand-ins) on this checkout's MCP server, typed by this
# script into a terminal as a person would, recorded with asciinema and rendered to GIFs with agg.
#   qa/reels/record.sh [publish] [install] [update]      (default: all three, in that order: each needs the one before)
# Needs tmux, asciinema 3 and agg (ASCIINEMA= and AGG= name them if they aren't on PATH), and Claude Code signed in.
# Everything runs in a fresh clone under /tmp/reel.* (short, neutral paths on screen), deleted at the end. Each cast is
# checked for this machine's names (home, user, host) before it's rendered; the GIFs go to docs/pictures/ (REEL_OUT=).
# Claude Code runs on REEL_MODEL (default sonnet) with the tools setup pre-allows, so publishing and taking a held
# update meet its permission prompt, which the script answers yes (the person's consent, on camera).
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
ASCIINEMA=${ASCIINEMA:-asciinema}; AGG=${AGG:-agg}; MODEL=${REEL_MODEL:-sonnet}; OUT=${REEL_OUT:-$REPO/docs/pictures}
W=112; H=34; SOCK="reel-$$"
REELS=("$@"); [ ${#REELS[@]} -gt 0 ] || REELS=(publish install update)
for t in tmux "$ASCIINEMA" "$AGG" claude git node; do command -v "$t" >/dev/null || { echo "record: $t isn't on PATH" >&2; exit 1; }; done

BASE=$(mktemp -d /tmp/reel.XXXXXX)
cleanup() { tmux -L "$SOCK" kill-server 2>/dev/null || true; rm -rf "$BASE"; }
trap cleanup EXIT
echo "record: a clean clone of HEAD in $BASE"
git clone --quiet --no-local "$REPO" "$BASE/skills-catalog"
C="$BASE/skills-catalog"
export SC_TRY_DIR="$BASE/sc"
"$C/qa/try-claude.sh" install >/dev/null

t=mcp__skills-catalog__
ALLOWED="${t}search_shared_skills,${t}read_shared_skill,${t}list_shared_skill_versions,${t}diff_shared_skill_versions,${t}install_shared_skill,${t}update_installed_skills,${t}list_installed_skills"

# The shell each developer's reel runs: their prompt, their project, `claude` wired to the catalog, the CLI as them.
rcfile() {
  cat >"$BASE/$1.rc" <<EOF
PS1='\[\e[1;36m\]$1\[\e[0m\] \$ '
cd "$SC_TRY_DIR/$1"
claude() { command claude --strict-mcp-config --mcp-config "$SC_TRY_DIR/$1/.mcp.json" --model $MODEL --setting-sources project,local --permission-mode default --allowedTools "$ALLOWED" "\$@"; }
skills-catalog() { "$C/qa/try-claude.sh" cli $1 "\$@"; }
export SC_TRY_DIR="$SC_TRY_DIR"
EOF
}
T() { tmux -L "$SOCK" "$@"; }
screen() { T capture-pane -p -t r 2>/dev/null || true; }
wait_for() {  # regex [seconds]
  local end=$((SECONDS + ${2:-120}))
  until screen | grep -qE "$1"; do
    if ((SECONDS > end)); then echo "record: timed out waiting for /$1/" >&2; screen | tail -15 >&2; return 1; fi
    sleep 0.5
  done
}
say() { T send-keys -t r -l "$1"; sleep 0.4; T send-keys -t r Enter; }
# One Claude turn: answer each permission prompt yes, until nothing runs and nothing asks for 3 s.
turn() {
  local quiet=0 end=$((SECONDS + 300)) s
  sleep 2
  while ((quiet < 6)); do
    ((SECONDS > end)) && { echo "record: a turn took over 5 minutes" >&2; return 1; }
    s=$(screen)
    if grep -q "Do you want to proceed" <<<"$s"; then sleep 2; T send-keys -t r Enter; quiet=0; sleep 1; continue; fi
    if grep -qE "esc to interrupt|\([0-9]+s ·" <<<"$(tail -8 <<<"$s")"; then quiet=0; else quiet=$((quiet + 1)); fi
    sleep 0.5
  done
}
shell_for() {  # who: a fresh tmux session running their shell
  T kill-server 2>/dev/null || true
  rcfile "$1"
  T -f /dev/null new-session -d -s r -x "$W" -y "$H" "env -i HOME='$HOME' USER='$USER' LOGNAME='$USER' PATH='$PATH' TERM=xterm-256color LANG=en_US.UTF-8 bash --rcfile $BASE/$1.rc -i"
  T set -g status off
  wait_for "$1.*\\$"
}
# Claude Code asks once whether to trust a folder; answered here, off camera, so the reels start at its prompt.
trust() {
  shell_for "$1"; say claude
  wait_for "trust this folder|Claude Code v" 60
  if screen | grep -q "trust this folder"; then T send-keys -t r Down; sleep 0.3; T send-keys -t r Enter; wait_for "Claude Code v" 60; fi
  sleep 1; say "/exit"; sleep 2
}
record() {  # name: records what the reel_<name> function does, then checks and renders it
  local cast="$BASE/$1.cast"
  shell_for "$2"
  "$ASCIINEMA" rec --headless --quiet --overwrite --window-size "${W}x$H" -c "tmux -L $SOCK attach -t r" "$cast" &
  local rec=$!
  sleep 1.5
  "reel_$1"
  sleep 3
  T kill-server
  wait "$rec" || true
  trim "$cast"
  check "$cast"
  "$AGG" --font-size 14 --fps-cap 15 --idle-time-limit 2 --last-frame-duration 5 "$cast" "$OUT/reel-$1.gif" 2>/dev/null
  echo "record: $OUT/reel-$1.gif ($(du -h "$OUT/reel-$1.gif" | cut -f1))"
}
trim() {  # the cast ends where the reel does: tmux closing (its "[server exited]", the screen it restores) isn't shown
  python3 - "$1" <<'PY'
import sys
cast = sys.argv[1]
lines = open(cast).read().splitlines(keepends=True)
# In the file, JSON writes the escape as the six characters \u001b. Only the last few events are tmux closing.
said = ("[server exited]", "[exited]", "[detached")
restore = "\\u001b[?1049l"
cut = next((i for i in range(len(lines) - 1, 0, -1) if any(e in lines[i] for e in said)), len(lines))
while cut > max(1, len(lines) - 6) and restore in lines[cut - 1]:
    cut -= 1
open(cast, "w").writelines(lines[:cut])
PY
}
check() {  # a cast holds nothing of this machine: its home, user or host, joined across wrapped rows
  python3 - "$1" "$HOME" "$(id -un)" "$(hostname -s)" <<'PY'
import json, re, sys
cast, *words = sys.argv[1:]
esc = re.compile(r"\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[()][0-9A-Za-z]|[=>78DEHMc])")
body = "".join(e[2] for e in map(json.loads, open(cast).read().splitlines()[1:]) if e[1] == "o")
flat = re.sub(r"[\s─-╿]", "", esc.sub("", body))
home, user, host = words
# a short user name is an ordinary word too: look for it where it names this machine (a path, an address)
look = [home, f"/{user}/", f"{user}@", host, "pax8", "Pax8", "/Users/", "/var/folders"]
found = [w for w in look if len(w) > 2 and w in flat]
sys.exit(f"record: {cast} shows {found}") if found else print(f"record: {cast.rsplit('/', 1)[-1]} clean")
PY
}

# Out of Claude Code, back in the person's shell, on a clear screen (without Claude Code's "Resume this session" lines).
back_to_shell() {
  sleep 2; say "/exit"; wait_for "Resume this session|\\$ *$" 30; sleep 0.5
  T send-keys -t r C-l; sleep 1
}
reel_publish() {
  say claude; wait_for "Claude Code v" 60; sleep 1
  say "Publish my skill in ./release-note-draft to the shared skills catalog"; turn
  say "yes, publish it"; turn
}
reel_install() {
  say claude; wait_for "Claude Code v" 60; sleep 1
  say "Find a shared skill for writing release notes and install it into this project"; turn
  back_to_shell
  say "skills-catalog list"; sleep 3
}
reel_update() {
  say claude; wait_for "Claude Code v" 60; sleep 1
  say "Update my shared skills"; turn
  back_to_shell
  # The person looks at the change in their own terminal, then takes it there.
  say "skills-catalog diff release-note-draft --from 1 --to 2"; sleep 4
  T send-keys -t r C-l; sleep 0.5
  say "skills-catalog update release-note-draft --accept"; wait_for "Take it\\?" 60; sleep 3
  say "y"; wait_for "Took the held update" 60; sleep 3
}

mkdir -p "$OUT"
trust ana; trust bob
for r in "${REELS[@]}"; do
  case "$r" in
    publish) record publish ana ;;
    install) record install bob ;;
    update)
      # Off camera: ana publishes version 2, which adds a script (Haiku, answering once).
      "$C/qa/try-claude.sh" launch ana publish-v2 "Yes, publish it." -p --model haiku >/dev/null
      record update bob ;;
    *) echo "record: no reel $r (publish, install, update)" >&2; exit 1 ;;
  esac
done
