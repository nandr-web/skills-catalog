# Skills catalog contract

The API of the skills catalog: its operations, data and rules. The implementation, its tests (the QA plan) and the words
assistants see (the agent-experience notes) all follow it, and a change to any shape starts here.

**Phases.** **1** = the build, all local; **2** = designed, local, not built yet; **AWS** = designed, an option in setup (off by
default), not built; **later**. The owner's direction: "Focus on phase 1 / local work. Bring back up AWS topics only after the
rest is finished and approved". Everything not marked phase 1 is here so phase 1 doesn't close doors; it isn't built.

**Why the rules are the way they are.** The owner's decisions (in decisions.md) set the scope, the update hold (§5.3) and who may publish.
Many smaller rules come from measured trials with real assistants (the agent-experience notes) or from test runs (the QA plan);
where they do, the numbers are given, because they are the reason for the rule.

---

## 1. Two kinds of operation, one registry

Each operation is defined once, as a typed schema, and the faces are generated from it. An operation's name is the same in
every face (the MCP tool, the CLI command, the HTTP route's handler).

| Kind | Runs in | Faces | Operations |
|---|---|---|---|
| **Catalog** | the core, local or hosted | CLI, HTTP, typed web client; MCP where marked | search, read, versions, diff, publish a version, fetch a version; later bundles, votes, yank, tokens, reviews |
| **Machine** | the client, on your machine | MCP, CLI | publish a folder, install, update, list installed, set policy, setup, teardown; CLI only: serve, login, logout |

For phase 1: MCP and CLI bindings; the HTTP binding plugs in with the web UI (phase 2) from the same registry.

**Names:** the CLI command, the npm package and the MCP server are all `skills-catalog`, the product's name (e.g.
`skills-catalog setup`). Not `skills`: that's the public skills.sh CLI (`npx skills add`), which models already know
(the agent-experience trials; `skills-catalog` is free on npm). CLI exit codes: 0 done, 1 an error, 3 "needs answers" (§6); a read of several names exits 1 when none is found and 0 when
at least one is (each missing name is still its own `not_found` in the result).
The CLI takes each input as `--<field>`, with `_` written `-` and a nested field by its own name (`--dry-run`; search's
filters as `--tags`, `--publisher`, `--updated-since`). A list whose items can't hold a comma (tags, flag kinds) is one
comma-separated value, and an empty one is written `none` (`--flags runnable_file,new_publisher`, or `--flags none`); file
paths can hold a comma or be named `none`, so `paths` is a repeated `--path <p>`, one path each. Either way every input
stays a visible token in a permission prompt.
Shorthands: `install --project` for `--target project`, and `read --files` or `--contents` for `--include`; two that
contradict are `invalid_request` {field} (exit 1).

**The MCP server carries `instructions`** (~260 tokens; wording in the agent-experience notes). Claude Code
puts server instructions in the system prompt while deferred tools show only their names. In the agent-experience trials, without
instructions a small model answered "no such skill" without ever searching (0 of 3 found it); with them, 3 of 3 found it in one
search. The companion skill is
written by hand too, and a lint checks that every tool the instructions or the skill name exists in the registry.

## 2. Catalog operations

