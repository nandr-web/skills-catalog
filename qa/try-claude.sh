#!/usr/bin/env bash
# Try the skills catalog in real Claude Code: two developers (ana and bob), each a project folder whose Claude Code
# starts this checkout's MCP server, sharing one catalog. Everything lives in one sandbox folder; nothing is written to
# your ~/.claude/skills (each developer's user-level skills folder is inside the sandbox too). Run with no arguments
# for help.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX="${SC_TRY_DIR:-$HOME/sc-try}"
MARKER=".skills-catalog-try-claude"
SKILLS="$REPO/qa/demo/skills"
DEVELOPERS="ana bob"

usage() {
  cat <<EOF
try-claude: the skills catalog in real Claude Code, two developers (ana, bob), one shared catalog

  install                   install this checkout's packages (core, client) and make the sandbox
  uninstall                 delete the sandbox (the packages in this checkout stay)
  reset                     uninstall, then install: an empty catalog again
  launch <who> [<scenario> | "<your own words>"] [-p] [--model <m>]
                            start Claude Code as ana or bob, in their project, wired to the catalog;
                            a scenario (below) is typed as the first prompt; -p answers once and exits
                            (-p pre-allows the catalog's tools except accept_held_update)
  accept [<who>]            take the held update, in your own terminal (default bob): you answer its y/N
  cli <who> <args...>       run the skills-catalog CLI as that developer (e.g. cli bob list)
  log                       follow the catalog's activity log (one line per tool call)
  status                    what's published, what each developer has installed, the last log lines
  selftest [--model <m>]    the whole walk-through with real claude -p (default haiku) in a throwaway
                            sandbox, checked step by step; costs a few cents

Scenarios:
  ana publish               publish ./release-note-draft and ./sql-migrations (v1)
  ana publish-v2            swap in version 2 (adds scripts/collect.sh) and publish it
  <who> search              find a skill for release notes
  <who> search-miss         find a skill for a graphql schema (nothing fits exactly)
  bob install               find the release-notes skill and install it into this project
  bob diff                  what changed between v1 and v2
  bob update                update installed skills (a risky one is held for your OK)
  bob publish               publish his own fix over ana's skill (refused: not the owner)
  <who> list                which shared skills are installed

A walk-through: install; launch ana publish; launch bob install; launch ana publish-v2;
launch bob diff; launch bob update; accept; status; uninstall.

Sandbox: $SANDBOX (set SC_TRY_DIR to move it). Checkout: $REPO
EOF
}

die() { echo "try-claude: $*" >&2; exit 1; }

node_ok() {
  command -v node >/dev/null || die "node isn't on your PATH; install Node.js 24.15 or later"
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>24||(a===24&&b>=15)?0:1)' \
    || die "Node.js $(node --version) is too old; the catalog needs 24.15 or later"
}
claude_ok() { command -v claude >/dev/null || die "claude isn't on your PATH; install Claude Code first"; }
need_sandbox() { [ -f "$SANDBOX/$MARKER" ] || die "no sandbox at $SANDBOX; run: $0 install"; }
check_who() { case " $DEVELOPERS " in *" $1 "*) ;; *) die "no developer \"$1\" (ana or bob)";; esac; }

# The settings a developer's MCP server and CLI get: their own home and skills folders in the sandbox, one catalog.
dev_env() {
  local who="$1"
  echo "SKILLS_CATALOG=file://$SANDBOX/catalog"
  echo "SKILLS_HOME=$SANDBOX/home-$who"
  echo "SKILLS_ASSISTANT_HOME=$SANDBOX/home-$who"
  echo "SKILLS_AS=$who"
  echo "SKILLS_ACTIVITY_LOG=$SANDBOX/activity.log"
}

write_mcp_config() {
  local who="$1" node; node="$(command -v node)"
  local envs; envs="$(dev_env "$who" | sed 's/^\([^=]*\)=\(.*\)$/        "\1": "\2",/' | sed '$ s/,$//')"
  cat >"$SANDBOX/$who/.mcp.json" <<EOF
{
  "mcpServers": {
    "skills-catalog": {
      "type": "stdio",
      "command": "$node",
      "args": ["--disable-warning=ExperimentalWarning", "$REPO/client/src/cli.ts", "mcp"],
      "env": {
$envs
      }
    }
  }
}
EOF
}

