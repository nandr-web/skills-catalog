#!/usr/bin/env bash
# Records the README's reels: real Claude Code sessions (no stand-ins) on this checkout's MCP server, typed by this
# script into a terminal as a person would, recorded with asciinema and rendered to GIFs with agg.
#   qa/reels/record.sh [publish] [install] [update]      (default: all three, in that order: each needs the one before)
#   qa/reels/record.sh stills                            the README's screenshots instead: one PNG per use case (shot-*.png),
#                                                        each the last screen of its own Claude Code session (needs ffmpeg
#                                                        and ImageMagick's magick)
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
[ "${REELS[*]}" = stills ] && H=56   # a still is one screen: tall enough that an answer never scrolls its question away
NEEDS=(tmux "$ASCIINEMA" "$AGG" claude git node); [ "${REELS[*]}" = stills ] && NEEDS+=(ffmpeg magick)
for t in "${NEEDS[@]}"; do command -v "$t" >/dev/null || { echo "record: $t isn't on PATH" >&2; exit 1; }; done

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
record() {  # name who [still]: records what the reel_<name> function does, then checks and renders it (a GIF, or a still)
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
  quiet_account "$cast"
  check "$cast"
  screens "$cast"
  if [ "${3:-}" = still ]; then still "$cast" "$OUT/shot-${1#s_}.png"; return; fi
  "$AGG" --font-size 14 --fps-cap 15 --idle-time-limit 2 --last-frame-duration 5 "$cast" "$OUT/reel-$1.gif" 2>/dev/null
  echo "record: $OUT/reel-$1.gif ($(du -h "$OUT/reel-$1.gif" | cut -f1))"
}
still() {  # cast png: its last screen, drawn larger, with the empty rows below it cut and an even margin all round
  local gif="${1%.cast}.gif" last="${1%.cast}.png" bg
  "$AGG" --font-size 20 --idle-time-limit 1 --last-frame-duration 1 "$1" "$gif" 2>/dev/null
  ffmpeg -loglevel error -y -i "$gif" -vf reverse -frames:v 1 "$last"
  bg=$(magick "$last" -format '%[pixel:p{0,0}]' info:)
  magick "$last" -bordercolor "$bg" -border 1 -fuzz 8% -trim +repage -border 24 "$2"
  echo "record: $2 ($(magick identify -format '%wx%h' "$2"))"
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
quiet_account() {  # Claude Code's notices about the signed-in account's usage (how much of its limit, when it resets, in
  # which timezone), the account's plan in its header ("Claude Pro"), and its "Resume this session" lines as it exits (they
  # name the session), say nothing about the
  # catalog and aren't the recorder's to publish: each is blanked where it's drawn,
  # one space per character, so every other cell stays where it was. tmux colours each word on its own, so the notice is
  # found in the text as seen (colour codes left out) and blanked around them. check() then fails a cast with any left.
  python3 - "$1" <<'PY'
import json, re, sys
cast = sys.argv[1]
# The notice from its start, or any piece of it tmux redraws on its own after moving the cursor.
notice = re.compile(r"((You've used \d+% of your|You're close to|Approaching (your )?\w+|You're now using|Now using) "
                    r"|(Your )?(weekly|daily|monthly|five-hour|session) limit|usage (credits|allocation)|extra usage"
                    r"|resets \w+ \d+|\((America|Europe|Asia|Africa|Australia|Pacific|Atlantic|Indian|Antarctica|Etc)/"
                    r"|Resume this session|claude --resume|(· )?Claude (Pro|Max|Team|Enterprise)\b)[^\n]*")
piece_words = re.compile(r"credits|weekly|allocation|resets|extra usage|\w+/[A-Z][a-z]+_[A-Z]|Resume this|--resume")
token = re.compile(r"\x1b\[[0-9;]*m|\x1b\[[0-?]*[ -/]*[@-~]|\x1b.|[\r\n]|.", re.S)
def quiet(data):
    parts = token.findall(data)
    seen, at = [], []  # the text as seen: colour codes skipped, any other control a line break
    for i, p in enumerate(parts):
        if re.fullmatch(r"\x1b\[[0-9;]*m", p): continue
        seen.append(p if len(p) == 1 and p not in "\r\n" and p != "\x1b" else "\n"); at.append(i)
    text = "".join(seen)
    for m in notice.finditer(text):
        for k in range(m.start(), m.end()): parts[at[k]] = " "
    # tmux may redraw a notice from the middle of a word ("sage credits"): any piece it draws on its own (between two
    # cursor moves) that holds one of the notice's words is blanked whole.
    start = 0
    for piece in text.split("\n"):
        if piece_words.search(piece):
            for k in range(start, start + len(piece)): parts[at[k]] = " "
        start += len(piece) + 1
    return "".join(parts)
# tmux splits its output anywhere, escape codes included: the whole stream is quieted at once, then cut back into the
# same events (a blanked character is one space, so every event keeps its length).
lines = open(cast).read().splitlines()
events = [json.loads(l) for l in lines[1:]]
shown = [e for e in events if e[1] == "o"]
whole = quiet("".join(e[2] for e in shown))
at = 0
for e in shown:
    e[2], at = whole[at:at + len(e[2])], at + len(e[2])
open(cast, "w").write("\n".join([lines[0]] + [json.dumps(e, ensure_ascii=False) for e in events]) + "\n")
PY
}
screens() {  # every screen of the cast, as a terminal draws it (asciinema's own emulator), shows none of the account's usage,
  # nor Claude Code's resume lines (they name the session), nor a Ctrl-L printed as ^L
  python3 - "$1" "$ASCIINEMA" "$H" <<'PY'
import re, subprocess, sys
cast, asciinema, rows = sys.argv[1], sys.argv[2], int(sys.argv[3])
bad = re.compile(r"credits|weekly|allocation|resets|\w+/[A-Z][a-z]+_[A-Z]|Resume this session|claude --resume|\^L|Claude (Pro|Max|Team|Enterprise)\b")
lines = open(cast).read().splitlines()
part = cast + ".part"
for n in range(2, len(lines) + 1):
    open(part, "w").write("\n".join(lines[:n]) + "\n")
    shown = "\n".join(subprocess.run([asciinema, "convert", "-f", "txt", part, "-"], capture_output=True, text=True, check=True).stdout.splitlines()[-rows:])
    m = bad.search(shown)
    if m: sys.exit(f"record: {cast} screen {n - 1} shows {shown[max(0, m.start() - 30):m.end() + 30]!r}")
print(f"record: {cast.rsplit('/', 1)[-1]}: {len(lines) - 1} screens checked")
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
# nor anything of the account's usage (quiet_account blanks it)
look += ["weekly", "credits", "allocation", "resets", "extrausage", "America/", "Europe/", "Asia/"]
# nor Claude Code's resume lines (quiet_account blanks them too)
look += ["Resumethissession", "--resume", "ClaudePro", "ClaudeMax", "ClaudeTeam", "ClaudeEnterprise"]
found = [w for w in look if len(w) > 2 and w in flat]
sys.exit(f"record: {cast} shows {found}") if found else print(f"record: {cast.rsplit('/', 1)[-1]} clean")
PY
}

# Out of Claude Code, back in the person's shell, on a clear screen. Claude Code's "Resume this session" lines, drawn as it
# exits, are blanked in the cast by quiet_account (clearing after them still showed them for a frame).
back_to_shell() {
  # Ctrl-C twice, not /exit: typing a slash opens Claude Code's command menu, which lists this machine's own commands.
  sleep 2; T send-keys -t r C-c; sleep 0.6; T send-keys -t r C-c
  # the shell's own prompt on the last line, then a breath: Ctrl-L sent while Claude Code is still exiting prints as ^L
  local end=$((SECONDS + 30))
  until screen | grep -v '^ *$' | tail -1 | grep -qE '\$ *$'; do ((SECONDS < end)) || { echo "record: no shell prompt after Claude Code" >&2; return 1; }; sleep 0.3; done
  sleep 1
  T send-keys -t r C-l; sleep 1
}
# The stills: each one ask in a fresh Claude Code session (its screen shows only that), in the story's order.
ask_claude() { say claude; wait_for "Claude Code v" 60; sleep 1; say "$1"; turn; }
reel_s_publish() { reel_publish; }
reel_s_search() { ask_claude "Find a shared skill for writing release notes"; }
reel_s_install() { ask_claude "Install release-note-draft from the shared catalog into this project"; }
reel_s_list() { ask_claude "Which shared skills do I have installed?"; }
reel_s_update() { ask_claude "Update my shared skills"; }
reel_s_closest() { ask_claude "Find a shared skill for a graphql schema"; }
reel_s_terminal() {  # the person's own terminal: the change, then taking it
  say "skills-catalog diff release-note-draft --from 1 --to 2"; sleep 4
  say "skills-catalog update release-note-draft --accept"; wait_for "Take it\\?" 60; sleep 2
  say "y"; wait_for "Took it" 60; sleep 2
}
# Off camera, ana publishes with Haiku in one answer, asked again (up to 3 times) while it only previews.
off_camera_publish() {  # scenario-or-words skill version
  for _ in 1 2 3; do
    "$C/qa/try-claude.sh" launch ana "$1" "Yes, go ahead, I confirm." -p --model haiku >/dev/null 2>&1 </dev/null || true
    grep -qE "ana +publish_skill_to_catalog +published +$2 v$3" "$SC_TRY_DIR/activity.log" 2>/dev/null && return 0
  done
  echo "record: ana's publish of $2 v$3 didn't happen" >&2; return 1
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
  # The person looks at the change in their own terminal, then takes it there (both stay on screen).
  say "skills-catalog diff release-note-draft --from 1 --to 2"; sleep 4
  say "skills-catalog update release-note-draft --accept"; wait_for "Take it\\?" 60; sleep 3
  say "y"; wait_for "Took it|Took the held update" 60; sleep 3
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
    stills)
      record s_publish ana still
      off_camera_publish "Publish my skill in ./sql-migrations to the shared skills catalog." sql-migrations 1
      record s_search bob still
      record s_install bob still
      off_camera_publish publish-v2 release-note-draft 2
      record s_list bob still
      record s_update bob still
      record s_closest bob still
      record s_terminal bob still ;;
    *) echo "record: no reel $r (publish, install, update, stills)" >&2; exit 1 ;;
  esac
done
