# Skills catalog contract

The API of the skills catalog: its operations, data and rules. The implementation, its tests (the QA plan) and the words
assistants see (the agent-experience notes) all follow it, and a change to any shape starts here.

**Phases.** **1** = the build, all local; **2** = designed, local, not built yet; **AWS** = designed, an option in setup (off by
default), not built; **later**. The owner's direction: "Focus on phase 1 / local work. Bring back up AWS topics only after the
rest is finished and approved". Everything not marked phase 1 is here so phase 1 doesn't close doors; it isn't built.

**Why the rules are the way they are.** The owner's decisions (in decisions.md) set the scope, the update gate and who may publish.
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
(the agent-experience trials; `skills-catalog` is free on npm). CLI exit codes: 0 done, 1 an error, 3 "needs answers" (§6).

**The MCP server carries `instructions`** (~260 tokens; wording in the agent-experience notes). Claude Code
puts server instructions in the system prompt while deferred tools show only their names. In the agent-experience trials, without
instructions a small model answered "no such skill" without ever searching (0 of 3 found it); with them, 3 of 3 found it in one
search. The companion skill is
written by hand too, and a lint checks that every tool the instructions or the skill name exists in the registry.

## 2. Catalog operations

| Operation | Phase | MCP? | In | Out | Errors |
|---|---|---|---|---|---|
| `search_shared_skills` | 1 | yes | `query?` (words), `filters?` {`tags[]`, `publisher`, `updated_since`}, `limit` (default 10, max 50), `cursor?` | `results[]`: cards {`name`, `description`, `latest_version`, `tags`, `publisher`, `quality?`, `matched_words[]`}; `total_matches`, `catalog_size` ("3 of 52 skills match"); `match`: `all` (some card matched every content word) \| `partial` (cards only share some words) \| `none` (empty); `next_cursor?`; `ranking`: `none` (no words) \| `lexical` \| `semantic` \| `hybrid` | `invalid_request` |
| `read_shared_skill` | 1 | yes | `name` or `names[]` (≤20); `version?` (default latest); `include`: `manifest` (default) \| `files` \| `contents` | per skill: `name`, `version`, `latest_version`, `fingerprint`, `published_at`, `publisher`, `manifest` {frontmatter, body}, `reviews[]`; with `files`: the file list {path, mode, size, sha256, `type`: text \| binary}; with `contents`: also `content` on text files, SKILL.md included (binary never inlined) | per name: `not_found` {`suggestions[]`} (never an empty success) |
| `list_shared_skill_versions` | 1 | yes | `name`, `cursor?` | `latest`, `versions[]` {`version`, `fingerprint`, `published_at`, `publisher`, `message`, `flags[]`} | `not_found` {`suggestions[]`} |
| `diff_shared_skill_versions` | 1 | yes | `name`, `from`, `to` (versions) | `files[]` {`path`, `status`: added \| changed \| removed, `flags` {binary, executable, script}, `unified?`}; `frontmatter_changes[]` {field, from, to}; `publisher_changed`; `risk_flags[]` (§5.3) | `not_found` |
| `publish_version` | 1 | no (`publish_skill_to_catalog` calls it) | `name`, `files[]` {`path`, `mode`, `content_base64`}, `message?`, `expected_latest?`, `dry_run?` | `name`, `version`, `fingerprint`, `created` (false when identical to the latest), `dry_run` (echoed), `publisher` (the acting identity), `diff_from_latest`, `risk_flags[]` | `invalid_manifest` {fields}, `invalid_name`, `invalid_path` {path, why}, `too_large` {limit, max, value}, `not_owner` {name, owners}, `conflict` {name, latest}, `forbidden`, `unauthenticated` |
| `fetch_version` | 1 | no | `name` and `version`, or `fingerprint` | `fingerprint`, `files[]` {path, mode, content_base64}; cacheable by fingerprint | `not_found` |

- **Keyword search ranks by any word** (bm25; common words dropped), because agents search with any-of-these-words queries
  ("release notes changelog sprint changes"): with all-words matching they needed 3–13 searches and once reached a wrong
  conclusion; with any-word ranking, one search, 3/3 (the agent-experience trials).