cmd_install() {
  node_ok; claude_ok
  for pkg in core client; do
    if [ ! -d "$REPO/$pkg/node_modules" ]; then
      echo "Installing $pkg's packages..."
      (cd "$REPO/$pkg" && npm ci --ignore-scripts --silent)
    fi
  done
  if [ -e "$SANDBOX" ] && [ ! -f "$SANDBOX/$MARKER" ]; then die "$SANDBOX exists and isn't a try-claude sandbox; set SC_TRY_DIR elsewhere"; fi
  mkdir -p "$SANDBOX"; touch "$SANDBOX/$MARKER" "$SANDBOX/activity.log"
  for who in $DEVELOPERS; do mkdir -p "$SANDBOX/$who"; write_mcp_config "$who"; done
  [ -e "$SANDBOX/ana/release-note-draft" ] || cp -R "$SKILLS/release-note-draft-v1" "$SANDBOX/ana/release-note-draft"
  [ -e "$SANDBOX/ana/sql-migrations" ] || cp -R "$SKILLS/sql-migrations" "$SANDBOX/ana/sql-migrations"
  echo "Ready: $SANDBOX (ana/ and bob/ are the two projects). Next: $0 launch ana publish"
}

cmd_uninstall() {
  if [ ! -e "$SANDBOX" ]; then echo "Nothing to remove at $SANDBOX."; return; fi
  [ -f "$SANDBOX/$MARKER" ] || die "$SANDBOX isn't a try-claude sandbox; not deleting it"
  rm -rf "$SANDBOX"
  echo "Deleted $SANDBOX. (Claude Code may still list its folders as trusted in ~/.claude.json; that's harmless.)"
}

scenario_prompt() {
  local who="$1" s="$2"
  case "$who:$s" in
    ana:publish) echo "Publish my skills in ./release-note-draft and ./sql-migrations to the shared skills catalog." ;;
    ana:publish-v2)
      rm -rf "$SANDBOX/ana/release-note-draft"; cp -R "$SKILLS/release-note-draft-v2" "$SANDBOX/ana/release-note-draft"
      echo "Publish the new version of ./release-note-draft to the shared skills catalog." ;;
    bob:publish)
      rm -rf "$SANDBOX/bob/release-note-draft"; cp -R "$SKILLS/release-note-draft-bob" "$SANDBOX/bob/release-note-draft"
      echo "Publish my fix in ./release-note-draft to the shared skills catalog as a new version of release-note-draft." ;;
    *:search) echo "Find a shared skill for writing release notes from merged pull requests." ;;
    *:search-miss) echo "Find a shared skill for a graphql schema." ;;
    *:install) echo "Find a shared skill for writing release notes from merged pull requests and install it into this project." ;;
    *:diff) echo "What changed in the shared skill release-note-draft between v1 and v2?" ;;
    *:update) echo "Update my shared skills." ;;
    *:list) echo "Which shared skills do I have installed?" ;;
    *) return 1 ;;
  esac
}

cmd_launch() {
  [ $# -ge 1 ] || die "launch <who> [<scenario> | \"<your own words>\"] [-p] [--model <m>]"
  local who="$1"; shift; check_who "$who"; need_sandbox; claude_ok
  local prompt="" print="" model="" p
  while [ $# -gt 0 ]; do
    case "$1" in
      -p|--print) print=1 ;;
      --model) model="${2:?--model needs a value}"; shift ;;
      *) if [ -z "$prompt" ] && p="$(scenario_prompt "$who" "$1")"; then prompt="$p"; else prompt="${prompt:+$prompt }$1"; fi ;;
    esac
    shift
  done
  local args=(--strict-mcp-config --mcp-config "$SANDBOX/$who/.mcp.json")
  [ -n "$model" ] && args+=(--model "$model")
  cd "$SANDBOX/$who"
  if [ -n "$print" ]; then
    [ -n "$prompt" ] || die "-p needs a scenario or your own words"
    # What setup pre-allows, plus publish (answering once, you are the person agreeing to it). Never
    # accept_held_update: its permission prompt is the person's yes, so here a held update stays held.
    local t=mcp__skills-catalog__ allowed
    allowed="${t}search_shared_skills,${t}read_shared_skill,${t}list_shared_skill_versions,${t}diff_shared_skill_versions"
    allowed="$allowed,${t}install_shared_skill,${t}update_installed_skills,${t}list_installed_skills,${t}publish_skill_to_catalog"
    exec claude -p "$prompt" "${args[@]}" --allowedTools "$allowed" --max-budget-usd 0.5
  fi
  [ -n "$prompt" ] && args+=("$prompt")
  exec claude "${args[@]}"
}

run_cli() {
  local who="$1"; shift; check_who "$who"; need_sandbox
  (cd "$SANDBOX/$who" && env $(dev_env "$who") node --disable-warning=ExperimentalWarning "$REPO/client/src/cli.ts" "$@")
}