| Operation | Phase | MCP? | In | Out | Errors |
|---|---|---|---|---|---|
| `search_shared_skills` | 1 | yes | `query?` (words), `filters?` {`tags[]`, `publisher`, `updated_since`}, `limit` (default 10, max 50), `cursor?` | `results[]`: cards {`name`, `description`, `latest_version`, `tags`, `publisher`, `quality?`, `matched_words[]`}; `total_matches`, `catalog_size` ("3 of 52 skills match"); `match`: `all` (some card matched every content word) \| `partial` (cards only share some words) \| `none` (empty); `next_cursor?`; `ranking`: `none` (no words) \| `lexical` \| `semantic` \| `hybrid` | `invalid_request` |
| `read_shared_skill` | 1 | yes | `name` or `names[]` (≤20); `version?` (default latest); `include`: `manifest` (default) \| `files` \| `contents`; `paths[]?` (≤20, with one `name`: only those files) | per skill: `name`, `version`, `latest_version`, `fingerprint`, `published_at`, `publisher`, `manifest` {frontmatter, body} (either can be left out for the budget: then `frontmatter` is absent and `frontmatter_omitted`, `grant_keys` and `grant_keys_more?` sit on `manifest`, or `body_omitted`; `frontmatter: null` means unreadable, §4.4), `reviews[]`, `stored_under_older_rules?` {error} (§4.4); with `files`: the file list {path, mode, size, sha256, `type`: text \| binary}; with `contents`: also `content` on text files, SKILL.md included (binary never inlined), all within the read's inline budget (below; the manifest body counts too): a front matter, body or file past it has `frontmatter_omitted`, `body_omitted` or `content_omitted: true`, and the result says `inline_budget` {limit, used, omitted} | `invalid_request` {field: `names`, why: `name_and_names`} (both given), {field: `name`, why: `required`} (neither), {field: `paths`, why: `paths_need_one_name`} (`paths[]` with `names`); per name: `not_found` {`suggestions[]`} (never an empty success); `not_found` {`path`} for a path the version doesn't have |
| `list_shared_skill_versions` | 1 | yes | `name`, `cursor?` | `latest`, `versions[]` {`version`, `fingerprint`, `published_at`, `publisher`, `message`, `flags[]`} | `not_found` {`suggestions[]`} |
| `diff_shared_skill_versions` | 1 | yes | `name`, `from`, `to` (versions) | `files[]` {`path`, `status`: added \| changed \| removed, `flags` {binary, executable, script}, `unified?`}; `frontmatter_changes[]` {field, from, to}; `publisher_changed`; `risk_flags[]` (§5.3); `stored_under_older_rules?` {from?: {error}, to?: {error}} (§4.4) | `not_found` |
| `publish_version` | 1 | no (`publish_skill_to_catalog` calls it) | `name`, `files[]` {`path`, `mode`, `content_base64`}, `message?` (one line, §4.1: a line break or control character is `invalid_request` {field: message, why: control_character}), `expected_latest?`, `dry_run?`, `allow_suspected_secrets?` (a person's override, per publish; never in an MCP schema) | `name`, `version`, `fingerprint`, `created` (false when identical to the latest), `dry_run` (echoed), `publisher` (the acting identity), `diff_from_latest`, `risk_flags[]`, `stored_under_older_rules?` {from: {error}} (§5.1) | `invalid_manifest` {problem, fields}, `invalid_name` {name, why}, `invalid_path` {path, why}, `too_large` {limit, max, value}, `secret_suspected` {path, line, kind}, `not_owner` {name, owners}, `conflict` {name, latest}, `forbidden`, `unauthenticated` |
| `fetch_version` | 1 | no | `name` and `version`, or `fingerprint` | `fingerprint`, `files[]` {path, mode, content_base64}; cacheable by fingerprint | `not_found` |

- **Keyword search ranks by any word** (bm25; common words dropped), because agents search with any-of-these-words queries
  ("release notes changelog sprint changes"): with all-words matching they needed 3–13 searches and once reached a wrong
  conclusion; with any-word ranking, one search, 3/3 (the agent-experience trials).
- **"Nothing matches" (the PRD's FR-02) is told by `match`, not by an empty page.** Any-word ranking lets one shared word through
  ("graphql schema" finds a SQL migration skill by "schema"; one of the QA plan's no-match queries, on real FTS5). So each card says which content words it
  matched, and the page says `partial` when no card matched them all. The server instructions and the tool description (wording in the agent-experience notes) say: if `match` is `partial`,
  tell the user nothing matched exactly, then offer the closest, saying what they share ("these only share the word
  'schema'"), never presenting one as a fit. The agent-level no-match scenarios decide it. A semantic or hybrid search
  applies a relevance cutoff, and reports `partial` the same way.
- **`matched_words` and `match` use the index's own matching** (the same tokenizer and stemming, FTS5 `porter unicode61`):
  `matched_words` lists the query's words, as typed, that matched after stemming. On exact tokens, `partial` fired for
  "review pull request" against "reviewing pull requests" (the right skill), and the assistant would have said nothing
  matched (the agent-experience trials).
- `not_found` carries `suggestions[]`: names within a small spelling distance only (search-based "closest" names misled agents).
- **Text or binary:** a file is `text` when its bytes are valid UTF-8 with no NUL byte, otherwise `binary`; so an empty file is
  text, and so is a UTF-8 file with a BOM or CRLF endings. `content` is exactly those bytes decoded (BOM and CRLF kept), so
  encoding it as UTF-8 gives back the stored bytes.
- **Counts:** `catalog_size` counts skill names, not versions (a new version leaves it unchanged). `total_matches` is the number of
  cards across all pages of that query, after any relevance cutoff; it is 0 exactly when `match` is `none`.
- **Reading an older version:** `read_shared_skill` with `version: k` returns `version: k` and `latest_version` (the current
  latest). A `not_found` name has neither.
- `dry_run` validates, fingerprints and diffs against the latest, and stores nothing (the web editor's preview, an agent's pre-check).
  It fails exactly as the real publish would: `not_owner` first, then `conflict` (e.g. `expected_latest: 0` on an existing name),
  then validation; a dry run by someone who isn't the owner is `not_owner`, not a preview.
- `expected_latest`: when set and the latest has moved, `conflict` and nothing stored; `0` means "a new name" (`conflict` if the
  name exists). The web editor always sends it.
- A refused publish leaves storage exactly as it was, rows and blobs: `not_owner` and `conflict` are checked before any byte is
  stored and again inside the atomic append; if the append refuses (another publish landed in between), the blobs this publish
  created and nothing references are deleted before it returns.
- **Request fields are the operation's own.** A field is looked up only among the fields the operation's schema defines,
  never through inherited names: an unknown field, `constructor` and `__proto__` included, is `invalid_request` {field}.
- **A read inlines at most 24 KiB (24,576 bytes) of text** (config: `read_inline_budget`), in every `include` mode, so one
  result stays under the QA plan's 8,000-token cap on a tool result (about 6,000 tokens at ~4 bytes a token). Every text the result inlines counts: each skill's front matter and manifest `body` (both returned in every mode) and,
  with `contents`, each file's `content` (SKILL.md's included, which repeats both). Each is inlined whole or not at all,
  never cut, in this order: every named skill's front matter, in the order the names were asked (first, so every grant is
  seen); then every body, in that order; then, with `contents`, each skill's text files, skill by skill in that order,
  SKILL.md first and then by path. One that doesn't fit is left out, marked `frontmatter_omitted: true` (`frontmatter`
  absent), `body_omitted: true` or `content_omitted: true`, and later smaller ones may still fit. A front matter left out
  still names its grants: `grant_keys`, the names of its top-level keys on neither the safe list nor `non_granting_keys`
  (§5.3), and of the keys a `<<` key would merge (§4.4), without their values, sorted by code point, at most 10, each
  escaped as flag text is (§5.3) and cut to 64 code points; `[]` when it grants nothing, and `grant_keys_more` (how many
  more) only past 10. So an assistant sees that a skill pre-approves tools or registers hooks before it has read the values.
  They're always returned and count in `used`, which they can push past `limit`. A `null` front matter (unreadable, §4.4)
  counts in neither `used` nor `omitted`.
  `inline_budget` {limit, used, omitted}: `used` is the UTF-8 bytes inlined, `omitted` the number of front matters, bodies
  and files left out. A front matter's bytes are those of what's returned: its compact JSON (no spaces), UTF-8, so aliases
  count as expanded; a body's are the stored SKILL.md bytes after the closing `---` line (after its line ending) to the end
  of the file, unnormalised. With `paths[]` (one name) the front matter comes first, then only the
  named files, in the order asked. The body comes only when SKILL.md is one of the paths, just before SKILL.md's content, and both count in
  `used`; when it doesn't fit it's left out and counted in `omitted`, without `body_omitted` (`paths[]` is the follow-up for
  what was left out, and re-sending a long body unasked would crowd out the files asked for). A read of the path SKILL.md
  alone inlines the front matter, the body and the content whatever their size, so it shows a front matter left out
  elsewhere. Binary files are never inlined and never counted as omitted. Omitted files can be read with `paths[]`, and a read of
  exactly one path inlines that file, up to the per-file limit of 1 MB (Claude Code saves a result that large to a file), and the front matter (`inline_budget.limit` stays 24,576 and `used` may exceed it), so any
  text can be read before it's installed. Measured on 51 real
  skills: SKILL.md has a median of 9 KB and a 90th percentile of 20 KB, and 49 of the 51 are under 24 KB (two are larger);
  whole folders have a median of 20 KB and a 90th percentile of 154 KB.
- **The secret scan runs in the core's publish too**, the same function the client's preview uses (the shared `skill-tree`
  module), so no face can skip it: a hit is `secret_suspected` {path, line, kind}, whose sentence names the file and line and
  never repeats the value. `allow_suspected_secrets` lets it through for that one publish; only a person sets it (the CLI
  flag at a terminal, §3; later a checkbox in the web editor).
- **What the scan looks for** (a secret's shape, no allow-list; the patterns are in the shared `skill-tree` module). The
  kinds, in the order they're tried, the first that matches a line naming the hit: `aws_access_key`, `private_key`,
  `github_token`, `slack_token`, `anthropic_key`, `openai_key`, `stripe_key` (`sk_` or `rk_`, then `live_` or `test_`,
  then 16 or more letters and digits), `google_api_key` (`AIza` and 35 more of letters, digits, `_` and `-`), `jwt` (three
  dot-separated base64url parts whose first two start `eyJ`), `url_credentials` (`scheme://user:password@host` with a
  non-empty password, any scheme), `password_or_token` (a key, a run of letters, digits, `_`, `-`, `.` and spaces, holding password, passwd,
  secret, secret key, private key, api key, access key, access token, auth token or token as a whole part of it, in any
  case, with `_`, `-`, a space or nothing inside the words, and not followed by a part that names something else about it
  (`hint`, `length`, `len`, `min`, `max`, `policy`, `prompt`, `label`, `field`, `name`, `file`, `path`, `type`, `count`,
  `expiry`, `expires`, `ttl`, `url`): so `MYPASSWORD=`, `client_secret:`, `AWS_SECRET_ACCESS_KEY=`, `SECRET_KEY_BASE=`,
  `DB_PASSWORD_PROD=`, `"api key": "…"` and `--password …` count, and `TOKENS=`, `password_hint=` and `DB_PASSWORD_FILE=`
  don't; then an optional closing quote, `:`, `=`, `:=` or `=>` with spaces around it (or, for a `--flag`, a space or `=`),
  an optional opening quote, and a value of 12 or more characters that aren't spaces or quotes).
  A match must stand alone: not preceded or followed by another character of its own alphabet. Not flagged: a prefix alone
  in prose (`sk_live_`, `AIza`, `eyJ`), a URL with a user and no password, and a URL password that is a placeholder
  (`<password>`, `${DB_PASS}`, `$DB_PASS`); the word `password` as a URL's password is flagged, since it could be real.
  Nor is a `password_or_token` value that refers to a secret instead of holding one: a placeholder (`<…>`, `${…}`, `$X`,
  `$env:X`), a read of the environment (`process.env.X`, `process.env["X"]`, `os.environ[…]`, `os.environ.get(…)`,
  `os.getenv(…)`, `ENV["X"]`, `System.getenv(…)`), a call (a name followed by `(`), or a dotted name
  (`self.tokenizer.encode`, `config.api_key`).
  The first hit in path order is reported. Every file is scanned as text when it decodes: UTF-8, UTF-16 with a byte-order
  mark, or, for bytes that are neither and hold no NUL, Latin-1; lines are counted in the decoded text (a CRLF counts once,
  and a byte-order mark isn't part of line 1). (Whether a read
  inlines a file, §2's text-or-binary rule, is unchanged.)
- Search results are pages of cards only: no fingerprint or timestamps (they add ~45% tokens and aren't needed to choose).
  A card averages ~113 tokens (measured on 52 real skills; p90 240), so a default page of 10 is ~1.1k tokens (20 would be ~2.3k), well under the QA plan's 8,000-token cap on
  one tool result (Claude Code warns at 10,000 and saves anything over 25,000 to a file). The default is 10 because in every agent-experience trial
  the right skill was in the top 3; an assistant can ask for up to 50.

Later (same registry): bundles (`create_bundle`, `publish_bundle_version`, `read_bundle`, `list_bundles`: phase 2, local);
`vote`, `unvote` (later, hosted: needs identity); `yank_version` (hide a version published by mistake, e.g. with a secret,
without renumbering); `create_token` (shown once, scope read or publish, with expiry), `list_tokens`, `revoke_token` (AWS, "a
signed-in person only, not an agent"); `list_reviews`, `submit_review` (phase 2, a reviewer identity only).

## 3. Machine operations

| Operation | Phase | In | Out | Notes |
|---|---|---|---|---|
| `preview_skill_publish` | 1 | `folder`, `message?` | the files to send, the files skipped, the diff against the latest, `risk_flags[]`, and the inputs for publishing: `confirm`, `name`, `version` (the number it would become), `files` (how many it would send), `flags[]` (the risk flags' kinds) and, when one was given, `message`; or, when the folder matches the latest, that nothing would change | The first of two steps, so the person sees what would be published before it is. It runs every check a publish runs (the owner, the manifest, the files, the secret scan) as a dry run: nothing is stored, and nothing leaves this machine (against a hosted catalog it diffs with the latest's files fetched by fingerprint). Never pre-allowed by setup (§6): its `folder` chooses what's read, and its result shows the files' text. It's a tool of its own so that a person who answers its prompt with "don't ask again" pre-allows previews only, never a publish. Reads the folder: regular files only (a link, a file with more than one hard link or a special file is `invalid_path` {why: `not_regular_file`}, §4.2), never follows a link out, skips and reports the ignore list (`.git`, `.env*`, `*.pem`, `id_*`, `.DS_Store`). A secret-scan hit anywhere, the body included, **rejects** with `secret_suspected` {path, line, kind} |
| `publish_skill_to_catalog` | 1 | `folder`, `message?`, `confirm`, `name`, `version`, `files`, `flags[]`, all but `folder` copied from `preview_skill_publish`'s result (`message` exactly as the preview gave it back, and only when it had one) | as `publish_version` | The second step. **Its permission prompt is the consent, so it shows what's agreed to:** `name`, `version`, `files` and `flags` are in its input for that reason (as `accept_held_update` carries its flags). `confirm` is an HMAC-SHA-256 (base64url, 43 characters, short enough for an assistant to copy) over the folder's real path, its fingerprint, the name, the latest version the preview started from (`version` − 1), the message, `files` and the flags' kinds, keyed with a secret only this machine's skills-catalog holds. The publish recomputes it from the folder as it is now and its own inputs, so it verifies only after a preview of the same folder with the same values: otherwise `conflict` {name, folder}, changing nothing, whether the folder's files, the message or an input changed, or the value never came from a preview (the remedy is the same: preview again). A value that isn't 43 base64url characters is `invalid_request` {field: `confirm`, why: `not_a_confirm`}; a missing one is {field: `confirm`, why: `required`}, whose sentence points to the preview. A version published by someone else in between is `conflict` {name, latest}. The details are pinned below the table. A secret-scan hit **rejects** as in the preview; only the person can override it, per publish, with the CLI's `--allow-suspected-secrets`, which is **not in the MCP schema**. Setup never adds this tool to the assistant's allowed tools, so its permission prompt is the person's consent |
| `install_shared_skill` | 1 | `name`, `version?`, `target?`: `user` (the default, §6) \| `project`; CLI only: `--policy` (not in the MCP schema: install is pre-allowed and setting a policy isn't) | `installed` {`path`, `version`, `fingerprint`, `advisories[]`} \| `held` {reason: `flagged`, `risk_flags[]`, `confirm`} | A first install goes through the update hold as an update from nothing (§5.3): no flags, it installs; flags, it's held and shown, and `accept_held_update` takes it once the person says yes. `fetch_version` → a temp folder outside every skills folder (Claude Code watches those for changes) → the checks of §5.3 ("The installer decides") → rename into `<skills dir>/<name>`, the path computed from the target and the name; records the lock. The name is checked against the installer's own copy of the reserved list, at install and at every sync. Never overwrites or shadows what it didn't install: `exists_untracked` {path} when that folder is already in the target and the lock doesn't own it (e.g. a hand-made skill), and `name_in_use` {path} when the other target holds an untracked skill of that name for the current project (in Claude Code a personal skill replaces a project one of the same name), or either target has a command file `.claude/commands/<name>.md` (a skill replaces a command of the same name). Refuses a link anywhere on the way in: before it writes, every folder from below the assistant's home (`user`: `.claude`, `.claude/skills`, `.claude/skills/<name>` under `$SKILLS_ASSISTANT_HOME`, which may itself be a link) or below the project (`project`: the same three) must be a real directory, and the first link found is `target_symlink` {path: that link}; nothing is written through it, and the link, what it points at and the lock stay as they were. `update_installed_skills` checks the same, so an installed copy replaced by a link since is refused, never reported as up to date |
| `update_installed_skills` | 1 | `names?`, `dry_run?` | per skill: `updated` {from, to, changes} \| `unchanged` \| `held` {reason: `notify` \| `pin` \| `flagged` \| `cooldown` (§5.3; shared and hosted catalogs) {until}, `risk_flags[]`, diff, `confirm`} \| `refused` {version, error} (the new version breaks today's rules or doesn't match its fingerprint, §5.3; nothing changes) | One batched status call; skipped if the last sync was under a few minutes ago. A name in `names` that isn't installed is `not_installed` {name} (the first such, in the order given), checked before anything is fetched, and nothing changes; the action is §5.3's table. Where a skill is replaced is computed from its target and name, never read from the lock's `path`. CLI only: `skills-catalog update <name> --latest` takes the newest version now, skipping a cooldown (§5.3); the update hold still applies, and setup never pre-allows it; the MCP schema has no `latest` |
| `accept_held_update` | 1 | `name`, `confirm` (from the held result), `flags[]` (the held flags' kinds, e.g. `["runs_at_load", "new_publisher"]`; `[]` for a hold with no risk flags, such as `notify`) | as `updated` (or `installed`) | Takes one held update, or a held first install, once the person says yes. `flags` is in the input so the permission prompt shows the person what they're agreeing to, not only what the assistant said; the server compares it as a set of kinds (order and repeats ignored) and refuses with `conflict`, changing nothing, when a kind is missing or extra. `confirm` is tied to the name and the new version's fingerprint: `conflict` if a newer version arrived since. Setup never adds this tool to the assistant's allowed tools, so its permission prompt is the person's consent (the same pattern as publish). The lock records which flags each acceptance let through. CLI: `skills-catalog update <name> --accept` shows the reasons and asks; setup never pre-allows it, so an assistant running it meets the permission prompt (the person's yes), and with no terminal it refuses (exit 3, a backstop) |
| `list_installed_skills` | 1 | | per installed skill: `version`, `latest`, `policy`, `state`: `same` \| `behind` | Reads the lock; no local-change check in phase 1 (§5.4) |
| `set_skill_update_policy` | 1 | `policy`, `cooldown?` (§5.3; later, with shared and hosted catalogs: not in the schema until then), `name?` (none = the global default) | the effective policy | `auto` \| `notify` \| `pin`. A `name` that isn't installed on this machine is `not_installed` {name}, and nothing changes: not `not_found`, whose sentence says the catalog has no such skill, when it may well have one |
| `setup` | 1 | the setup config (§6) | first, the person's one remaining step ("start a new Claude Code session; this one can't use the tools yet"); then what was written, and "N skills to search; none installed yet" | The colourful wizard, `--yes`, `--config <file>`, the setup skill and the setup doc all produce this config; with no terminal, the no-terminal mode (§6); never asks for a token in chat |
| `teardown` | 1 | | what was removed | Undoes setup: the MCP entry, the companion skill, the hook, the backed-up settings files restored; and the AWS stack, when setup created one |
| `serve` (CLI only) | 2 | `port?` | the local URL | Serves the web UI and the HTTP face on your machine, no sign-in: 127.0.0.1 only, a Host allow-list, exact Origin + JSON + a per-launch token on writes, no CORS |
| `login` (CLI only) | AWS | `scope`: `read` \| `publish` | who you're signed in as, the scope, the expiry | The person completes a browser sign-in (a device code, so it works on a remote machine too) and approves the token; stored in `$SKILLS_HOME/credentials` (mode 0600), never in a project file, an MCP config, a URL or the chat. AWS `setup` calls it; when an agent runs setup, the person finishes the sign-in |
| `logout` (CLI only) | AWS | | done | Revokes the token and deletes the file |

**Publishing a folder, pinned** (`preview_skill_publish`, then `publish_skill_to_catalog`):
- **The publish's inputs** are in the schema, so the usual request checks apply: `version` a whole number from 1, `files` a
  whole number from 0, `flags` a list of flag kinds (§5.3), `name` text; all are required.
- **The publish checks, in order:** the confirm's form (`not_a_confirm`); then the folder, read again, and the HMAC over it
  and the publish's inputs (`conflict` {name, folder}; `flags` enter the HMAC as a set of kinds, sorted, repeats ignored);
  then the catalog's latest against `version` − 1 (`conflict` {name, latest}); then the publish's own checks as usual
  (`not_owner`, validation, the secret scan).
- **The CLI's two commands** match the two tools, so a shell rule for one never allows the other: `skills-catalog preview
  <folder> [--message …]` prints the preview and the publish command with its values; `skills-catalog publish <folder>
  --confirm … --name … --version … --files … --flags …` publishes, and the assistant's permission prompt shows that command
  (setup pre-allows neither, §6). A person at a terminal can run `skills-catalog publish <folder>` alone: it shows the
  preview and asks "Publish? (y/N)" in the same process. With no terminal and no `--confirm`, it refuses (exit 3) and
  points to `preview`. `--allow-suspected-secrets` works only at a terminal (exit 3 with none, a backstop, since a command
  can fake one).
- **`folder`** in the confirm and in `conflict` {name, folder} is the folder's real path (links in the path resolved).
- **The secret** is `$SKILLS_HOME/confirm.key`: 32 random bytes, made on first use with mode 0600. If it isn't a regular
  file with mode 0600 owned by this user (a link, a wider mode), it's replaced with a new secret before use, so earlier
  confirms stop verifying. A confirm has no expiry and survives a restart of the MCP server or the CLI; it stops verifying
  when a value it binds changes or the secret is replaced (`conflict` {name, folder} either way).
- **The skipped list** is sorted by path in code-point order and lists at most 50 entries, then `skipped_more` (how many
  more; absent when there are none). A folder whose name is on the ignore list, at any depth (`.git`, `sub/.git`, a
  `.env.d` folder), is one entry with a trailing slash (`".git/"`, `"sub/.git/"`) and is never walked: nothing in it is
  read, so a link, a special file or a hard-linked file inside it isn't `not_regular_file`, and the publish goes on.
  The HMAC binds what's sent, not the skipped list: an ignored file or folder added or removed between the preview and
  the publish changes nothing that's published, so the confirm still verifies.

When sync runs: from Claude Code's session-start hook, which setup adds by default for Claude Code; when the MCP server starts
(it answers `initialize` first, then syncs in the background; for other MCP clients); and from `update_installed_skills`. The
"synced recently" stamp stops the hook and the MCP start from both syncing. Claude Code picks up skills added or edited under
`~/.claude/skills` and `.claude/skills` within the same session (its live change detection; not in bare mode, nor for a
top-level skills folder created after the session started). A newly installed skill works in the same session only after a
moment: the first call to it can say "Unknown skill" (verified in the agent-experience trials), so the install result tells the
agent to retry once.

**Telling the person about a held update.** While an update is held, the session-start hook prints two things: a
`systemMessage` for the person (Claude Code shows it as its own line, whatever the model does) and `additionalContext` for the
model (wording in the agent-experience notes). With an unrelated first request, a small model relayed it 2 of 2 times this
way, and 0 of 5 times when the notice was only in the MCP server's instructions, which models read as "how to use these tools".
Other MCP clients get the notice in the server's instructions. The hook prints nothing when nothing waits for the person's yes (a pinned skill or a version still in its cooldown asks
nothing), always exits 0, and
gives up on the sync after 2 seconds (the rest happens at MCP start), so it never slows or breaks a session. The notice
carries only skill names (chosen by a publisher, but only lowercase letters, digits and hyphens, §4.1), versions, counts and
fixed words per reason, never a path, a detail, a description or other free text a publisher chose: it reaches the model
before the person's first message.

**Activity log.** The MCP server appends one line per tool call to `SKILLS_ACTIVITY_LOG` (default `$SKILLS_HOME/activity.log`,
mode 0600): `HH:MM:SS  who  tool  result  target`, in UTC, with padded columns and no colour codes. `who` is the acting
identity; `result` is fixed words per result code, padded to the longest; `target` is skill names and versions only (a search
logs its number of matches, never the query), and comes last so a long skill name can't push the other columns. Nothing a
person or a publisher typed goes in, so the log is safe to show; the demo's lower pane follows it.

**Usage metrics (phase 2; the owner's decision).** The owner: "do we have metrics as part of our plan? Let's add
instrumentation if not already - it can be phase 2." Designed from research into the friction of update holds (Microsoft's
telemetry on Windows' permission prompts, Anthropic's figures for Claude Code's permission prompts, studies of browser
warnings and of Dependabot): a hold costs attention every time and pays only when it changes an answer, so both are counted.
Seven events, one JSON line each (`{v: 1, at, event, …}`), appended to a file per day, `$SKILLS_HOME/usage/YYYY-MM-DD.jsonl`
(mode 0600, in a 0700 folder); a day's file is deleted once it's 90 days old, so nothing is rewritten and two processes can't
race, and nothing is sent anywhere. A skill's name is stored as `skill`, a keyed hash (HMAC-SHA-256 with a
key derived from `confirm.key`'s secret, §3's publish, as HMAC-SHA-256(secret, "skills-catalog usage metrics v1"); base64url,
the first 16 characters), so a copied log still counts per skill but names none, and one machine secret serves both uses,
each under its own label (a replaced secret restarts the per-skill hashes, which only affects counts across the change); there's no diff, path, notice text, query or session id.
- `hold` {skill, version (the held one), reason, the kinds of risk flag, versions behind}: a hold is reported again at each
  sync, so the measures count distinct (skill, version, reason);
- `notice` {surface: `hook` \| `mcp`, how many were waiting};
- `look` {skill, version, surface: `cli` \| `assistant` \| `web`}: a held update's changes were opened: `diff_shared_skill_versions` for the
  held version, the CLI showing the diff or `update <name> --accept` showing the reasons, or the web compare screen. The
  held result's own diff doesn't count, since it reaches the assistant whether or not anyone looks;
- `answer` {skill, version, `yes` \| `no` \| `pin` \| `superseded`, seconds since the notice, seconds since the look, how
  many answered together};
- `policy` {from, to, scope: the catalog or one skill, whether within a day of a hold};
- `mode` {mode: `default` \| `auto` \| `bypass` \| `sandbox_auto_allow` \| `broad_bash_rule`, surface: `hook` \| `mcp` \|
  `update`}, at each sync, so it also counts syncs (a hook's sync counts as a session); `mode` is left out until the
  permissive-mode detection (§5.3) is built;
- `use` {op: search, read, install, update, publish, …, result: the result or error code}: one per operation, so the
  measures can say how often a search finds nothing, and how many installs and updates were applied; no query, name or
  path.

`skills-catalog stats` turns the hold events into six measures: holds a week, sessions that open with a notice, whether and how long the
person looked, the yes-rate, noes and pins (the only direct sign a hold earned its cost), and holds left waiting or updates
turned off. With a few people, single events matter more than rates. The review of the flag-only approvals (§5.3) reads them.

**The MCP handshake.** The server speaks `initialize` and answers any other opening method with JSON-RPC "method not found"
(-32601). In the agent-experience smoke on the real server, Claude Code first sent `server/discover` (protocol 2026-07-28),
got -32601, and fell back to `initialize` (protocol 2025-11-25). A replay test of those frames pins it.

## 4. Data

### 4.1 A skill and its manifest (the Agent Skills `SKILL.md` format)

- `SKILL.md` at the root: YAML frontmatter, then a markdown body. Required: `name`, `description`, a non-empty body.
- `name`: lowercase letters, digits and hyphens; 1–64 characters; no leading, trailing or double hyphen; must equal the catalog name.
  Otherwise `invalid_name` {name, why}: `empty`, `too_long`, `bad_characters`, `differs_from_front_matter` {front_matter_name}, `reserved`.
- **Reserved names:** a name Claude Code already uses is `invalid_name` {why: `reserved`}. A personal or project skill named
  like a bundled skill replaces it ("A project `code-review` skill replaces `/code-review`", Claude Code's skills page), so a
  published `code-review` would quietly take over a command people trust. The list is config (`reserved_names`), taken from
  Claude Code's commands reference and kept in the repo with its date (`core/config/reserved-names.txt`): on 2026-09-29, 136 names (17 bundled skills, 98
  built-in commands, 17 aliases not already among them, `synced` and `anthropic-skills`, which Claude Code's skills page
  reserves for skills synced from claude.ai, and this product's own `shared-skills` (its companion skill) and
  `skills-catalog` (its command)). Built-in commands are reserved too, so a skill
  is never confused with one.
- `description`: 1–1024 characters, no `<` or `>`, and one line: no line break (`\r`, `\n`, U+2028, U+2029) and no control
  character (C0 U+0000–U+001F, DEL, C1 U+0080–U+009F). It reaches the assistant outside the fence (§5.2) on search cards,
  so a line break could forge a line shaped like the product's own guidance: `invalid_manifest` {problem:
  `control_character`, fields: [description]}. The description checks run in this order: not text, too long,
  `control_character`, angle brackets.
- **One-line fields** are the description, a version's `message` (§2) and a developer's name (the acting identity, which
  follows the skill-name rule: lowercase letters, digits and hyphens). All reach the assistant outside the fence, and all
  refuse those characters. A bad developer name is `invalid_request` {field, why: `not_a_developer_name`} when it comes from
  the `--as` flag (`field`: `--as`, so the sentence reads "--as isn't a valid developer name") or a request field (`field`: that
  field's own name), and `invalid_developer_setting` {setting} when it comes from a setting, whose sentence says to fix
  the setting rather than retry; `setting` is one of `SKILLS_AS` (the environment variable), `mcp_config` (the acting
  identity in the MCP server's entry) or `me` (the name setup saved).
- Not enforced: the Claude API's extra upload rules (no "anthropic" or "claude" in a name). The catalog isn't that API; a skill
  meant for it is checked there.
- **Tags** come from the skill itself, so they travel with its version: `metadata.tags` in the frontmatter, one comma-separated
  string (the Agent Skills spec's `metadata` is its extension point and holds string values only; a top-level `tags:` list isn't
  in the spec). Up to 10 tags, each 1–32 characters of lowercase letters, digits and hyphens; duplicates removed, order kept.
  Spaces around commas are trimmed ("release, docs" → release, docs). A bad tag, an empty item ("a,,b", a trailing comma) or a
  YAML list instead of a string is `invalid_manifest` {fields: ["metadata.tags"]}. No tags is fine. A top-level `tags:` key is
  an ordinary kept key: no error, and not a tag.
- Search's `tags` filter matches these: several tags match skills that have all of them (filters narrow). Tags are filter-only
  in phase 1: search doesn't match them as words (the description carries the words, as the spec advises).
- Other frontmatter keys are kept as published. Any key not on the safe list (§5.3) counts as granting capability: a change
  to it is a risk flag.
- `invalid_manifest` {problem, fields}: `fields` names the frontmatter fields at fault (`body` for an empty body; `SKILL.md`
  when it can't be read), `problem` says what's wrong: `missing`, `not_utf8`, `no_front_matter`, `invalid_yaml` {yaml: the
  parser's code}, `front_matter_not_a_mapping`, `missing_fields`, `description_not_text`, `description_too_long`,
  `description_angle_brackets`, `control_character`, `metadata_not_a_mapping`, `tags_not_a_string`, `bad_tag` {tag}, `too_many_tags` {limit,
  value}, `yaml_feature` {feature}, `key_format`. The YAML checks come first, so `<<:` is `yaml_feature`, not `key_format`.
  An error's sentence is chosen by its `problem` (or `why`), never by its first field.
- **Frontmatter is a safe subset of YAML, so every parser reads the same keys.** Parsers differ: `<<: {allowed-tools: Bash}`
  is a key named `<<` to a YAML 1.2 core-schema parser, and `allowed-tools: Bash` to one that implements YAML 1.1 merge keys
  (PyYAML does), so a skill could pass the catalog's checks and grant a tool in the assistant. One document, parsed with YAML's
  core schema, with no merge keys (`<<`), anchors, aliases, explicit tags (`!!str`, `!x`) or duplicate keys; otherwise
  `invalid_manifest` {problem: `yaml_feature`, feature: `merge_key` \| `anchor` \| `alias` \| `tag` \| `duplicate_key` \|
  `multiple_documents`}.
- **Top-level frontmatter keys match `^[a-z][a-z0-9_-]*$`**, so `allowed-tools` with a zero-width space, a BOM or a bidi
  override in it is refused, never read as some other key: `invalid_manifest` {problem: `key_format`, fields: [the key]}.

### 4.2 Files

- Paths are relative, `/`-separated, NFC-normalised UTF-8. A path that breaks a rule is `invalid_path` {path, why}. The checks
  run in this order, and the first that applies is the `why`:
  - its text: `empty`, `not_utf8`, `control_character`, `invisible_character` (a path that reads as one thing and is another:
    any `\p{C}` code point (format, private-use, unassigned), a line or paragraph separator, a space separator other than the
    plain space (no-break, en, ideographic), a default-ignorable code point (variation selectors, Hangul fillers), or U+2800
    Braille blank), `backslash`, `absolute` (a leading `/` or a drive letter);
  - each segment: `empty_segment`, `dot_segment` (`.` or `..`), then folders that make a skill something else: `git_folder`
    (`.git`), `claude_folder` (`.claude`: an assistant's own settings) and `plugin_folder` (`.claude-plugin`: Claude Code
    loads a skill folder holding `.claude-plugin/plugin.json` as a plugin, which "can bundle agents, hooks, and MCP servers",
    Claude Code's skills page) and `memory_file` (any segment equal, after the same fold, to `CLAUDE.md`, `CLAUDE.local.md` or `AGENTS.md`, so
    `docs/agents.md` and a folder `CLAUDE.md/x.md` count and `CLAUDE.md.bak` doesn't:
    in a project's skills folder Claude Code would take it as project instructions, since subfolder ones are "included when
    Claude reads files in those subdirectories", its memory page), then `not_portable` (any of `< > : " | ? *`, a trailing dot or space, or a
    Windows device name, in any case, alone or before an extension: CON, PRN, AUX, NUL, COM0–COM9, COM¹–COM³, LPT0–LPT9,
    LPT¹–LPT³, so `nul.md` too; Microsoft's file-naming rules. It also closes the Windows spellings of the folder rules,
    `.git.` and `.git::$INDEX_ALLOCATION`), then `segment_too_long` {limit: 255 bytes};
  - the whole path: `too_long` {limit: 1,024 bytes};
  - the list: `bad_mode` {mode}, `duplicate`, `case_clash` {other}, `file_is_folder` {other}.
- **One fold for every "ignoring case" rule** (the folder names, `case_clash`, `file_is_folder`): NFKC, then full Unicode case
  folding (CaseFolding.txt, statuses C and F), then NFKC again, so two paths a case-insensitive file system would store as one clash:
  "ſKILL.md" and "SKILL.md", and "ẞ", "ß" and "ss".
- **One Unicode version for the path rules, the case-folding table's** (16.0 today), so a path is accepted or refused the
  same on every machine. Which code points are assigned otherwise depends on the runtime (Node on one system knows Unicode
  17's new letters, on another it doesn't), so a new letter would be `invisible_character` (unassigned) on one and a
  letter on the other, and two paths differing only in its case would both pass where the table doesn't fold it. So a
  code point unassigned in the table's version is `invisible_character` on every runtime, whatever the runtime knows. The
  normalisation and the fold then only meet characters assigned in that version, whose normalisation Unicode keeps stable.
  A newer version is a deliberate change of both tables.
  - **The table:** `core/config/invisible-characters.txt`, the whole `invisible_character` set above for that version as
    code-point ranges (one `XXXX..YYYY` or `XXXX` in hex per line, sorted), under a header naming the version, as
    `case-folding.txt` has. The path rule reads only this table, never the runtime's `\p{…}`, so no category comes from
    the runtime. It's made by a script in the repo from the same version's data (the general categories from Python's
    `unicodedata`, as the case-folding table is, and default-ignorable code points from an extract of that version's
    `DerivedCoreProperties.txt` kept beside the script: its `Default_Ignorable_Code_Point` lines as published, under the Unicode
    license notice and the original file's SHA-256), so it regenerates offline; the script's verify mode fetches the
    original, checks its SHA-256 and that the extract matches it. The table is committed.
  - **Its tests:** the two tables' version headers are equal; U+200B, U+2800, U+3164 and U+A7CE (a Unicode 17 letter) are
    refused and U+00E9 and U+4E00 aren't, on every runtime; and the table matches a fresh run of the script.
  Until it's built, a path using a code point assigned after 16.0 can be judged differently on runtimes on different
  Unicode versions.
- Regular files only (no links, devices, hardlink tricks); mode `0644` or `0755`. Reading a folder to publish it (§3), a
  symbolic link (pointing in or out), a file with more than one hard link (it may be another file's bytes, from outside the
  folder) or a fifo, socket or device is `invalid_path` {path, why: `not_regular_file`}, found while reading, before the
  path rules; its target is never read.
- Limits (config, not code): ≤100 files, ≤1 MB per file, ≤5 MB per skill. `too_large` names the limit and the value.

### 4.3 Fingerprint (content identity)

```
listing = for each file, sorted by path (bytewise, NFC UTF-8):  "<mode> <sha256 of bytes> <path>\n"
fingerprint = "sha256:" + sha256(listing)
```
Reproducible with coreutils, so tests compute it independently and never trust the system's.

### 4.4 Versions

- A version is immutable: a per-skill number (1, 2, 3 …, the human handle) and a fingerprint (the identity). `latest` is a pointer.
- Publishing bytes identical to the **latest** creates nothing and returns it (`created: false`).
- Publishing bytes identical to an **older** version creates a new version (a revert shows in the history; storage is shared).
- Concurrent publishes without `expected_latest` all become versions, numbered without gaps; none is lost.
- **Versions stored under older rules.** Today's rules apply to a new version when it's published; a stored version is never
  rewritten. When a rule is added (the safe YAML subset, a reserved name, a refused folder), a version stored before it stays
  readable: `read_shared_skill` and `diff_shared_skill_versions` return it as stored, with `stored_under_older_rules`
  {error}. `error` is the first error today's full check gives it, in the installer's order (the paths, then the name with
  its reserved list, then the manifest), so it's the one install would refuse it with. It's data: faces show it inside the
  sentence saying the version was stored under older rules, never with the error's own sentence, which would ask the reader
  to fix someone else's files; and its fields that can carry a publisher's text (`path`, `name`, `fields`, `tag`) are
  escaped and cut as flag text is (§5.3).
- **Its front matter is parsed leniently, for showing only:** YAML's core schema without the subset's refusals (anchors and
  aliases resolved, at most 100 alias uses; a merge key read as a plain key named `<<`; the last of duplicate keys; unknown
  tags ignored; keys that break the plain-key rule kept as they are). Another parser can read such a front matter
  differently (a merge key merged, another duplicate kept), which is why today's rules refuse it; so every key the lenient
  parse or a merging parser would see counts: a `<<` key isn't on the safe list, so it's a grant, and `grant_keys` (§2)
  lists the keys of the mapping it would merge too. A front matter the lenient parse can't read (more than one document,
  more than 100 alias uses, not a mapping, not YAML) is `frontmatter: null`, never `{}`; SKILL.md's text can still be read
  with `include: contents` or `paths[]`.
- **Reading is all it gets:** the installer refuses such a version (§5.3). A diff **from** one fails closed: that side counts
  as no version at all, so every file of the `to` side is added and every grant in it flagged, as for a first install;
  only `new_publisher` still compares the two real publishers, since no rule changes who published (§5.1, §5.3). A diff
  **to** one compares as usual, its front matter read leniently, so its grants show as grants; if even the lenient parse
  can't read it, one `capability_frontmatter` flag {path: `SKILL.md`, field: null} stands for grants that can't be known
  (`field: null` is how a face tells this flag apart). In a diff, `stored_under_older_rules` is {from?, to?}, each side's
  value shaped like a read's, {error}. The skill's owner can always publish a fix, under the same name unless the name
  itself has since become reserved (then under a new name).

### 4.5 On your machine

- **Default places** (when nothing points elsewhere; one folder, so teardown and the clean-run check have one place to look):
  `$SKILLS_HOME` = `~/.skills-catalog/` (config, lock file, credentials, `logs/`); the local catalog = `~/.skills-catalog/catalog/`
  (the SQLite file and the files by digest), shared by every developer acting on this machine; installed skills go to the
  assistant's own folder, `~/.claude/skills/<name>/` for Claude Code (under `$SKILLS_ASSISTANT_HOME`). XDG folders are not used.
- **Config** (`$SKILLS_HOME/config.json`, mode 0600): §6's setup config.
- **Lock file** (`$SKILLS_HOME/lock.json`): per installed skill and target: `version`, `fingerprint`, `publisher`, `policy?`, `target`,
  `path` (for people to read; the installer always computes where a skill goes from its target and name), `installed_at`,
  `catalog`, and the flags each accepted install or update let through. This installer's list is where an installed skill's origin is kept, keyed by where it's
  installed; nothing is written into the skill itself (the owner's decision).
- Installed files are never edited by the client except by an install or update of that skill.
- **A damaged lock or config file is the person's to look at, never repaired.** When `lock.json` or `config.json` isn't
  valid JSON, doesn't have the shape above (a field of the wrong type anywhere, a lock entry's included), or holds a policy
  other than `auto`, `notify` or `pin` (the global one or a skill's own), every command that reads it refuses with
  `invalid_local_file` {file: `lock.json` \| `config.json`, why: `not_json` \| `wrong_shape` \| `unknown_policy`, path: the
  file's full path, so the person can find it} and changes nothing: install, update, accepting a held update, listing installed skills, setting a policy and setup (which
  would overwrite it). The file is never rewritten or replaced; the sentence names the file, never shows its contents, and
  says to fix or remove it. `teardown` still runs, so there's always a way out, and the session-start hook still exits 0,
  printing one line of fixed words naming the file. An unknown policy never falls back to `auto`: a mistyped `pin` must
  never apply an update.

## 5. Rules

### 5.1 Publish, in order (the all-or-nothing point)

![Publish, all or nothing: 1 check it (owner, manifest, files, secrets), 2 store its files by fingerprint, 3 append the version (the commit point), 4 tell listeners; refused with nothing stored when not the owner, a conflict, invalid, a suspected secret, or a lost race at the append](pictures/publish.svg)

1. Check, in the order a dry run reports: the owner (`not_owner`), `expected_latest` (`conflict`), then the manifest, the files
   and the secret scan (the shared `skill-tree` module). Any failure: an error, nothing stored.
2. Put each file's bytes by sha256 (safe to repeat).
3. Compare-and-append the version (the commit point); on a number clash the core retries with the next number.
4. Emit a `version_published` event {name, version, fingerprint, publisher, at} through the `Events` port. Its subscribers: the
   search index (may lag; rebuildable from versions at any time) and the rules reviewer (§10), which stores its review.

On AWS: S3 puts, then one conditional DynamoDB write.

**Publishing over a latest stored under older rules** (§4.4) isn't refused, so the skill's owner can always publish a fix
(unless the name itself has since become reserved: then a new name). The preview and `publish_version`'s
`diff_from_latest` and `risk_flags` fail closed: they treat that latest as no version at all, so `diff_from_latest` is the
all-added diff (never `null`), every grant in the new version is flagged, and only `new_publisher` compares the real
publishers; the result carries `stored_under_older_rules` {from: {error}} for the latest.

A **refused** publish (`not_owner`, `conflict`, invalid) leaves storage exactly as it was, rows and blobs (§2). A **failed** one
(a storage write fails part-way) stores no version, and before it returns deletes, under the write lock, the blobs it created
(not ones it only found already there) that nothing references; best effort. Only a crash, or a failed delete, leaves
unreferenced blobs: invisible to every operation, and removed when the local catalog is next opened (unreferenced and older
than an hour, so another process's publish in flight is never touched). If another publish of the same content was relying on
a deleted blob, its append re-puts it (rule 3 below).

**The invariant: no version ever points at a missing blob.** A time window alone can't guarantee it (a retry reusing an old
leftover blob, or a publish stalled for over an hour, as the QA plan's review found), so, locally:
1. put-if-absent refreshes a blob's time when the blob is already there;
2. the cleanup and the append both run under the catalog's write lock (`BEGIN IMMEDIATE`), never interleaved;
3. inside that lock, the append checks that every blob it references exists; if one was removed, the publish (which still holds
   the bytes) puts it again and appends. If the put fails too, it's a failed publish: no version, retryable.

On AWS (parked): the same invariant, with new blobs tagged pending until their version is appended, a lifecycle rule that
deletes only pending blobs older than 7 days, and the append re-checking its blobs; designed in detail when AWS resumes.

### 5.2 Retrieve and install

- `read_shared_skill` is for reading in the conversation; `install_shared_skill` is "ready to use" (bytes on disk, checked
  against the fingerprint). Both return a typed `not_found`.
- Skill text in tool results is labelled as data from the catalog, with its publisher.
- **One-line fields stay one line when shown.** Every face replaces a line break or control character in a one-line field
  (§4.1) with a space, so data stored before the publish rule, or from another catalog, can't forge a line either.
- **A diff's changed lines are data too:** they're shown inside a fence under the data note, like a read's text.
- **A path or name placed in a command the person is told to run is shell-quoted:** left bare when it's only letters,
  digits and `@ % + = : , . / _ -`, otherwise in POSIX single quotes with a `'` inside written `'\''`. So a folder named
  `x;curl … | sh` or one with spaces stays one argument, and a skill name (lowercase letters, digits and hyphens) stays
  bare. Today that's every command naming a skill (`update <name> --accept`, `--latest`); a folder joins them when the
  CLI's publish, with `--allow-suspected-secrets`, is built. Shown as data a path is JSON-quoted, and names a publish skipped are escaped as flag text
  is (§5.3).
- **The fence.** In a read, the skill's text sits between a start marker and an end marker that carry a random token made
  for that read (from the injected `Ids`, so tests can fix it). Text inside can't close the fence by planting a marker, in
  any spelling, because it can't know the token. Paths and names shown outside the fence are JSON-quoted strings. The
  marker wording, with a placeholder for the token, is in the agent-experience notes. The data note before the fence names
  its end marker, token included, so the reader knows which line closes it.
- **Control characters inside the fence are shown escaped**, so a skill's text can't drive a terminal (move the cursor,
  rewrite a line, set a link or the clipboard) or ring it. In the rendered text of a read and of a diff's changed lines,
  every C0 control character except TAB and LF (U+0000–U+0008, U+000B–U+001F), DEL (U+007F) and every C1 control character
  (U+0080–U+009F) is shown in the flag text's form, `\u{XXXX}` in lowercase hex (ESC is `\u{001b}`). A CR directly before
  an LF is kept, as part of a CRLF line ending; any other CR is escaped. Only the rendering changes: stored bytes, the
  fingerprint and JSON fields (`content`, `unified`) stay exact.

### 5.3 Risky updates wait for a yes (the owner's decision)

Risky updates are held until you say yes. Risky means the new version could change what runs on this machine (a
script, a tool grant, a new publisher…). This section calls that the update hold, and an update it stops a held update.

The owner's decision: asked "Keep auto-updates on by default, but stop and show you any update that could change what runs on
your machine?", the owner answered "Completely agreed", and asked to "also consider other reviewer-based metrics or flags". So
the update hold stops **anything that could make something run without a prompt**. In Claude Code a skill does that in these ways (its
skills page): `allowed-tools` ("Tools Claude can use without asking permission during the turn that invokes this skill"),
`hooks` ("registers when the skill is invoked and keeps running for the rest of the session"), `` !`command` `` lines and
```` ```! ```` blocks ("Injected commands never prompt for permission while the skill renders"; they run when a permission rule
allows them, such as the skill's own `allowed-tools`), `context: fork` with an `agent` (the skill runs as that subagent), and
scripts that a grant lets Claude run. With any of those in the skill, its instructions steer what runs unprompted too.
Everything else a skill does goes through Claude Code's own permission prompts, which stay the person's say in its default
permission mode (for other modes, see "What the update hold doesn't cover" below).

**The installer decides, from bytes it checked.** It never trusts the catalog's verdict: the catalog's `risk_flags` are for
showing (the web UI, a publish preview), and the update hold never reads them. For each version it fetches, the installer:
1. checks the bytes against the fingerprint the version list names (`list_shared_skill_versions`; the lock's, for the
   installed version), never the fetch result's own claim. A mismatch (a damaged file in the catalog, or a catalog serving other bytes
   than the version it names) is `fingerprint_mismatch` {name, version, expected, got}: the error itself on install, and
   `refused` {version, error} in an update's result. Nothing is installed: the fetched copy is deleted, and the lock and any
   installed copy stay as they are. `expected` and `got` are shown only in the fingerprint's form (`sha256:` and 64 hex
   digits), and `version` only as a positive whole number (here and in `refused`); a catalog's claim in any other form is
   `null`, since the catalog chose it. The sentence says the catalog's copy
   is damaged or altered, not to retry or work around it, and to tell the person;
2. runs the full current `skill-tree` validation (paths, the name with its reserved list, the manifest), with its own copy of
   the rules. A version that fails is refused (`refused` {version, error} in an update's result, the error itself on install),
   so a version stored before a rule existed never installs past it. An update looks at the newest version only: when that
   one fails, the lock and the installed copy stay as they are, and it never falls back to an older valid version. A name
   that has since become reserved gives `invalid_name` {why: `reserved`} at install and at every sync. A SKILL.md that can't
   be parsed is refused, never diffed as if it had no frontmatter;
3. computes every flag itself, from the verified bytes on both sides. When the installed version fails today's rules (it
   was stored under older ones, §4.4), the flags are computed as for a first install, from nothing, so every grant in the
   new version is flagged and held; only `new_publisher` compares the real publishers: the lock's recorded publisher of the
   installed version (the catalog's, for an entry recorded before the lock kept it) against the new version's. A first
   install never has `new_publisher`.

`risk_flags` for an update, and for a first install (an update from nothing, §3), are:
- from its diff:
  - `runnable_file`: a file added or changed that is executable (mode `0755`), a script (by extension or a `#!` line), or that
    SKILL.md puts in a command position (`python3 x`, `python x`, `bash x`, `sh x`, `node x`, `bun x`, `deno x`, `uv run x`,
    `source x`, `. x`, `./x`, `${CLAUDE_SKILL_DIR}/x`, an injected command's target). This list only names the reason; a file
    it misses is still `non_markdown` or `instructions_changed`. A command position naming a file outside the skill
    (`${CLAUDE_SKILL_DIR}/..`, a `../` path, a path into another skills folder) is flagged too, in a skill that grants nothing as well: {path: the file with the command, line, to: the target as written, detail: "runs a file
    outside the skill"}: that file can change under another skill's rules;
  - `runs_at_load`: an injected command added or changed in a markdown file {path, line}. Claude Code runs `` !`…` `` where
    the `!` starts a line or follows whitespace (so `- PR diff: !`gh pr diff`` runs), and ```` ```! ```` blocks. The detector
    is wider than that rule, so no spelling slips past: any `!` directly followed by a backtick, anywhere in a markdown file
    (frontmatter, code blocks and HTML comments included), and any line whose first non-blank characters are three or more
    backticks or tildes, then optional blanks, then `!`; an edit inside an unchanged block counts, as one flag per block at its opening line. The same detector decides
    whether a skill "has an injected command" below;
  - `capability_frontmatter`: a frontmatter key added, changed or removed that isn't on the safe list {field, from, to}. The
    safe list (`safe_frontmatter_keys`, fixed in code; config can only remove keys from it, never add): `name`, `description`, `when_to_use`, `argument-hint`, `arguments`,
    `license`, `compatibility`, `metadata`, `version`, `tags`. Every other key counts (`allowed-tools`, `hooks`, `context`,
    `agent`, `shell`, `model`, `disable-model-invocation` …, and any key Claude Code adds later), so the update hold fails closed;
  - `instructions_changed`: any other file added, changed or removed (bytes, mode or presence), markdown included, and
    SKILL.md when its body or any safe key changed (`arguments` feeds commands, `description` and `when_to_use` decide when a
    grant is used; a change to only other keys is their `capability_frontmatter` flag), when the new version grants anything: an injected command, or any frontmatter key on neither the safe list
    nor the list of keys known to grant nothing (`non_granting_keys`, fixed in code, config can only remove: `model`, `effort`, `disable-model-invocation`,
    `user-invocable`, `paths`, `disallowed-tools`; a change to one of these is still its own `capability_frontmatter` flag).
    So `allowed-tools`, `hooks`, `context`, `agent`, `shell` and any key Claude Code adds later count: it fails closed like the
    safe list. The detail names the grant ("the skill pre-approves Bash(python3 *); its instructions changed");
  - `non_markdown`: any other non-markdown file added or changed;
  - `new_publisher`: a different publisher {from, to};
- from the rules reviewer (§10), run by the installer on the fetched version, so the update hold never waits for the catalog:
  prompt-injection patterns (instructions to ignore prior guidance, exfiltration or curl-to-shell, hidden unicode, HTML
  comments), and context cost over the configured budget;
- from agent reviewers (phase 2), when their reviews exist; a missing agent review never holds an update.

One reason per file, the first that applies: `runnable_file`, then `runs_at_load` (one flag per added or changed `!` line or
block, and no other reason for that file), then `command_instruction` (one per line, the same way), then
`instructions_changed`, then `non_markdown`; so a new script is one reason, not
two. `capability_frontmatter` is one flag per key, beside the file's own reason.

Each flag says what fired, in one shape everywhere (the diff, a publish's preview, a held update or install, a card's
`quality`), so the web UI, the CLI and an agent show one verdict (the web UI's compare screen shows the same):
`{kind: runnable_file | runs_at_load | command_instruction | capability_frontmatter | instructions_changed | non_markdown |
new_publisher |
prompt_injection | context_cost, path?, line?, field?, from?, to?, instruction?, mode?, detail}`. `field`, `from` and `to` carry a change's sides as
data, so nothing has to parse `detail`: e.g. `{kind: new_publisher, from: "alice", to: "bob", detail: "alice → bob"}`,
`{kind: capability_frontmatter, path: "SKILL.md", line: 3, field: "allowed-tools", from: null, to: "Bash", detail:
"allowed-tools added: Bash"}`. `path`, `from`, `to` and `detail` can carry a publisher's text, so every face shows them as
plain text, never rendered as markdown: each is escaped first (an invisible character becomes `\u{XXXX}`, e.g. `\u{200b}`),
then cut to 200 code points, ending in "…" within the 200.

**The prompt-injection word list is advice.** Its flag holds an auto-update like any other, as the owner asked for reviewer
flags, but the flags from the diff are what make the rule true: a reworded instruction passes any word list.

**When Claude Code runs without prompts, one more flag** (the owner's decisions; built with the update hold). In auto mode (a
classifier stands in for the person), bypass mode, with the sandbox's auto-allow, or with a broad Bash allow rule in the
person's settings, an instruction-only update can change what runs with nobody saying yes. Asked "When your assistant runs
commands without asking (auto mode, bypass, or a broad Bash rule), should every skill update wait for your yes?", the owner
first answered "Yes for now, flag for review via user friction metrics". After the friction research, the owner narrowed
it: "let's also reduce need for human approval - by only surfacing manual approval requirements when there's anything risky
/ flagged. This should be true across all surfaces including CLI and Agentic as long as auto-updates is enabled." So with
auto-updates on, every surface (the session-start hook, the assistant's tools, the CLI) asks the person only when an update
carries a flag, and there's no blanket hold. What the blanket hold covered is covered by a flag instead: while a permissive
mode is detected, added or changed text can get one more flag.
- **`command_instruction`** {path, line, instruction: `shell` \| `fetch_and_run` \| `install` \| `secrets`, mode, detail}: a line that tells the assistant to run a shell command, fetch something and
  run it, install packages, or read credentials or secret paths (`curl … | sh`, "run `…`", `pip install`, `npm install -g`,
  `cat ~/.aws/credentials`, `~/.ssh`, `.env`). The patterns are `command_instruction_patterns`, fixed in code; config can
  only add. One flag per line, whose `instruction` and `mode` (the permissive mode's code) are data, and
  whose detail is worded from them ("tells the assistant to run a shell command; it runs commands without asking: auto
  mode"). It's flagged only while a permissive mode is
  detected: in the default mode, Claude Code's own prompt still asks before any command runs. It applies to a first install
  too, as an update from nothing. It's a heuristic, and "What the update hold doesn't cover" says so. The patterns, matched as whole
  words without regard to case on each added or changed line of a markdown file (the front matter included), the first kind that
  matches naming the flag:
  - `fetch_and_run`: a download piped into something that runs it (`curl`, `wget`, `iwr`, `irm`, `Invoke-WebRequest` or
    `Invoke-RestMethod`, then later on the line `|` and, after an optional `sudo`, `sh`, `bash`, `zsh`, `dash`, `ksh`,
    `fish`, `python`, `python3`, `node`, `perl`, `ruby`, `php`, `pwsh`, `powershell`, `iex` or `Invoke-Expression`); a
    download run through a substitution (`<(curl`, `<(wget`, `$(curl`, `$(wget`); or a package run straight from the
    registry (`npx`, `bunx`, `pnpm dlx`, `uvx`, `pipx run`, each followed by a name);
  - `install`: a package manager's install (`pip`, `pip3` or `python -m pip` `install`; `uv pip install`, `uv add`, `uv
    tool install`; `pipx install`; `npm install`, `npm i`, `npm add`; `pnpm add`, `pnpm install`, `pnpm i`; `yarn add`,
    `yarn global add`; `bun add`, `bun install`, `bun i`; `brew install`; `apt install`, `apt-get install`, `dnf install`,
    `yum install`, `apk add`, `pacman -S`; `cargo install`; `go install`; `gem install`; `conda install`, `mamba install`;
    `choco install`, `winget install`);
  - `secrets`: a place credentials live (`~/.ssh`, `id_rsa`, `id_ed25519`, `id_ecdsa`, `.aws/credentials`, `.aws/config`,
    `.config/gcloud`, `application_default_credentials.json`, `.kube/config`, `.docker/config.json`, `.netrc`, `.npmrc`,
    `.pypirc`, `.git-credentials`, `.gnupg`, a file named `.env` or `.env.` and more), or a command that prints them
    (`printenv`, `security find-generic-password`, `security find-internet-password`);
  - `shell`: a fenced code block tagged `sh`, `bash`, `shell`, `zsh`, `fish`, `console`, `shell-session`, `terminal`,
    `powershell`, `pwsh`, `ps1`, `cmd` or `bat`, added or changed, whose changed lines matched none of the kinds above: one
    flag per block, at its opening line (an edit inside an unchanged block counts, as for `runs_at_load`); and, outside such
    a block, a line where `run`, `execute` or `invoke`, in any form, comes before an inline code span.
  A skill asking the person to paste a key isn't a command the assistant runs, so it isn't flagged (see "What the update hold
  doesn't cover").
- **How the installer tells** (setup reads the same, and its summary says so). It reads Claude Code's settings files as Claude
  Code does: managed, then the project's `.claude/settings.local.json` and `.claude/settings.json`, then the user's
  `~/.claude/settings.json`. A single value comes from the highest file that sets it; lists (`permissions.allow`) merge across
  all of them (Claude Code's settings page). The modes, first found wins, in this order:
  - `auto`: `permissions.defaultMode` is `auto`, from user or managed settings only (Claude Code ignores that value in
    project and local settings);
  - `bypass`: `permissions.defaultMode` is `bypassPermissions`, from user or managed settings only;
  - `sandbox_auto_allow`: `sandbox.enabled` is true and `sandbox.autoAllowBashIfSandboxed` isn't false (it defaults to
    true);
  - `broad_bash_rule`: a Bash or PowerShell allow rule matches every command (`Bash`, `Bash(*)`, `PowerShell`,
    `PowerShell(*)`), or it has a `*` and either its first word contains the `*` (`Bash(* --help *)` can match any
    program) or its first word, less a trailing colon, is a command that runs other code (`broad_bash_runners`, fixed in
    code; config can only add). The runners: interpreters `python`, `python3`, `node`, `bash`, `sh`, `zsh`, `bun`, `deno`,
    `ruby`, `perl`, `php`, `pwsh`, `powershell`, `npx`, `bunx`, `uv`; and wrappers `env`, `xargs`, `sudo`, `doas`, `nohup`,
    `timeout`, `time`, `command`, `exec`, `eval`, `nice`, `watch`. So `Bash(python3 *)`, `Bash(python3:*)`, `Bash(node*)`,
    `Bash(sh -c *)`, `Bash(python3 -c *)`, `Bash(uv run python *)` and `Bash(env *)` count; `Bash(git *)`, and a rule with no
    `*` such as `Bash(python3 scripts/check.py)`, don't. The list is a best effort (other programs can run commands too,
    such as `find -exec`), and the friction review can widen it.
- **Order**: `pin`, then `notify`, then the flags. `command_instruction` is a flag like any other (`held: flagged`), and
  `accept_flagged_updates` lets it through like any flag. A pinned skill and a version still in its cooldown ask nothing and
  produce no notice (§3).
- **A first install** goes through the update hold as usual, `command_instruction` included: flagged, it's held; otherwise it
  installs.
- **What it can't see**: a mode given for one session (`--permission-mode`, `--settings`) or switched during a session. The
  check reads the files at each sync, so it's a best effort; "What the update hold doesn't cover" lists it.
- **When the approvals are reviewed** (with the usage metrics, §3; starting thresholds from the friction research, to be tuned). Any one
  flags the rule for review, with its numbers:
  - avoidance, once: updates turned off, `accept_flagged_updates` turned on, everything pinned, or setup torn down within 7
    days of a flagged hold (Dependabot's users cut its notifications, and 11.3% of projects dropped it);
  - a habit of yes: after 20 or more flagged holds, 95% or more are yes, and most come without a look or within seconds of one
    (Microsoft saw 89–91% yes on its permission prompts and feared habit; Anthropic reports 93% for Claude Code's);
  - no value yet: no flagged hold declined or pinned in the first 100 (by the rule of three, fewer than 3% would change an
    answer, at 95% confidence);
  - load: more than 1 in 3 sessions opens with a held-update notice, or a hold waits more than 14 days.
  If holds do change answers, keep them and make each cheaper: one notice for all that wait, the changed lines and any
  command in them marked, and a notice that changes its wording when something new appears.

**What the update hold doesn't cover** (setup's explanation of auto-updates says so). It covers what a skill itself grants, in Claude
Code's default permission mode. It doesn't cover:
- the person's own rules and modes: with `Bash(git *)` allowed, a plain-markdown update that says "run git push --force" runs
  unprompted, as any instruction would (a narrow rule like this isn't a permissive mode); in accept-edits mode an update
  can have files edited unprompted; and in the permissive modes the `command_instruction` check is a heuristic: a reworded
  instruction can pass it. The owner chose fewer approvals over a blanket hold. The modes are read from the settings files,
  so one given for one session or switched during one isn't seen (a hook that sees the live mode could close this later);
- a first install in those modes: install is pre-allowed, so an assistant can install a skill on its own; its text gets the
  `command_instruction` check, with the same limit;
- what never prompts: reading files in the working directory, Claude Code's read-only commands, `@path` attachments;
- a skill simply asking the person for something (for example, to paste a key);
- files outside the skill that a broad grant reaches: `Bash(python3 *)` lets the skill's turn run any Python file, which the
  update hold watches only inside each skill;
- hooks a skill already registered: they keep running for the rest of the session after an update, a hold or an uninstall;
- provenance: the fingerprint proves which bytes you got, not who wrote them; until sign-in and signing, `new_publisher`
  isn't evidence of who published;
- other assistants: the ways a skill runs things listed above are Claude Code's; new frontmatter keys fail closed, new body
  syntax doesn't;
- `accept_flagged_updates`, which turns the update hold off for updates when the person chooses it.

| Policy | `risk_flags` | Action |
|---|---|---|
| `pin` | any | `held: pin` |
| `notify` | any | `held: notify`, shown with its diff |
| `auto` | none | `updated`, and the assistant is told what changed |
| `auto` | any | `held: flagged`, shown with its diff and the flags; in unattended runs, held and reported at the next session (see "Telling the person", §3) |

A first install follows the `auto` rows whatever the policy: no flags, it installs; flags, `held: flagged`, shown with its
files and the flags (there's no earlier version to diff against).

**A cooldown (the owner's decision; designed now, built with shared and hosted catalogs).** Nearly every real attack through
auto-update was someone with publish rights shipping a normal-looking version that auto-update delivered within hours; of ten
major attacks in 2024–25, eight were live for under a week, until someone noticed and removed them. Package tools now wait by
default: pnpm a day (since v11), Dependabot three days for version updates (since July 2026), Renovate's best-practice preset
three days. Asked whether a new version on a shared or hosted catalog should wait about 3 days before auto-update applies it,
the owner answered yes, wait by default, "with a way to force request the latest (e.g. for independent auditors and security
checkers to monitor latest; so that there's benefit in waiting)". So:
- **The wait.** An update policy carries `cooldown`, a duration: a new version waits that long after it was published before
  `auto` applies it. Until then `update_installed_skills` reports `held` {reason: `cooldown`, until}. Defaults: about 3 days
  for a shared or hosted catalog; 0 for a local catalog, where everyone publishing is on this machine, so nothing changes in
  phase 1. Set globally or per skill (`set_skill_update_policy`, never pre-allowed). A first install of a version younger than
  the cooldown is held the same way, unless the person names that version. There's no publisher-set bypass: a stolen account
  would use it first.
- **The latest, on request** (for auditors and security checkers, and anyone who chooses it). The wait is the installer's,
  never the catalog's: the catalog serves the newest version to anyone who asks. A person gets it at once with a watcher
  policy (`cooldown` 0, globally or per skill), with a one-off `skills-catalog update <name> --latest`, or by taking a
  `held: cooldown` update with `accept_held_update`. All three go through the permission prompt (none is pre-allowed, and the
  pre-allowed `update_installed_skills` has no `latest` input), so an assistant can't skip the wait on its own. The update
  hold still applies: flags still stop.
- **Why waiting helps: a report holds the version for everyone.** Watchers who take the latest early can report a bad
  version during the wait, through reviews (§10: an agent or security reviewer's flags on that version's fingerprint) or by
  its owner withdrawing it (`yank`, §7: the version stays in the history, marked, and is never installed or applied). At the
  end of the wait, and on every sync, the installer checks both before `auto` applies a version: a flagged review holds it
  like any flag, and a withdrawn version is never applied. So a version caught during the wait reaches no one who waited.
  Built with shared catalogs, with agent reviewers and yank.

An update replaces the installed copy (§5.4). A setup option, `accept_flagged_updates` (default false), lets a person opt out of
the update hold for updates on unattended machines. Only the terminal wizard sets it (never `--yes`, `--config` or the no-terminal
mode, since a permission prompt doesn't show a file's contents); it never applies to a first install; the session-start notice
says it's on; and the lock records each update it let through.

### 5.4 Local edits to an installed skill: an open question for the owner

The owner (2026-09-28): "for now we can say that like
most other things installed in your machine - if you modify them manually, you always risk losing local changes if not shared
upstream - standard", and how to handle an overwritten skill is "an open question that I can surface when I present this".

So in phase 1 an update replaces the installed copy, and nothing checks for local changes. The lock still records each
installed skill's version and fingerprint, which install uses to check "complete and unchanged", so detecting local changes
later (and holding, warning or offering to publish them back) needs no new data.

## 6. Setup config

One schema for the wizard, `--yes` (all defaults), `--config <file>`, the setup skill and the setup doc (an agent can run setup
by following either):
- `hosting`: `local` (default) or `aws`. Local needs no account and creates no cloud resources.
- `catalog`: the local folder (default) or, with `aws`, the deployed URL.
- `update_policy`: the wizard asks "Keep skills up to date automatically? (Y/n)", default yes; `overrides` {name: policy};
  `cooldown` (§5.3; default 0 for a local catalog, about 3 days for a shared or hosted one).
- `accept_flagged_updates` (default false; §5.3); `safe_frontmatter_keys` and `non_granting_keys` (§5.3); the context-cost budget for the rules reviewer.
- `targets`: the Claude Code user skills folder by default; any MCP client.
- the session-start hook: on by default for Claude Code (it syncs and tells the person about held updates); teardown removes it.
- `me`: your developer name (the default acting identity); `demo_developers` (default none; the wizard offers "Add two demo
  developers, dev1 and dev2, to try it? (y/N)"), so the README's demo can show Developer 1 publishing and Developer 2 finding,
  installing, and not being able to overwrite it.
- `aws` (only with `hosting: aws`; the wizard asks "Set it up in AWS too? (y/N)"): `profile`, `region`, the stack's settings.
  Setup checks the credentials, shows what it will create and the monthly cost, asks before CDK's one-time account bootstrap,
  deploys, runs `login`, and prints the URL. `teardown` destroys the stack.

Setup writes assistant settings with a temp file and rename, after a backup; teardown restores them. It also reads the
assistant's permission settings, and its summary says when a permissive mode is on, so that an update whose text tells the assistant to run commands asks
first (§5.3).

**What setup lets the assistant do without asking.** Each tool is pre-allowed only when it can't make something run without the
person's yes:
- MCP tools: `search_shared_skills`, `read_shared_skill`, `list_shared_skill_versions`, `diff_shared_skill_versions`,
  `list_installed_skills`, `install_shared_skill` and `update_installed_skills` (their inputs can't choose where bytes come
  from or go, and anything flagged is held). Never pre-allowed: `preview_skill_publish` (its folder input chooses what's read, and the preview shows the files' text), `publish_skill_to_catalog` (it sends the person's
  files), `accept_held_update`, `set_skill_update_policy` (it can unpin a skill the person pinned, or, with the proposed
  cooldown, turn the wait off), `setup`, `teardown`. Their permission prompts are the person's consent.
- The CLI through the assistant's shell tool: `skills-catalog search`, `read`, `versions`, `diff` and `list` (installed
  skills), and `skills-catalog update` with no arguments (an exact rule, no `*`: it applies only what the update hold lets through under
  the person's own policy and config, so an unflagged update asks nothing on this surface either); nothing else, since `--catalog` and `--home` would let a command choose where bytes come from and go. The read commands open storage
  read-only: they never create a catalog, sweep leftovers or rebuild an index, so pointed at another folder they read or fail,
  and never write. The allow list is generated from the registry, so it can't drift from the commands. Every other command,
  and so every use of the person-only flags (`--accept`, `--allow-suspected-secrets`), meets the permission prompt, which is
  the person's yes. Those flags also refuse with no terminal (exit 3), a backstop only: a command can fake a terminal.

**Absolute paths.** The session-start hook and the MCP server entry start node by its absolute path (`process.execPath`, never
a version manager's shim), with the installed
script's absolute path: never a bare name or `npx`, which resolve through `PATH` or a project's `node_modules` (and `npx` with no
terminal installs a package without asking).

**One question list** drives the wizard, the flags, `--config` and the no-terminal output, so they can't drift.

**No-terminal mode** (the agent-experience trials): run with no TTY and without `--yes` or `--config`, setup changes nothing, prints each
question with the flag that answers it and the `--yes` line, and exits 3 ("needs answers"). An assistant then relays the
questions to the person (3 of 3 trials; with a plain wizard, 0 of 4 did: they handed the job back), or runs `--yes`.

**The README's two hand-off prompts name the command** (wording in the agent-experience notes): guided, "run
`skills-catalog setup` and ask me the questions it prints"; fast, "run `skills-catalog setup --yes`". Without the command
named, "set up the skills catalog, turn auto-updates on" sent one trial assistant to Claude Code's own settings instead;
with it, 9 of 9 ran ours first.

## 7. Ports (where a choice can change)

| Port | Local adapter | Hosted adapter (AWS) |
|---|---|---|
| `MetadataStore` (compare-and-append versions, latest pointer) | SQLite (`node:sqlite`) | DynamoDB |
| `BlobStore` (put-if-absent, get by sha256) | a folder by digest | S3 |
| `SearchIndex` (upsert, query, rebuild) | SQLite FTS5 (`tokenize='porter unicode61'`), any-word bm25 | an index file in S3, ranked in the Lambda (to ~10–30k skills), then OpenSearch Serverless |
| `Identity` (request → who's asking) | "act as" (phase 1): `--as <developer>`, `SKILLS_AS`, or the MCP server's config; default: your name from setup | sign-in, or a personal token (parked with AWS) |
| `TokenStore` (hashed personal tokens) | none | DynamoDB |
| `Events` (publish events, delivered at least once) | in-process, from an outbox table in SQLite | DynamoDB stream → a queue → an indexer handler (same bundle) that rewrites the search file in S3; one writer at a time (a queue with concurrency 1). Skill files in S3 are create-only; the search file is the one object that's rewritten |
| `Reviewer` (a version in, a review out) | the built-in rules reviewer (phase 1); agent reviewers (phase 2) | the same, run by the event handler |
| `Clock`, `Ids` | injectable | injectable |

The local adapters are shared by several processes on one folder (the MCP server, the CLI, `serve`), so: SQLite in WAL mode,
every write in `BEGIN IMMEDIATE`, and blobs written to a temp file then renamed. That keeps "nothing lost" true across processes.

### Who may publish (the owner's decision, 2026-09-28)

"Let's add a form of ACL. First priority is yes: only owners can publish, everyone (signed in) can read. Later, owners can assign
permissions to others. When running locally / for demo, simplify the "login" process (e.g. able to impersonate other devs; but
with a seamless/discreet label saying for demo purposes)."

- **Phase 1, in the core, local:** a skill's owner is its first publisher (`owners[]` on the skill record). A publish by anyone
  else returns `not_owner` {name, owners} and stores nothing (a conditional write). The publisher recorded is the acting identity,
  never a field in the request or the frontmatter. Everyone can read.
- **Phase 1, demo identity:** locally, you choose who you're acting as (the `Identity` row above), with no sign-in. Every CLI and
  MCP result then carries `acting_as`, and the CLI prints one discreet line, "(Acting as dev2, for demo purposes.)", last on every result and error. Locally this
  shows the rule; it isn't security: anyone on the machine can act as anyone. Assistants don't reach for that: in the
  agent-experience trials, asked to publish changes to another developer's skill, 5 of 5 relayed `not_owner` and offered to
  ask the owner or use a new name, and none switched identity or suggested it, so the error carries no warning against it.
- **Later:** owners assign permissions to others (maintainers who may publish versions); `add_skill_maintainer`,
  `remove_skill_maintainer`.
- **Parked with AWS:** everyone signs in to read; the acting identity is the verified sign-in or token; a publish-scope token
  covers only its holder's own skills.
- **Later:** a yanked version is hidden from `update_installed_skills` and new installs, and stays in the history marked yanked.

## 8. Settings that make it testable

- `SKILLS_CATALOG` (or `--catalog`): `file:///…` selects the local adapter, `https://…` the hosted one.
- `SKILLS_HOME` (or `--home`): the client's config, lock file and credentials.
- `SKILLS_INSTALL_DIR`: overrides where a target's skills land (tests point it into the sandbox).
- `SKILLS_ASSISTANT_HOME` (default: the OS home): the root under which setup, teardown, install targets and the MCP
  registration read and write the assistant's files (`.claude.json`, `.claude/settings.json`, `.claude/skills`). An
  agent-level test runs the assistant with the real home (for its login) and this setting inside the sandbox, so a setup the
  assistant runs never touches the owner's settings. The test runner refuses to start unless it points into the sandbox.
- `SKILLS_SYNC_ON_START=0` turns off the sync at MCP start, so update tests decide when sync happens.
- `SKILLS_ACTIVITY_LOG`: where the MCP server's activity log goes (§3), so a test or the demo can read it.
- Clock and ids are injected.
- The fail-safe lives in the test runner's shared setup, with a test that checks it's on: any write whose resolved path is under
  the real home (from the OS, not `$HOME`) fails the run.
- Platform: Node ≥ 24.15 (where `node:sqlite` is a release candidate; FTS5 is compiled in), pinned in the repo; a test checks that
  FTS5 works before any search test runs.

## 9. Error codes

**Internal errors** (CLI and MCP) show no traceback: `internal_error`, whose sentence says it's a bug in skills-catalog, not
to edit its files, and to tell the person (trial assistants otherwise tried to patch the tool's source). The traceback goes to
a log file in `$SKILLS_HOME`, named in the message.

`internal_error` {log}, `invalid_request` {field, why, limit?}, `invalid_manifest` {problem, fields} (the problems: §4.1),
`invalid_name` {name, why} (§4.1), `invalid_path` {path, why} (the whys: §4.2), `too_large` {limit, max, value},
`not_found` {suggestions} or {path}, `not_owner` {name, owners}, `conflict` {name, latest} (also when a held update's version
was overtaken, with its own sentence) or {name, folder} (a publish whose confirm doesn't verify for the folder as it is
now and its inputs, §3), `forbidden`, `unauthenticated` (locally: no acting identity set, so its sentence points to setup's `me` or `--as`; hosted: sign in), `exists_untracked` {path}, `name_in_use` {path},
`target_symlink` {path}, `secret_suspected` {path, line, kind}, `invalid_developer_setting` {setting} (§4.1),
`fingerprint_mismatch` {name, version, expected, got} (§5.3), `not_installed` {name} (§3), `invalid_local_file` {file, why, path} (§4.5). Each error carries the code and one plain sentence, and `why`
and `problem` are codes with a sentence each (wording in the agent-experience notes).

**An error's sentence is an instruction to the agent** (the agent-experience trials): one that asks for a change to the person's files
tells the agent to propose the change to the person and make it only once they agree ("propose a one-line description …";
2 of 2 trial assistants edited the person's SKILL.md themselves after "Fix: add a line", 0 of 3 after the reworded sentence).
`secret_suspected` names the file and line, never repeats the value, and, once the CLI's publish is built, points to the
person-only CLI override; until then it says to remove the secret and publish again.

A read's own input whys are in its row (§2): `name_and_names`, `required`, `paths_need_one_name`.

Limits on a request (more than 20 names or 20 paths in a read, a `limit` over 50, more than 10 tags in a search filter or a
tag over 32 characters: `invalid_request` {field: `filters.tags`, why: `too_many` or `item_too_long`, limit};
`item_too_long` is for an item of a list, so the sentence says one item is too long rather than the list, while `too_long`
stays for a single value) are errors,
`invalid_request` naming the field and the limit, never silently clamped: a clamp would hide the bug, and the error teaches
the agent the limit. Setup refuses the same way, writing nothing and exiting 1, a config that adds a key to
`safe_frontmatter_keys` or `non_granting_keys` (removing keys works), and `accept_flagged_updates: true` from `--config`,
`--yes` or the no-terminal mode (`invalid_request` {field}).

## 10. Quality reviews

The owner's requirements (their PRD notes and the auto-updates decision; requirements.md): automated reviews "on publish or offline", by "a
pluggable set of agents and/or rules executed by independent agents", whose goal is "to measure, with optional notes for the
submitter"; every entry point can "rank and/or advice (e.g. against)" a low-quality skill; findings "grounded", and reviewers
"completely fine with approving without comments when something's good"; and "other reviewer-based metrics or flags (maybe
phase 1 or phase 2) (e.g. risk of prompt injection, etc.)".

- **A review** is its own record, never part of the version (versions are immutable; reviews arrive later and get re-run):
  `{fingerprint, reviewer, reviewer_version, at, score (0–1), flags[], findings[], notes?}`. Each finding is grounded:
  `{path, line?, evidence, why}`. An empty `findings` is a normal, complete review.
- **Phase 1: one built-in rules reviewer**, a pure function in the shared `skill-tree` module. The catalog runs it on
  `version_published` and stores its review; the installer runs the same function on a fetched version before an update (§5.3).
  It flags what §5.3 lists: runnable files, commands run at load, command instructions while the assistant runs commands without asking, capability frontmatter, changed instructions in a skill that
  grants anything, other non-markdown files, a publisher change, prompt-injection patterns, and context cost.
- **Phase 2: agent reviewers**, pluggable through the `Reviewer` port, independent and offline (e.g. a sweep when a reviewer
  changes). Several can review one version; reviewers never block a publish.
- **Where measurements show:** search cards carry `quality` {flags} only when something is flagged (nothing when clean; ~10
  tokens, shown right after the name: in the agent-experience trials, 2 of 2 runs relayed it there, 1 of 2 at the card's end, and
  with it 2 of 2 warned the person about a planted instruction, while without it one run recommended that skill unwarned); `read_shared_skill` returns the
  reviews; `install_shared_skill` and `update_installed_skills` return `advisories[]`; a risk flag holds an update.
  Ranking search by the measurements: later.

## 11. After the first publish: what changed, and where it's built

The first published version holds the core catalog. Two independent security reviews (of the published code, then of this
revised design) and reviews of the core's code and its architecture changed these rules (all phase 1 unless marked):

| Rule | Section | Built |
|---|---|---|
| Written down to match the core: the path checks (invisible characters, a `.git` folder, long segments), `hooks` as a capability, flags carrying `field`, `from` and `to`, `invalid_manifest` {problem, fields}, unknown request fields refused | §2, §4.1, §4.2, §5.3, §9 | in the core now |
| `.claude`, `.claude-plugin` folders and memory files refused; reserved names; inherited request field names tested; frontmatter as a safe YAML subset with plain keys; the wider invisible-character set, full case folding and portable segments; the read's 24 KiB budget in every mode (`body_omitted`, `paths[]`, one path up to the file limit) and its fence token; search filter limits; the safe list of frontmatter keys in the core's diff (config can only remove keys); the secret scan in the core's publish, with `allow_suspected_secrets`; error sentences chosen by `problem` or `why`; flag text shown as escaped plain text; one-line fields (description, message, developer names) refuse line breaks and control characters, and faces replace them with a space; a diff's changed lines inside the fence | §2, §4.1, §4.2, §5.2, §5.3, §9 | in the core now |
| Versions stored under older rules read as stored, marked `stored_under_older_rules`, and a diff from one fails closed (the skill's owner can always publish a fix); front matter counted in the read's budget, first, and left out as `frontmatter_omitted` with its `grant_keys`; control characters inside the fence shown escaped, and the data note naming the end marker | §2, §4.4, §5.1, §5.2, §5.3 | later |
| The update hold's other flags: `runs_at_load` (the wide detector), `instructions_changed` (removals and safe keys too, `non_granting_keys`), files in a command position and outside the skill | §4.1, §5.3, §6, §10 | with the update hold, in the shared `skill-tree` module |
| The installer decides from bytes it checked (a fingerprint mismatch is `fingerprint_mismatch`; full validation of every fetched version, `refused`, its own flags); a first install through the update hold; never overwriting or shadowing what it didn't install (command files too); the install path computed; `accept_held_update` names the flags it accepts; install's policy CLI-only | §3, §4.5, §5.3 | with the installer |
| What setup pre-allows (generated from the registry; read-only commands never write); absolute paths from `process.execPath`; the prompt as the person's yes for person-only flags; `accept_flagged_updates` only from the terminal wizard; notices with fixed words; the MCP server's activity log | §3, §6, §8 | the activity log with the MCP server, the prompt as the person's yes for person-only flags with the CLI; the rest with setup and the session-start hook, later |
| A cooldown before auto-update applies a new version (0 locally, about 3 days for a shared or hosted catalog); the latest on request (watcher policy, `--latest`, accepting a held one), through the prompt; a report or withdrawal during the wait holds that version for everyone | §3, §5.3, §6, §7, §10 | decided by the owner; designed now, built with shared and hosted catalogs (a local catalog waits 0, so nothing changes in phase 1) |
| The two-step publish as consent: the publish repeats the name, version, file count and flags so its prompt shows them, and its `confirm` is a MAC only this machine's skills-catalog can make (`not_a_confirm` otherwise); an ignored folder skipped once, unwalked; paths in commands shell-quoted | §3, §5.2, §9 | with the MCP server and the CLI |
| A damaged lock or config file refused with `invalid_local_file`, never repaired, an unknown policy never taken as `auto`; teardown still runs | §4.5, §9 | with the installer |
| The secret scan's new shapes (`stripe_key`, `google_api_key`, `jwt`, `url_credentials`), a key ending in a secret word after `_` or a quote, matches that stand alone, UTF-16 and Latin-1 files scanned | §2 | the core's next update |
| The preview as its own tool, `preview_skill_publish`, and CLI command, `preview`, so the publish's prompt can't be pre-allowed by answering a preview | §3, §6 | with the MCP server and the CLI |
| One Unicode version for the path rules, the case-folding table's: code points it doesn't assign are refused on every runtime | §4.2 | the core's next update |
| Stored versions re-checked when the core's rules change, and those that fail reported | §5.3 | later |
| With auto-updates on, every surface asks only when an update is flagged; in a permissive mode (auto, bypass, the sandbox's auto-allow, a broad Bash rule) text that tells the assistant to run commands is flagged (`command_instruction`); plain `skills-catalog update` pre-allowed | §3, §5.3, §6 | decided by the owner; with the update hold (the mode detection) and setup (the pre-allowed update) |
| Usage metrics: seven local events (hold, notice, look, answer, policy, mode, use), skill names hashed, 90 days, never sent; `skills-catalog stats`; the four review triggers for the flag-only approvals | §3, §5.3 | phase 2 |