- **"Nothing matches" (the PRD's FR-02) is told by `match`, not by an empty page.** Any-word ranking lets one shared word through
  ("graphql schema" finds a SQL migration skill by "schema"; one of the QA plan's no-match queries, on real FTS5). So each card says which content words it
  matched, and the page says `partial` when no card matched them all. The server instructions and the tool description (wording in the agent-experience notes) say: if `match` is `partial`,
  tell the user nothing matched exactly, then offer the closest, saying what they share ("these only share the word
  'schema'"), never presenting one as a fit. The agent-level no-match scenarios are the gate. A semantic or hybrid search
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
| `publish_skill_to_catalog` | 1 | `folder`, `message?`, `confirm?` | step 1 (no `confirm`): the files to send, the files skipped, the diff against the latest, `risk_flags[]`, and a `confirm` token tied to the folder's fingerprint; step 2 (with `confirm`): as `publish_version` | Two steps, so the person sees what will be published before it is: a changed folder between the steps gives `conflict`. Reads the folder: regular files only, never follows a link out, skips and reports the ignore list (`.git`, `.env*`, `*.pem`, `id_*`, `.DS_Store`). A secret-scan hit anywhere, the body included, **rejects** with `secret_suspected` {path, line, kind}; only the person can override it, per publish, with the CLI flag `--allow-suspected-secrets`, which is **not in the MCP schema**. Setup never adds this tool to the assistant's allowed tools, so its permission prompt is the person's consent |
| `install_shared_skill` | 1 | `name`, `version?`, `policy?`, `target`: `user` \| `project` | `path`, `version`, `fingerprint`, `advisories[]` | `fetch_version` → temp folder → check fingerprint → rename into `<skills dir>/<name>`; refuses `exists_untracked` and a symlinked target; records the lock |
| `update_installed_skills` | 1 | `names?`, `dry_run?` | per skill: `updated` {from, to, changes} \| `unchanged` \| `held` {reason: `notify` \| `pin` \| `flagged`, `risk_flags[]`, diff, `confirm`} | One batched status call; skipped if the last sync was under a few minutes ago; the action is §5.3's table |
| `accept_held_update` | 1 | `name`, `confirm` (from the held result) | as `updated` | Takes one held update once the person says yes. `confirm` is tied to the name and the new version's fingerprint: `conflict` if a newer version arrived since. Setup never adds this tool to the assistant's allowed tools, so its permission prompt is the person's consent (the same pattern as publish). The lock records which flags each acceptance let through. CLI: `skills-catalog update <name> --accept` shows the reasons and asks |
| `list_installed_skills` | 1 | | per installed skill: `version`, `latest`, `policy`, `state`: `same` \| `behind` | Reads the lock; no local-change check in phase 1 (§5.4) |
| `set_skill_update_policy` | 1 | `policy`, `name?` (none = the global default) | the effective policy | `auto` \| `notify` \| `pin` |
| `setup` | 1 | the setup config (§6) | first, the person's one remaining step ("start a new Claude Code session; this one can't use the tools yet"); then what was written, and "N skills to search; none installed yet" | The colourful wizard, `--yes`, `--config <file>`, the setup skill and the setup doc all produce this config; with no terminal, the no-terminal mode (§6); never asks for a token in chat |
| `teardown` | 1 | | what was removed | Undoes setup: the MCP entry, the companion skill, the hook, the backed-up settings files restored; and the AWS stack, when setup created one |
| `serve` (CLI only) | 2 | `port?` | the local URL | Serves the web UI and the HTTP face on your machine, no sign-in: 127.0.0.1 only, a Host allow-list, exact Origin + JSON + a per-launch token on writes, no CORS |
| `login` (CLI only) | AWS | `scope`: `read` \| `publish` | who you're signed in as, the scope, the expiry | The person completes a browser sign-in (a device code, so it works on a remote machine too) and approves the token; stored in `$SKILLS_HOME/credentials` (mode 0600), never in a project file, an MCP config, a URL or the chat. AWS `setup` calls it; when an agent runs setup, the person finishes the sign-in |
| `logout` (CLI only) | AWS | | done | Revokes the token and deletes the file |

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
Other MCP clients get the notice in the server's instructions. The hook prints nothing when nothing waits, always exits 0, and
gives up on the sync after 2 seconds (the rest happens at MCP start), so it never slows or breaks a session.

## 4. Data

### 4.1 A skill and its manifest (the Agent Skills `SKILL.md` format)

- `SKILL.md` at the root: YAML frontmatter, then a markdown body. Required: `name`, `description`, a non-empty body.
- `name`: lowercase letters, digits and hyphens; 1–64 characters; no leading, trailing or double hyphen; must equal the catalog name.
- `description`: 1–1024 characters, no `<` or `>`.
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
- Other frontmatter keys are kept as published. Keys that grant capability (`allowed-tools`, and any key in the config's
  `capability_keys` list) are risk flags (§5.3).
- Frontmatter is parsed with a safe YAML schema (no custom tags).

### 4.2 Files

- Paths are relative, `/`-separated, NFC-normalised UTF-8; no absolute paths, no `..`, no empty segments; no two paths that are
  equal ignoring case.
- Regular files only (no links, devices, hardlink tricks); mode `0644` or `0755`.
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

### 4.5 On your machine

- **Default places** (when nothing points elsewhere; one folder, so teardown and the clean-run check have one place to look):
  `$SKILLS_HOME` = `~/.skills-catalog/` (config, lock file, credentials, `logs/`); the local catalog = `~/.skills-catalog/catalog/`
  (the SQLite file and the files by digest), shared by every developer acting on this machine; installed skills go to the
  assistant's own folder, `~/.claude/skills/<name>/` for Claude Code (under `$SKILLS_ASSISTANT_HOME`). XDG folders are not used.
- **Config** (`$SKILLS_HOME/config.json`, mode 0600): §6's setup config.
- **Lock file** (`$SKILLS_HOME/lock.json`): per installed skill and target: `version`, `fingerprint`, `policy?`, `target`,
  `path`, `installed_at`, `catalog`. This installer's list is where an installed skill's origin is kept, keyed by where it's
  installed; nothing is written into the skill itself (the owner chose this, `skills-where-it-came-from` (a), 23:11Z).
- Installed files are never edited by the client except by an install or update of that skill.

## 5. Rules

### 5.1 Publish, in order (the all-or-nothing point)

1. Validate the manifest and files (the shared `skill-tree` module). Any failure: an error, nothing stored.
2. Put each file's bytes by sha256 (safe to repeat).
3. Compare-and-append the version (the commit point); on a number clash the core retries with the next number.
4. Emit a `version_published` event {name, version, fingerprint, publisher, at} through the `Events` port. Its subscribers: the
   search index (may lag; rebuildable from versions at any time) and the rules reviewer (§10), which stores its review.

On AWS: S3 puts, then one conditional DynamoDB write.

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

### 5.3 The update gate (the owner's decision)

`risk_flags` for an update are:
- from its diff: any non-markdown file added or changed, an executable bit set, a capability key in the frontmatter changed, a
  different publisher;
- from the rules reviewer (§10), run by the installer on the fetched version, so the gate never waits for the catalog:
  prompt-injection patterns (instructions to ignore prior guidance, exfiltration or curl-to-shell, hidden unicode, HTML
  comments), and context cost over the configured budget;
- from agent reviewers (phase 2), when their reviews exist; a missing agent review never holds an update.

One reason per file: `runnable_file` wins over `non_markdown` for the same path (a new script is one reason, not two).

Each flag says what fired, in one shape everywhere (the diff, a publish's step 1, a held update, a card's `quality`), so the web
UI, the CLI and an agent show one verdict (the web UI's compare screen shows the same):
`{kind: runnable_file | non_markdown | capability_frontmatter | new_publisher | prompt_injection | context_cost, path?, line?,
detail}`, e.g. `{kind: new_publisher, detail: "alice → bob"}`, `{kind: capability_frontmatter, path: "SKILL.md", detail:
"allowed-tools added: Bash"}`.

| Policy | `risk_flags` | Action |
|---|---|---|
| `pin` | any | `held: pin` |
| `notify` | any | `held: notify`, shown with its diff |
| `auto` | none | `updated`, and the assistant is told what changed |
| `auto` | any | `held: flagged`, shown with its diff and the flags; in unattended runs, held and reported at the next session (see "Telling the person", §3) |

An update replaces the installed copy (§5.4). A setup option, `accept_flagged_updates` (default false), lets a person opt out of
the gate for unattended machines; the wizard explains it, and the lock records each update it let through.

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
- `update_policy`: the wizard asks "Keep skills up to date automatically? (Y/n)", default yes; `overrides` {name: policy}.
- `accept_flagged_updates` (default false; §5.3); `capability_keys`; the context-cost budget for the rules reviewer.
- `targets`: the Claude Code user skills folder by default; any MCP client.
- the session-start hook: on by default for Claude Code (it syncs and tells the person about held updates); teardown removes it.
- `me`: your developer name (the default acting identity); `demo_developers` (default none; the wizard offers "Add two demo
  developers, dev1 and dev2, to try it? (y/N)"), so the README's demo can show Developer 1 publishing and Developer 2 finding,
  installing, and not being able to overwrite it.
- `aws` (only with `hosting: aws`; the wizard asks "Set it up in AWS too? (y/N)"): `profile`, `region`, the stack's settings.
  Setup checks the credentials, shows what it will create and the monthly cost, asks before CDK's one-time account bootstrap,
  deploys, runs `login`, and prints the URL. `teardown` destroys the stack.

Setup writes assistant settings with a temp file and rename, after a backup; teardown restores them.

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
  MCP result then carries `acting_as`, and the CLI prints one discreet line, "acting as dev2 (for demo purposes)". Locally this
  shows the rule; it isn't security: anyone on the machine can act as anyone.
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
- Clock and ids are injected.
- The fail-safe lives in the test runner's shared setup, with a test that checks it's on: any write whose resolved path is under
  the real home (from the OS, not `$HOME`) fails the run.
- Platform: Node ≥ 24.15 (where `node:sqlite` is a release candidate; FTS5 is compiled in), pinned in the repo; a test checks that
  FTS5 works before any search test runs.

## 9. Error codes

**Internal errors** (CLI and MCP) show no traceback: `internal_error`, whose sentence says it's a bug in skills-catalog, not
to edit its files, and to tell the person (trial assistants otherwise tried to patch the tool's source). The traceback goes to
a log file in `$SKILLS_HOME`, named in the message.

`internal_error` {log}, `invalid_request` {field, why, limit?}, `invalid_manifest` {fields}, `invalid_name`, `invalid_path`
{path, why}, `too_large` {limit, max, value}, `not_found` {suggestions}, `not_owner` {name, owners}, `conflict` {name, latest}
(also when a held update's version was overtaken, with its own sentence), `forbidden`, `unauthenticated`, `exists_untracked`,
`target_symlink` {path}, `secret_suspected` {path, line, kind}. Each error carries the code and one plain sentence (wording in
the agent-experience notes).

**An error's sentence is an instruction to the agent** (the agent-experience trials): one that asks for a change to the person's files
tells the agent to propose the change to the person and make it only once they agree ("propose a one-line description …";
2 of 2 trial assistants edited the person's SKILL.md themselves after "Fix: add a line", 0 of 3 after the reworded sentence).
`secret_suspected` names the file and line, never repeats the value, and points to the person-only CLI override.

Limits on a request (more than 20 names in a read, a `limit` over 50) are errors, `invalid_request` naming the field and the
limit, never silently clamped: a clamp would hide the bug, and the error teaches the agent the limit.

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
  It flags: scripts and executables, capability frontmatter, a publisher change, prompt-injection patterns, and context cost.
- **Phase 2: agent reviewers**, pluggable through the `Reviewer` port, independent and offline (e.g. a sweep when a reviewer
  changes). Several can review one version; reviewers never block a publish.
- **Where measurements show:** search cards carry `quality` {flags} only when something is flagged (nothing when clean; ~10
  tokens, shown right after the name: in the agent-experience trials, 2 of 2 runs relayed it there, 1 of 2 at the card's end, and
  with it 2 of 2 warned the person about a planted instruction, while without it one run recommended that skill unwarned); `read_shared_skill` returns the
  reviews; `install_shared_skill` and `update_installed_skills` return `advisories[]`; the update gate holds on risk flags.
  Ranking search by the measurements: later.