cmd_status() {
  need_sandbox
  echo "== Installed"
  for who in $DEVELOPERS; do echo "-- $who"; run_cli "$who" list || true; done
  echo "== In each project's .claude/skills"
  for who in $DEVELOPERS; do
    echo "-- $who"; [ -d "$SANDBOX/$who/.claude/skills" ] && (cd "$SANDBOX/$who/.claude/skills" && find . -type f | sort) || echo "(none)"
  done
  echo "== Last log lines"; tail -n 12 "$SANDBOX/activity.log"
}

# --- selftest: the walk-through with claude -p in a throwaway sandbox, each step checked on the catalog's own log ---
st_fail() { echo "FAIL: $*" >&2; echo "(sandbox kept for a look: $SANDBOX)" >&2; exit 1; }
st_expect() { grep -Eq "$1" "$SANDBOX/activity.log" || st_fail "$2: the log has no line matching /$1/"; echo "  ok   $2"; }
st_step() {
  local who="$1" s="$2" out; echo "- $who $s"
  out="$("$0" launch "$who" "$s" "Yes, go ahead, I confirm." -p --model "$ST_MODEL" 2>&1)" || { echo "$out" | tail -20; st_fail "claude -p ($who $s) failed"; }
  echo "$out" | tail -3 | sed 's/^/    │ /'
}
cmd_selftest() {
  ST_MODEL=haiku
  if [ "${1:-}" = --model ]; then ST_MODEL="${2:?--model needs a value}"; fi
  node_ok; claude_ok; command -v tmux >/dev/null || die "selftest needs tmux (for the y/N in a real terminal)"
  SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/sc-try-selftest.XXXXXX")"; rmdir "$SANDBOX"; export SC_TRY_DIR="$SANDBOX"
  cmd_install >/dev/null
  st_step ana publish
  st_expect 'ana .*publish_skill_to_catalog +published +release-note-draft v1' "ana published release-note-draft v1"
  st_expect 'ana .*publish_skill_to_catalog +published +sql-migrations v1' "ana published sql-migrations v1"
  st_step bob install
  st_expect 'bob .*install_shared_skill +installed +release-note-draft v1' "bob installed release-note-draft v1"
  [ -f "$SANDBOX/bob/.claude/skills/release-note-draft/SKILL.md" ] || st_fail "bob's project has no .claude/skills/release-note-draft"
  echo "  ok   it's in bob's project .claude/skills"
  st_step ana publish-v2
  st_expect 'ana .*publish_skill_to_catalog +published +release-note-draft v2' "ana published release-note-draft v2"
  st_step bob update
  st_expect 'bob .*held: needs an OK +release-note-draft v1 → v2' "bob's update was held"
  if grep -q 'accept_held_update +taken' "$SANDBOX/activity.log"; then st_fail "the assistant took the held update without the person's yes"; fi
  [ ! -e "$SANDBOX/bob/.claude/skills/release-note-draft/scripts" ] || st_fail "the held update's script was installed anyway"
  echo "  ok   the script isn't installed yet"
  st_step bob publish
  st_expect 'bob .*publish_skill_to_catalog +refused: not the owner' "bob's publish over ana's skill was refused"
  echo "- bob accepts in a terminal (tmux)"
  local sock="sc-try-$$"
  tmux -L "$sock" new-session -d -x 160 -y 40 "'$0' accept bob; sleep 3"
  for _ in $(seq 1 40); do tmux -L "$sock" capture-pane -p | grep -q 'Take it?' && break; sleep 0.25; done
  tmux -L "$sock" send-keys y Enter; sleep 2; tmux -L "$sock" kill-server 2>/dev/null || true
  st_expect 'bob .*update --accept +taken, with an OK +release-note-draft v2' "bob took the held update"
  [ -f "$SANDBOX/bob/.claude/skills/release-note-draft/scripts/collect.sh" ] || st_fail "scripts/collect.sh isn't in bob's project"
  echo "  ok   scripts/collect.sh is in bob's project"
  cmd_uninstall >/dev/null
  echo "PASS: every step seen with real Claude Code ($ST_MODEL); sandbox deleted"
}

cmd="${1:-help}"; [ $# -gt 0 ] && shift
case "$cmd" in
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  reset) cmd_uninstall; cmd_install ;;
  launch) cmd_launch "$@" ;;
  accept) run_cli "${1:-bob}" update release-note-draft --accept ;;
  cli) [ $# -ge 2 ] || die "cli <who> <args...>"; run_cli "$@" ;;
  log) need_sandbox; exec tail -n 50 -f "$SANDBOX/activity.log" ;;
  status) cmd_status ;;
  selftest) cmd_selftest "$@" ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 1 ;;
esac
