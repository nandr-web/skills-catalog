# The catalog's API

Every operation as the code has it today: what you call, with what, and what comes back, with a real run of each.

*As built on the product's main branch (4cc3747), 2026-09-29. The HTTP form is planned, not built yet.*

## The operations at a glance

Every operation, grouped by what it acts on; the chips say where each one can be called, and whether that is built yet.

![Every operation of the catalog as built, grouped by what it acts on, each as name(inputs) → output, with its faces: the Assistant's tool, the CLI, HTTP. The shared skills: search_shared_skills(query?, filters?{tags, publisher, updated_since}, limit = 10, cursor?) → cards\[\] + match + total_matches + next_cursor?; read_shared_skill(name | names\[\], version = latest, include = manifest, paths\[\]?) → skills\[\] + inline_budget; list_shared_skill_versions(name, cursor?) → versions\[\], newest first, 50 a page; diff_shared_skill_versions(name, from, to) → files\[\] + frontmatter_changes\[\] + risk_flags\[\]. Each has a tool and a CLI command, built; HTTP is planned. The catalog's own, with no tool or command: publish_version(name, files\[\], message?, expected_latest?, dry_run = false) → version, fingerprint, created, diff_from_latest, risk_flags\[\]; fetch_version(name + version | fingerprint) → files\[\]. HTTP planned. This machine's installed skills, never over HTTP: preview_skill_publish(folder, message?), on a branch; publish_skill_to_catalog(folder, message?, confirm?, name?, version?, files?, flags\[\]?) → text only, a tool, its CLI command on a branch; install_shared_skill(name, version = latest, target = user) → text only; update_installed_skills(names\[\] = all, dry_run = false) → text only; accept_held_update(name, target, version, confirm, flags\[\]) → text only, CLI for a person only; list_installed_skills() → text only; set_skill_update_policy(policy, name? = every skill) → text only. CLI only and planned: setup and teardown on a branch, serve planned, stats and mcp built. Dotted means not built yet. Inputs the Assistant's tool doesn't take are left out.](pictures/api-overview.svg)

**The shared skills (the catalog).** The Assistant, the Developer, and (planned) the web page read these.

| Operation | Signature | Tool | CLI | HTTP status |
|---|---|---|---|---|
| [search_shared_skills](#search_shared_skills) | `search_shared_skills(query?, filters?{tags, publisher, updated_since}, limit = 10, cursor?)` → cards[] + match + total_matches + next_cursor? | built | built | planned |
| [read_shared_skill](#read_shared_skill) | `read_shared_skill(name \| names[], version = latest, include = manifest, paths[]?)` → skills[] {manifest, files[]?} + inline_budget | built | built | planned |
| [list_shared_skill_versions](#list_shared_skill_versions) | `list_shared_skill_versions(name, cursor?)` → versions[] (newest first, 50 a page) + next_cursor? | built | built | planned |
| [diff_shared_skill_versions](#diff_shared_skill_versions) | `diff_shared_skill_versions(name, from, to)` → files[] + frontmatter_changes[] + risk_flags[] | built | built | planned |

**The catalog's own.** No tool, no command: this machine's operations call them.

| Operation | Signature | Tool | CLI | HTTP status |
|---|---|---|---|---|
| [publish_version](#publish_version) | `publish_version(name, files[], message?, expected_latest?, dry_run = false)` → version + fingerprint + created + diff_from_latest + risk_flags[] | — | — | planned |
| [fetch_version](#fetch_version) | `fetch_version(name + version \| fingerprint)` → files[] {path, mode, content_base64} | — | — | planned |

**This machine's installed skills.** Run on the Developer's machine; never over HTTP.

| Operation | Signature | Tool | CLI | HTTP status |
|---|---|---|---|---|
| [preview_skill_publish](#preview_skill_publish-on-a-branch) | `preview_skill_publish(folder, message?)` → files to send and skip + diff + confirm | on a branch | on a branch | never |
| [publish_skill_to_catalog](#publish_skill_to_catalog) | `publish_skill_to_catalog(folder, message?, confirm?, name?, version?, files?, flags[]?)` → text only: a preview (no confirm), or "Published … v{n}" | built | on a branch | never |
| [install_shared_skill](#install_shared_skill) | `install_shared_skill(name, version = latest, target = user)` → text only: installed \| unchanged \| held for a yes | built | built | never |
| [update_installed_skills](#update_installed_skills) | `update_installed_skills(names[] = all, dry_run = false)` → text only, per skill: updated \| unchanged \| held \| refused | built | built | never |
| [accept_held_update](#accept_held_update) | `accept_held_update(name, target, version, confirm, flags[])` → text only: the held update, installed | built | built, for a person at a terminal | never |
| [list_installed_skills](#list_installed_skills) | `list_installed_skills()` → text only: each skill's version, the latest, its update setting | built | built | never |
| [set_skill_update_policy](#set_skill_update_policy) | `set_skill_update_policy(policy, name? = every skill)` → text only: the new setting | built | built | never |

**CLI only, and planned.** [setup, teardown, serve, stats, mcp](#cli-only-and-planned-setup-teardown-serve-stats-mcp).

"On a branch" and "planned" mean not built on main yet. "Text only" means the operation answers in sentences today, no data. Inputs the Assistant's tool doesn't take (install's policy, update's latest, the secret override) are left out of the signatures.

## What every call shares

- **Strict inputs:** an unknown field, or one past its limit, is refused with invalid_request naming the field and the limit; nothing is ever cut to fit.
- **Errors any call can return,** besides each operation's own: **invalid_request** (a field outside its schema), **invalid_developer_setting** (the demo-developer setting isn't a developer's name), **internal_error** (a bug; its details go to a log file). When the catalog can't be opened: **invalid_request** (its location) or **forbidden** (a hosted address, not built).
- **The demo line:** while the demo-developer setting is on, every answer ends with "(Acting as bob, for demo purposes.)". The examples here leave it out.
- **The CLI:** every command also takes --as &lt;developer>, and exits 0 when done, 1 on an error, 3 when it needs the person at a terminal.

## The shared skills (the catalog)

### search_shared_skills

Finds shared skills by words, tags, publisher or date, a page of cards at a time, best match first. With no words it lists the whole catalog.

```text
Assistant's tool
  search_shared_skills {"query": "release notes", "limit": 3}

CLI
  skills-catalog search release notes --limit 3
  (also --tags a,b  --publisher <name>  --updated-since <date>  --cursor <c>)

HTTP (planned)
  POST /api/v1/search_shared_skills
  {"query": "release notes", "limit": 3}
  → 200 {"ok": true, "data": {"results": […], "match": "all", …}}
```

| Input | Type | Default | Limit | Required |
|---|---|---|---|---|
| query | text | none: lists the whole catalog | 500 characters | no |
| filters.tags | list of text | none | 10 tags, 32 characters each | no |
| filters.publisher | text | none | 200 characters | no |
| filters.updated_since | text, compared with the published date (YYYY-MM-DD); not checked | none | 40 characters | no |
| limit | whole number | 10 | 1 to 50 | no |
| cursor | text | none: the first page | 200 characters | no |

#### Output

- **results[]**, one card per skill: name, description, latest_version, tags[], publisher, matched_words[]
- **match**: all | partial (the cards share only some of the words) | none
- **ranking**: none (no words) | lexical
- **total_matches** and **catalog_size** ("6 of 64 skills match"); **next_cursor** when there's another page

*Differs from [the design](contract.md) (the planned version of this API):* the design adds quality to each card and semantic or hybrid ranking; a tag over 32 characters is too_long in the code, item_too_long in the design.

#### Errors

- **invalid_request**: a field past its limit (limit over 50, more than 10 tags, a tag over 32 characters, a query over 500), or a cursor no earlier page gave

#### Example

```text
search_shared_skills {"query": "release notes", "limit": 3}
→ {"results": [
     {"name": "release-note-draft", "description": "Drafts release notes from merged pull
      requests using the team template. Use when preparing a release.",
      "latest_version": 4, "tags": [], "publisher": "ana",
      "matched_words": ["release", "notes"]},
     {"name": "changelog-from-commits", …, "matched_words": ["release", "notes"]},
     {"name": "test-coverage-gaps", …, "matched_words": ["release"]}],
   "match": "all", "ranking": "lexical", "total_matches": 6, "catalog_size": 64,
   "next_cursor": "eyJvIjozfQ"}

The Assistant and the CLI read it as sentences:
  Shared catalog: 6 of 64 skills match "release notes" (keyword match).
  - release-note-draft (v4, ana; tags: none): Drafts release notes from merged pull …
```

*A real run of the code on main, on the 64-skill test catalog.*

### read_shared_skill

Reads one skill, or up to 20 together, without installing it: its SKILL.md, version and publisher, and optionally its file list or its files' text.

```text
Assistant's tool
  read_shared_skill {"name": "release-note-draft"}

CLI
  skills-catalog read release-note-draft
  (also several names; --version <n>; --files or --contents; --path <file>, repeated)

HTTP (planned)
  POST /api/v1/read_shared_skill
  {"name": "release-note-draft"}
  → 200 {"ok": true, "data": {"skills": […], "inline_budget": {…}}}
```

| Input | Type | Default | Limit | Required |
|---|---|---|---|---|
| name | text | — | 64 characters: lowercase letters, digits, single hyphens | name or names |
| names | list of text | — | 20 names, 64 characters each | name or names |
| version | whole number | the latest | from 1 | no |
| include | manifest, files or contents | manifest (contents when paths is given) | — | no |
| paths | list of text | every file (with files or contents) | 20 paths, 4,096 characters each; with name only | no |

#### Output

- **skills[]**, one per name: name, version, latest_version, fingerprint, published_at, publisher, manifest {frontmatter, body}, reviews[] (always empty today)
- with include files: **files[]** {path, mode, size, sha256, type: text | binary}; with contents, also each text file's content
- **inline_budget** {limit: 24,576 bytes, used, omitted}: a body or file that doesn't fit is marked body_omitted or content_omitted, never cut
- with names[], a name that isn't found is {name, error} in the list; the others still come

*Differs from [the design](contract.md):* the design adds owners[] (who may publish it), each file's flags (binary, executable, script), a front matter left out for size (frontmatter_omitted, grant_keys), and stored_under_older_rules (a version stored before today's rules). None is in the code yet.

#### Errors

- **not_found**: no skill by that name, with names spelled like it (suggestions); or a version or path it doesn't have
- **invalid_name**: the name can't be a skill's name
- **invalid_request**: name and names together, neither of them, or paths with names

#### Example

```text
read_shared_skill {"name": "release-notes-draft"}
→ error {"code": "not_found", "name": "release-notes-draft",
         "suggestions": ["release-note-draft"]}

read_shared_skill {"name": "release-note-draft"}
→ {"skills": [{"name": "release-note-draft", "version": 4, "latest_version": 4,
     "fingerprint": "sha256:2b955e3e…", "published_at": "2026-09-29T16:13:22.454Z",
     "publisher": "ana",
     "manifest": {"frontmatter": {"name": "release-note-draft",
                                  "description": "Drafts release notes …"},
                  "body": "# Release note draft\n\n1. List the merged PRs since the last tag.\n…"},
     "reviews": []}],
   "inline_budget": {"limit": 24576, "used": 184, "omitted": 0}}
```

*A real run of the code on main, on the 64-skill test catalog.*

### list_shared_skill_versions

Lists a skill's versions, newest first, 50 a page: number, fingerprint, date, publisher and the publisher's note.

```text
Assistant's tool
  list_shared_skill_versions {"name": "release-note-draft"}

CLI
  skills-catalog versions release-note-draft      (--cursor <c> for older ones)

HTTP (planned)
  POST /api/v1/list_shared_skill_versions
  {"name": "release-note-draft"}
  → 200 {"ok": true, "data": {"name": …, "latest": 4, "versions": […]}}
```

| Input | Type | Default | Limit | Required |
|---|---|---|---|---|
| name | text | — | 64 characters: lowercase letters, digits, single hyphens | yes |
| cursor | text | none: the newest 50 | 200 characters | no |

#### Output

- **name**, **latest**
- **versions[]**: version, fingerprint, published_at, publisher, message, flags[]
- **next_cursor** when older versions remain

*Differs from [the design](contract.md):* flags[] is always empty in the code.

#### Errors

- **not_found**: no skill by that name, with names spelled like it
- **invalid_name**; **invalid_request** (a cursor no earlier page gave)

#### Example

```text
list_shared_skill_versions {"name": "release-note-draft"}
→ {"name": "release-note-draft", "latest": 4, "versions": [
     {"version": 4, "fingerprint": "sha256:2b955e3e…",
      "published_at": "2026-09-29T16:13:22.454Z", "publisher": "ana",
      "message": "template gains Breaking changes", "flags": []},
     {"version": 3, …, "message": "adds an example", "flags": []},
     {"version": 2, …}, {"version": 1, …}]}
```

*A real run of the code on main, on the 64-skill test catalog.*

### diff_shared_skill_versions

Shows exactly what changed between two versions: files added, changed or removed, line by line, changed front matter, and whether the change can run something new on this machine.

```text
Assistant's tool
  diff_shared_skill_versions {"name": "release-note-draft", "from": 3, "to": 4}

CLI
  skills-catalog diff release-note-draft --from 3 --to 4

HTTP (planned)
  POST /api/v1/diff_shared_skill_versions
  {"name": "release-note-draft", "from": 3, "to": 4}
  → 200 {"ok": true, "data": {"files": […], "risk_flags": […], …}}
```

| Input | Type | Default | Limit | Required |
|---|---|---|---|---|
| name | text | — | 64 characters: lowercase letters, digits, single hyphens | yes |
| from | whole number | — | from 1 | yes |
| to | whole number | — | from 1 | yes |

#### Output

- **name**, **from**, **to**
- **files[]**: path, status (added | changed | removed), flags {binary, executable, script}, unified (the line-by-line change)
- **frontmatter_changes[]** {field, from, to}; **publisher_changed**
- **risk_flags[]** {kind, path, detail}: what could run something new

*Differs from [the design](contract.md):* the design adds stored_under_older_rules (a version stored before today's rules); not in the code.

#### Errors

- **not_found**: the skill, or either version
- **invalid_name**

#### Example

```text
diff_shared_skill_versions {"name": "release-note-draft", "from": 3, "to": 4}
→ {"name": "release-note-draft", "from": 3, "to": 4,
   "files": [
     {"path": "examples/sample-output.md", "status": "removed",
      "flags": {"binary": false, "executable": false, "script": false}, "unified": "…"},
     {"path": "templates/release.md", "status": "changed", "flags": {…},
      "unified": "…@@ -1,5 +1,7 @@\n # Release {{version}}\n \n+## Breaking changes\n+\n …"}],
   "frontmatter_changes": [], "publisher_changed": false, "risk_flags": []}
```

*A real run of the code on main, on the 64-skill test catalog.*

## The catalog's own: no tool, no command

### publish_version

Stores a new version of a skill from its files: the only write into the catalog. No tool or command calls it directly; this machine's publish (publish_skill_to_catalog) does.

```text
Assistant's tool
  none: publish_skill_to_catalog calls it

CLI
  none

HTTP (planned; a real publish only with serve --publish, dry runs always)
  POST /api/v1/publish_version
  {"name": "pr-review-checklist", "files": [{"path": "SKILL.md", "mode": "0644",
   "content_base64": "LS0t…"}, …], "message": "lint script", "dry_run": true}
  → 200 {"ok": true, "data": {"version": 3, "created": false, "dry_run": true, …}}
```

| Input | Type | Default | Limit | Required |
|---|---|---|---|---|
| name | text | — | 64 characters: lowercase letters, digits, single hyphens | yes |
| files | list of {path, mode, content_base64} | — | 100 files, 1 MB each, 5 MB in all; a path 1,024 bytes (each part 255); mode 0644 or 0755 | yes |
| message | text, one line | none | 1,000 characters | no |
| expected_latest | whole number | none: not checked | from 0 (0 means a new name) | no |
| dry_run | yes or no | no | — | no |
| allow_suspected_secrets (CLI only, passed on from a CLI publish) | yes or no | no | — | no |

#### Output

- **name**, **version**, **fingerprint**, **publisher** (who is acting, never a field of the request)
- **created**: false for a dry run, or when the files are identical to the latest; **dry_run**, echoed
- **diff_from_latest** (null for a new skill) and **risk_flags[]**

*Differs from [the design](contract.md):* the design adds expected_fingerprint (the files must have exactly this fingerprint) and stored_under_older_rules; neither is in the code.

#### Errors

Checked in this order: the owner, then the latest, then the files.

- **unauthenticated**: no developer is set to publish as
- **not_owner**: someone else owns the name (the owners are named)
- **conflict**: the latest version isn't expected_latest
- **too_large**: past 100 files, 1 MB a file or 5 MB a skill
- **invalid_manifest**, **invalid_name**, **invalid_path**: SKILL.md, the name or a path breaks the skill rules
- **secret_suspected**: a file looks like it holds a secret (its path, line and kind; never the value)
- **invalid_request**: a message with a line break, or content that isn't base64

#### Example

```text
publish_version {"name": "pr-review-checklist", "message": "lint script", "dry_run": true,
                 "files": [SKILL.md, checklist.md, scripts/lint.sh (0755)]}   acting as bob
→ {"name": "pr-review-checklist", "version": 3, "fingerprint": "sha256:a4e3f8ce…",
   "created": false, "dry_run": true, "publisher": "bob",
   "diff_from_latest": {"files": [{"path": "SKILL.md", "status": "changed", …},
                                  {"path": "scripts/lint.sh", "status": "added", …}], …},
   "risk_flags": [{"kind": "runnable_file", "path": "scripts/lint.sh",
                   "detail": "executable script"}]}

The same files, not a dry run, acting as ana:
→ error {"code": "not_owner", "name": "pr-review-checklist", "owners": ["bob"]}
```

*A real run of the code on main, on the 64-skill test catalog.*

### fetch_version

Gives a version's files, by name and version or by fingerprint. The installer calls it; nothing else does today.

```text
Assistant's tool
  none: the installer calls it directly

CLI
  none

HTTP (planned)
  POST /api/v1/fetch_version
  {"name": "pr-review-checklist", "version": 2}
  → 200 {"ok": true, "data": {"fingerprint": "sha256:…", "files": […]}}
  GET /api/v1/files/<sha256>      one file's bytes, named by its fingerprint
```

| Input | Type | Default | Limit | Required |
|---|---|---|---|---|
| name | text | — | 64 characters: lowercase letters, digits, single hyphens | with version |
| version | whole number | — | from 1 | with name |
| fingerprint | text | — | 80 characters | or name and version |

#### Output

- **name**, **version**, **fingerprint**
- **files[]**: path, mode, content_base64

#### Errors

- **not_found**: no such version or fingerprint
- **invalid_request**: a fingerprint with a name or version, or name and version not both given
- **invalid_name**

#### Example

```text
fetch_version {"name": "pr-review-checklist", "version": 2}
→ {"name": "pr-review-checklist", "version": 2, "fingerprint": "sha256:4700ec4b…",
   "files": [{"path": "SKILL.md", "mode": "0644", "content_base64": "LS0tCm5hbWU6…"},
             {"path": "checklist.md", "mode": "0644", "content_base64": "…"}]}
```

*A real run of the code on main, on the 64-skill test catalog.*

## This machine's installed skills

### preview_skill_publish (on a branch)

**On a branch, not on main yet.** The first step of publishing a folder, as a tool of its own, so allowing previews never allows a publish. Today this step is publish_skill_to_catalog called without confirm.

```text
Assistant's tool (on a branch)
  preview_skill_publish {"folder": "…/pr-review-checklist", "message": "lint script"}

CLI (on a branch)
  skills-catalog preview …/pr-review-checklist --message "lint script"

HTTP
  none: the web page never gets a machine operation
```

| Input | Type | Default | Limit | Required |
|---|---|---|---|---|
| folder | text (a path) | — | 4,096 characters | yes |
| message | text, one line | none | 1,000 characters | no |
| allow_suspected_secrets (a person only) | yes or no | no | — | no |

#### Output (planned)

The files it would send and the ones it skips, the diff against the latest, risk_flags[], and the values the publish takes: confirm, name, version, files, flags[] and the message; or that nothing would change.

### publish_skill_to_catalog

Publishes a skill folder from this machine as a new version, in two calls: without confirm it previews and publishes nothing; called again with the preview's values, after the person's yes, it publishes.

```text
Assistant's tool
  publish_skill_to_catalog {"folder": "…/pr-review-checklist", "message": "lint script"}
  publish_skill_to_catalog {"folder": "…/pr-review-checklist", "message": "lint script",
    "confirm": "lQwMW_XZ…", "name": "pr-review-checklist", "version": 3,
    "files": 3, "flags": ["runnable_file"]}

CLI
  no command on main (on a branch: skills-catalog preview <folder>, and
  skills-catalog publish <folder> --confirm … --name … --version … --files … --flags …)

HTTP
  none: the web page never gets a machine operation
```

| Input | Type | Default | Limit | Required |
|---|---|---|---|---|
| folder | text (a path) | — | 4,096 characters | yes |
| message | text, one line | none | 1,000 characters | no |
| confirm | text | none: a preview | 2,000 characters | step 2 |
| name | text | — | 64 characters: lowercase letters, digits, single hyphens | step 2 |
| version | whole number | — | from 1 | step 2 |
| files | whole number | — | from 0 | step 2 |
| flags | list of flag kinds | — | 20; each one of 9 kinds | step 2 |
| allow_suspected_secrets (CLI only; no command takes it yet) | yes or no | no | — | no |

#### Output

Text only today. Step 1 reports the version it would become and the change from the latest, the files it would send and the ones it skips (50 named at most), what can run, and the values for step 2; or "Nothing to publish" when the folder matches the latest. Step 2 reports "Published {name} v{n} to the shared catalog".

*Differs from [the design](contract.md):* the design moves step 1 to preview_skill_publish and makes confirm, name, version, files and flags required here, with a CLI command for each (on a branch); and it returns publish_version's data, where the code returns text.

#### Errors

- **invalid_request**: step-2 values without confirm, confirm without them, or a confirm that isn't 43 base64url characters
- **conflict**: the folder, the message or a value changed since the preview, or the confirm never came from one (the folder is named); or someone published in between
- publish_version's: **not_owner**, **too_large**, **invalid_manifest** (no SKILL.md, too), **invalid_name**, **invalid_path** (a link or special file), **secret_suspected**, **unauthenticated**

#### Example

```text
publish_skill_to_catalog {"folder": "…/pr-review-checklist", "message": "lint script"}
→ Preview only: nothing was published. pr-review-checklist would become v3 in the shared
  catalog (changes from v2: "SKILL.md", "scripts/lint.sh").
  Files it would send (3): "SKILL.md", "checklist.md", "scripts/lint.sh"
  Files it skips (0): none
  Review: includes something that can run (scripts/lint.sh). Show the person these lists, …
  Only after they say yes: publish_skill_to_catalog with folder "…", confirm "lQwMW_XZ…",
  name "pr-review-checklist", version 3, files 3 and flags ["runnable_file"], all exactly
  as given here.

Step 2, with those values:
→ Published pr-review-checklist v3 to the shared catalog (fingerprint checked). Teammates
  can find it now; installed copies pick it up at their next update.
```

*A real run of the code on main, as the Assistant calls it, on the 64-skill test catalog.*

### install_shared_skill

Installs a skill from the catalog onto this machine: writes its files into the skills folder, checks them against the fingerprint, and records the version. A version that could run something new is held for the person's yes instead.

```text
Assistant's tool
  install_shared_skill {"name": "pr-review-checklist", "version": 2}

CLI
  skills-catalog install pr-review-checklist --version 2
  (also --target user|project, --project, and --policy auto|notify|pin, the CLI's only)

HTTP
  none: the web page never gets a machine operation
```

| Input | Type | Default | Limit | Required |
|---|---|---|---|---|
| name | text | — | 64 characters: lowercase letters, digits, single hyphens | yes |
| version | whole number | the latest | from 1 | no |
| target | user or project | user (your own skills folder) | — | no |
| policy (CLI only) | auto, notify or pin | the default (auto unless changed) | — | no |

#### Output

Text only today. It reports one of: installed (the version, the folder, the update setting); already installed and unchanged; or held and NOT installed (why, and the values accept_held_update takes: name, target, version, confirm, flags).

*Differs from [the design](contract.md):* the design returns data: installed {path, version, fingerprint, …} | unchanged {version} | held {reason, target, version, risk_flags, confirm}.

#### Errors

- **not_found**: no such skill or version in the catalog
- **exists_untracked**: the folder is there and wasn't installed from the catalog; **name_in_use**: another skill or a command has that name
- **target_symlink**, **target_not_private**, **target_unavailable**, **target_changed**: the skills folder is a link, others can change it, it can't be made, or it changed mid-write
- **fingerprint_mismatch**: the catalog's files don't match their fingerprint
- **lock_busy**: another run is changing the installed skills; **invalid_local_file**: lock.json or config.json can't be used

#### Example

```text
install_shared_skill {"name": "pr-review-checklist", "version": 2}
→ Installed pr-review-checklist v2 to "…/.claude/skills/pr-review-checklist" (fingerprint
  checked). Updates: automatic (the default).
  You can use it in this session as /pr-review-checklist. …

install_shared_skill {"name": "pr-review-checklist", "policy": "pin"}
→ invalid_request: policy isn't a field this tool takes, so nothing was done. Correct the
  call and try again.
```

*A real run of the code on main, as the Assistant calls it, on the 64-skill test catalog.*

### update_installed_skills

Brings installed skills up to date, following each one's update setting. An update that could run something new, or one for a skill set to "tell me first" or pinned, is held for the person's yes.

```text
Assistant's tool
  update_installed_skills {}
  update_installed_skills {"names": ["pr-review-checklist"], "dry_run": true}

CLI
  skills-catalog update        (or update <name>…; --dry-run; --latest)

HTTP
  none: the web page never gets a machine operation
```

| Input | Type | Default | Limit | Required |
|---|---|---|---|---|
| names | list of text | every installed skill | 100 names, 64 characters each | no |
| dry_run | yes or no | no | — | no |
| latest (CLI only; accepted, does nothing yet) | yes or no | no | — | no |

#### Output

Text only today: "Checked N installed skill(s)", then a line per skill: updated (from → to, the files changed), would update (a dry run), held (why, and the values accept_held_update takes), pinned and staying, or refused (why); then how many were already up to date.

*Differs from [the design](contract.md):* the design returns data per skill (updated | unchanged | held {reason, …, confirm} | refused {version, error}), and its latest skips a new version's few-days wait, which isn't built.

#### Errors

- **not_installed**: a name given isn't installed here
- **lock_busy**; **invalid_local_file**
- A skill that can't be updated is a refused line in the answer, not an error.

#### Example

```text
update_installed_skills {}
→ Checked 1 installed skill(s) against the shared catalog.
  - Waiting for the person: pr-review-checklist v2 -> v3 was NOT installed, because it
    adds or changes scripts/lint.sh, which can run on this machine.
  Tell the person each reason in plain words and ask whether to take it. Do not take it
  yourself. Only if they agree: accept_held_update with name "pr-review-checklist",
  target "user", version 3, confirm "eyJuYW1l…" and flags ["runnable_file"], all exactly
  as given here. Otherwise pr-review-checklist stays on v2.
```

*A real run of the code on main, as the Assistant calls it, on the 64-skill test catalog.*

### accept_held_update

Takes one held update, or a held first install, once the person has heard why it was held and said yes. It needs the held answer's values exactly, so the person's permission prompt shows what they agree to.

```text
Assistant's tool
  accept_held_update {"name": "pr-review-checklist", "target": "user", "version": 3,
                      "confirm": "eyJuYW1l…", "flags": ["runnable_file"]}

CLI (a person only: it shows the reasons and asks "Take it? (y/N)")
  skills-catalog update pr-review-checklist --accept      (--target project for a
                                                           held install there)
  With no terminal: nothing is done, exit 3, and it prints the command for the person.

HTTP
  none: the web page never gets a machine operation
```

| Input | Type | Default | Limit | Required |
|---|---|---|---|---|
| name | text | — | 64 characters: lowercase letters, digits, single hyphens | yes |
| target | user or project | — | — | yes |
| version | whole number | — | from 1 | yes |
| confirm | text | — | 2,000 characters | yes |
| flags | list of text | — ([] when none) | 20, 40 characters each | yes |

#### Output

Text only today: "Took the held update: {name} v{from} -> v{to}, installed to {folder}", or, for a held first install, "Installed {name} v{n} to {folder} after the person agreed".

#### Errors

- **conflict**: the hold changed since the person was told (another version, other flags, another target), so nothing was installed
- **invalid_request**: a confirm that isn't one a held answer gives
- install's: **target_symlink**, **target_not_private**, **fingerprint_mismatch**, **lock_busy** …; on the CLI, **not_installed** when {name} isn't installed and nothing is held for it

#### Example

```text
accept_held_update {"name": "pr-review-checklist", "target": "user", "version": 3,
                    "confirm": "eyJuYW1l…", "flags": []}
→ conflict: the update held for pr-review-checklist changed since the person was told
  about it, so nothing was installed. Run update_installed_skills again and tell them
  the new reasons.

The same, with "flags": ["runnable_file"]:
→ Took the held update: pr-review-checklist v2 -> v3, installed to
  "…/.claude/skills/pr-review-checklist" (fingerprint checked).
```

*A real run of the code on main, as the Assistant calls it, on the 64-skill test catalog.*

### list_installed_skills

Lists the skills installed on this machine from the catalog: each one's version, whether it's the latest, and its update setting.

```text
Assistant's tool
  list_installed_skills {}

CLI
  skills-catalog list

HTTP
  none: the web page never gets a machine operation
```

**Inputs:** none.

#### Output

Text only today: a count, then a line per skill with its version, "(the latest)" or "(v{n} is available)", and its update setting, "(the default)" or "(set for this skill)".

*Differs from [the design](contract.md):* the design returns data per skill (version, latest, policy, state: same | behind) and kept[], the copies kept aside when a replace failed; the code doesn't list kept copies.

#### Errors

- **invalid_local_file**: lock.json or config.json can't be used

#### Example

```text
list_installed_skills {}
→ Installed from the shared catalog: 1 skill(s).
  - pr-review-checklist v2 (the latest); updates: automatic (the default)
```

*A real run of the code on main, as the Assistant calls it, on the 64-skill test catalog.*

### set_skill_update_policy

Sets how installed skills update: auto (on their own; a change that could run something new still waits), notify (tell the person first) or pin (stay on this version). With a name, for that skill only; without, the default for all.

```text
Assistant's tool
  set_skill_update_policy {"policy": "notify", "name": "pr-review-checklist"}

CLI
  skills-catalog policy notify pr-review-checklist      (no name: the default for all)

HTTP
  none: the web page never gets a machine operation
```

| Input | Type | Default | Limit | Required |
|---|---|---|---|---|
| policy | auto, notify or pin | — | — | yes |
| name | text | none: the default for every skill | 64 characters: lowercase letters, digits, single hyphens | no |

#### Output

Text only today: "Updates for {name}: {setting}." or "The default for updates is now {setting}; skills with their own setting keep it."

*Differs from [the design](contract.md):* the design returns the policy now in effect as data.

#### Errors

- **not_installed**: the name isn't installed here (never not_found: the catalog may well have it)
- **lock_busy**; **invalid_local_file**

#### Example

```text
set_skill_update_policy {"policy": "notify", "name": "pr-review-checklist"}
→ Updates for pr-review-checklist: tell me first.

set_skill_update_policy {"policy": "pin", "name": "unit-test-writer"}
→ not_installed: unit-test-writer isn't installed on this machine, so nothing was
  changed. To see what is: list_installed_skills; to add it: install_shared_skill.
```

*A real run of the code on main, as the Assistant calls it, on the 64-skill test catalog.*

## CLI only, and planned

### CLI only, and planned: setup, teardown, serve, stats, mcp

Commands a person runs. None is an Assistant's tool today, and none has an HTTP form.

| Command | Status | What it does | Takes |
|---|---|---|---|
| skills-catalog setup | ON A BRANCH | Connects the Assistant to the catalog (its tool server entry, a session-start notice of held updates, the tools it may use without asking); asks its questions at a terminal | --yes, --config &lt;file>, --dry-run, --print-mcp-entry |
| skills-catalog teardown | ON A BRANCH | Removes exactly what setup added; keeps the catalog, the installed skills and their records | nothing |
| skills-catalog serve | PLANNED | The local web page and its HTTP API, on 127.0.0.1, for a local catalog only; reads and dry runs unless started with --publish | --port, --publish |
| skills-catalog stats | BUILT | This machine's usage summary: held updates, looks, answers; nothing leaves the machine | nothing |
| skills-catalog mcp | BUILT | Starts the Assistant's tools (the MCP server, over stdio) | nothing |

Also planned, for later: login and logout (a hosted catalog only) and clear-kept (delete copies kept aside).

## Reference: every operation, from its definition

What the code takes and gives for each operation, written from its definition, so it is always current. The examples above show them in use.

<!-- The reference below is written by `npm run api-doc` in core/, from the operations' definitions. Don't edit it by hand. -->

### `search_shared_skills`

Served by local and hosted catalogs. Called through the Assistant's tool (`mcp`), the CLI (`cli`), HTTP (`web`). It changes nothing (`reads`).

**Input**

- `query`: text, at most 500 characters (optional)
- `filters`: an object with (optional)
  - `tags`: a list of at most 10, each text, at most 32 characters (optional)
  - `publisher`: text, at most 200 characters (optional)
  - `updated_since`: text, at most 40 characters (optional)
- `limit`: a whole number from 1 to 50 (optional)
- `cursor`: text, at most 200 characters (optional)

**Output**

- an object with
  - `results`: a list, each an object with
    - `name`: text
    - `quality`: an object with (not always there)
      - `flags`: a list, each an object with
        - `kind`: one of `runnable_file`, `runs_at_load`, `command_instruction`, `capability_frontmatter`, `instructions_changed`, `non_markdown`, `new_publisher`, `prompt_injection`, `context_cost`
        - `path`: text (not always there)
        - `line`: a whole number (not always there)
        - `field`: text (not always there)
        - `from`: any value (not always there)
        - `to`: any value (not always there)
        - `detail`: text
    - `description`: text
    - `latest_version`: a whole number
    - `tags`: a list, each text
    - `publisher`: text
    - `matched_words`: a list, each text
  - `match`: one of `all`, `partial`, `none`
  - `ranking`: one of `none`, `lexical`
  - `next_cursor`: text (not always there)
  - `total_matches`: a whole number
  - `catalog_size`: a whole number

**Errors:** only those every call can return: `invalid_request`, `invalid_developer_setting`, `internal_error`, `forbidden`

### `read_shared_skill`

Served by local and hosted catalogs. Called through the Assistant's tool (`mcp`), the CLI (`cli`), HTTP (`web`). It changes nothing (`reads`).

**Input**

- `name`: text, at most 200 characters (optional)
- `names`: a list of at most 20, each text, at most 200 characters (optional)
- `version`: a whole number, at least 1 (optional)
- `include`: one of `manifest`, `files`, `contents` (optional)
- `paths`: a list of at most 20, each text, at most 4,096 characters (optional)

**Output**

- an object with
  - `skills`: a list, each one of these
    - an object with
      - `name`: text
      - `version`: a whole number
      - `latest_version`: a whole number
      - `fingerprint`: text
      - `published_at`: text
      - `publisher`: text
      - `manifest`: an object with
        - `frontmatter`: an object
        - `body`: text (not always there)
        - `body_omitted`: true or false (not always there)
      - `reviews`: a list, each an object with
        - `reviewer`: text
        - `reviewer_version`: text
        - `fingerprint`: text
        - `at`: text
        - `measurements`: an object, each value a number
        - `flags`: a list, each an object with
          - `kind`: one of `runnable_file`, `runs_at_load`, `command_instruction`, `capability_frontmatter`, `instructions_changed`, `non_markdown`, `new_publisher`, `prompt_injection`, `context_cost`
          - `path`: text (not always there)
          - `line`: a whole number (not always there)
          - `field`: text (not always there)
          - `from`: any value (not always there)
          - `to`: any value (not always there)
          - `detail`: text
        - `findings`: a list, each an object with
          - `kind`: one of `runnable_file`, `runs_at_load`, `command_instruction`, `capability_frontmatter`, `instructions_changed`, `non_markdown`, `new_publisher`, `prompt_injection`, `context_cost`
          - `path`: text (not always there)
          - `line`: a whole number (not always there)
          - `evidence`: text
          - `why`: text
        - `notes`: text (not always there)
        - `omitted`: a list, each an object with (not always there)
          - `kind`: one of `runnable_file`, `runs_at_load`, `command_instruction`, `capability_frontmatter`, `instructions_changed`, `non_markdown`, `new_publisher`, `prompt_injection`, `context_cost`
          - `count`: a whole number
      - `reviews_omitted`: true or false (not always there)
      - `files`: a list, each an object with (not always there)
        - `path`: text
        - `mode`: one of `0644`, `0755`
        - `size`: a whole number
        - `sha256`: text
        - `type`: one of `text`, `binary`
        - `content`: text (not always there)
        - `content_omitted`: true or false (not always there)
    - an object with
      - `name`: text
      - `error`: an object with
        - `code`: an error code (every code: [the error list](contract.md#9-error-codes))
  - `inline_budget`: an object with
    - `limit`: a whole number
    - `used`: a whole number
    - `omitted`: a whole number

**Errors:** `invalid_name`, `not_found`; and, like every call, `invalid_request`, `invalid_developer_setting`, `internal_error`, `forbidden`

### `list_shared_skill_versions`

Served by local and hosted catalogs. Called through the Assistant's tool (`mcp`), the CLI (`cli`), HTTP (`web`). It changes nothing (`reads`).

**Input**

- `name`: text, at most 200 characters (required)
- `cursor`: text, at most 200 characters (optional)

**Output**

- an object with
  - `name`: text
  - `latest`: a whole number
  - `versions`: a list, each an object with
    - `version`: a whole number
    - `fingerprint`: text
    - `published_at`: text
    - `publisher`: text
    - `message`: text
    - `flags`: a list, each an object with
      - `kind`: one of `runnable_file`, `runs_at_load`, `command_instruction`, `capability_frontmatter`, `instructions_changed`, `non_markdown`, `new_publisher`, `prompt_injection`, `context_cost`
      - `path`: text (not always there)
      - `line`: a whole number (not always there)
      - `field`: text (not always there)
      - `from`: any value (not always there)
      - `to`: any value (not always there)
      - `detail`: text
  - `next_cursor`: text (not always there)

**Errors:** `invalid_name`, `not_found`; and, like every call, `invalid_request`, `invalid_developer_setting`, `internal_error`, `forbidden`

### `diff_shared_skill_versions`

Served by local and hosted catalogs. Called through the Assistant's tool (`mcp`), the CLI (`cli`), HTTP (`web`). It changes nothing (`reads`).

**Input**

- `name`: text, at most 200 characters (required)
- `from`: a whole number, at least 1 (required)
- `to`: a whole number, at least 1 (required)

**Output**

- an object with
  - `name`: text
  - `from`: a whole number
  - `to`: a whole number
  - `files`: a list, each an object with
    - `path`: text
    - `status`: one of `added`, `changed`, `removed`
    - `flags`: an object with
      - `binary`: true or false
      - `executable`: true or false
      - `script`: true or false
    - `unified`: text (not always there)
  - `frontmatter_changes`: a list, each an object with
    - `field`: text
    - `from`: any value
    - `to`: any value
  - `publisher_changed`: true or false
  - `risk_flags`: a list, each an object with
    - `kind`: one of `runnable_file`, `runs_at_load`, `command_instruction`, `capability_frontmatter`, `instructions_changed`, `non_markdown`, `new_publisher`, `prompt_injection`, `context_cost`
    - `path`: text (not always there)
    - `line`: a whole number (not always there)
    - `field`: text (not always there)
    - `from`: any value (not always there)
    - `to`: any value (not always there)
    - `detail`: text

**Errors:** `invalid_name`, `not_found`; and, like every call, `invalid_request`, `invalid_developer_setting`, `internal_error`, `forbidden`

### `publish_version`

Served by local and hosted catalogs. Called through HTTP (`web`). It changes the catalog (`writes_catalog`).

**Input**

- `name`: text, at most 200 characters (required)
- `files`: a list of at most 10,000, each with (required)
  - `path`: text, at most 4,096 characters (required)
  - `mode`: text, at most 8 characters (required)
  - `content_base64`: text (required)
- `message`: text, at most 1,000 characters (optional)
- `expected_latest`: a whole number, at least 0 (optional)
- `dry_run`: true or false (optional)
- `allow_suspected_secrets`: true or false (optional; CLI only: a person's own choice, never taken from the Assistant's tool or HTTP)

**Hosted, instead** (each form refuses the other)

- `files`: a list of at most 10,000, each with (required)
  - `path`: text, at most 4,096 characters (required)
  - `mode`: text, at most 8 characters (required)
  - `sha256`: text (required)

**Output**

- an object with
  - `name`: text
  - `version`: a whole number
  - `fingerprint`: text
  - `created`: true or false
  - `dry_run`: true or false
  - `publisher`: text
  - `diff_from_latest`: one of these
    - an object with
      - `files`: a list, each an object with
        - `path`: text
        - `status`: one of `added`, `changed`, `removed`
        - `flags`: an object with
          - `binary`: true or false
          - `executable`: true or false
          - `script`: true or false
        - `unified`: text (not always there)
      - `frontmatter_changes`: a list, each an object with
        - `field`: text
        - `from`: any value
        - `to`: any value
      - `publisher_changed`: true or false
      - `risk_flags`: a list, each an object with
        - `kind`: one of `runnable_file`, `runs_at_load`, `command_instruction`, `capability_frontmatter`, `instructions_changed`, `non_markdown`, `new_publisher`, `prompt_injection`, `context_cost`
        - `path`: text (not always there)
        - `line`: a whole number (not always there)
        - `field`: text (not always there)
        - `from`: any value (not always there)
        - `to`: any value (not always there)
        - `detail`: text
    - `null`
  - `risk_flags`: a list, each an object with
    - `kind`: one of `runnable_file`, `runs_at_load`, `command_instruction`, `capability_frontmatter`, `instructions_changed`, `non_markdown`, `new_publisher`, `prompt_injection`, `context_cost`
    - `path`: text (not always there)
    - `line`: a whole number (not always there)
    - `field`: text (not always there)
    - `from`: any value (not always there)
    - `to`: any value (not always there)
    - `detail`: text

**Errors:** `unauthenticated`, `not_owner`, `conflict`, `invalid_manifest`, `invalid_name`, `invalid_path`, `too_large`, `secret_suspected`; and, like every call, `invalid_request`, `invalid_developer_setting`, `internal_error`, `forbidden`

### `request_upload_links`

Served by hosted catalogs only. Called through HTTP (`web`). It changes the catalog (`writes_catalog`).

**Input**

- `name`: text, at most 200 characters (required)
- `files`: a list of at most 100, each with (required)
  - `sha256`: text (required)
  - `size`: a whole number, at least 0 (required)

**Output**

- an object with
  - `name`: text
  - `files`: a list, each one of these
    - an object with
      - `kind`: one of `upload`
      - `sha256`: text
      - `url`: text
      - `headers`: an object, each value text
    - an object with
      - `kind`: one of `stored`
      - `sha256`: text
    - an object with
      - `kind`: one of `removing`
      - `sha256`: text
      - `retry_after`: text

**Errors:** `unauthenticated`, `not_owner`, `invalid_name`, `too_large`; and, like every call, `invalid_request`, `invalid_developer_setting`, `internal_error`, `forbidden`

### `sign_in_with_github`

Served by hosted catalogs only. Called through HTTP (`web`). It changes the catalog (`writes_catalog`).

**Input**

- `github_token`: text, at most 255 characters (required)
- `scope`: one of `read`, `publish` (required)

**Output**

- an object with
  - `token`: text
  - `id`: text
  - `scope`: one of `read`, `publish`
  - `expires_at`: text

**Errors:** `unauthenticated`; and, like every call, `invalid_request`, `invalid_developer_setting`, `internal_error`, `forbidden`

### `list_tokens`

Served by hosted catalogs only. Called through HTTP (`web`). It changes nothing (`reads`).

**Input**

- nothing

**Output**

- an object with
  - `tokens`: a list, each an object with
    - `id`: text
    - `scope`: one of `read`, `publish`
    - `kind`: one of `session`, `personal`
    - `created_at`: text
    - `expires_at`: text
    - `last_used_at`: text (not always there)
    - `revoked_at`: text (not always there)

**Errors:** `unauthenticated`; and, like every call, `invalid_request`, `invalid_developer_setting`, `internal_error`, `forbidden`

### `revoke_token`

Served by hosted catalogs only. Called through HTTP (`web`). It changes the catalog (`writes_catalog`).

**Input**

- `id`: text (required)

**Output**

- an object with
  - `id`: text

**Errors:** `unauthenticated`, `not_found`; and, like every call, `invalid_request`, `invalid_developer_setting`, `internal_error`, `forbidden`

### `fetch_version`

Served by local and hosted catalogs. Called through HTTP (`web`). It changes nothing (`reads`).

**Input**

- `name`: text, at most 200 characters (optional)
- `version`: a whole number, at least 1 (optional)
- `fingerprint`: text, at most 80 characters (optional)

**Output**

- an object with
  - `name`: text
  - `version`: a whole number
  - `fingerprint`: text
  - `files`: a list, each an object with
    - `path`: text
    - `mode`: one of `0644`, `0755`
    - `content_base64`: text

**Errors:** `invalid_name`, `not_found`; and, like every call, `invalid_request`, `invalid_developer_setting`, `internal_error`, `forbidden`

### `publish_skill_to_catalog`

Served by local and hosted catalogs. Called through the Assistant's tool (`mcp`). It changes the catalog (`writes_catalog`).

**Input**

- `folder`: text, at most 4,096 characters (required)
- `message`: text, at most 1,000 characters (optional)
- `confirm`: text, at most 2,000 characters (optional)
- `name`: text, at most 200 characters (optional)
- `version`: a whole number, at least 1 (optional)
- `files`: a whole number, at least 0 (optional)
- `flags`: a list of at most 20, each one of `runnable_file`, `runs_at_load`, `command_instruction`, `capability_frontmatter`, `instructions_changed`, `non_markdown`, `new_publisher`, `prompt_injection`, `context_cost` (optional)
- `allow_suspected_secrets`: true or false (optional; CLI only: a person's own choice, never taken from the Assistant's tool or HTTP)

**Output**

- text, for the person to read

**Errors:** `conflict`, `unauthenticated`, `not_owner`, `invalid_manifest`, `invalid_name`, `invalid_path`, `too_large`, `secret_suspected`; and, like every call, `invalid_request`, `invalid_developer_setting`, `internal_error`, `forbidden`

### `install_shared_skill`

Served by local and hosted catalogs. Called through the Assistant's tool (`mcp`), the CLI (`cli`). It changes this machine's installed skills (`writes_machine`).

**Input**

- `name`: text, at most 200 characters (required)
- `version`: a whole number, at least 1 (optional)
- `target`: one of `user`, `project` (optional)
- `policy`: one of `auto`, `notify`, `pin` (optional; CLI only: a person's own choice, never taken from the Assistant's tool or HTTP)

**Output**

- text, for the person to read

**Errors:** `not_found`, `invalid_manifest`, `invalid_name`, `invalid_path`, `too_large`, `fingerprint_mismatch`, `exists_untracked`, `name_in_use`, `target_symlink`, `target_changed`, `target_not_private`, `target_unavailable`, `lock_busy`, `invalid_local_file`; and, like every call, `invalid_request`, `invalid_developer_setting`, `internal_error`, `forbidden`

### `update_installed_skills`

Served by local and hosted catalogs. Called through the Assistant's tool (`mcp`), the CLI (`cli`). It changes this machine's installed skills (`writes_machine`).

**Input**

- `names`: a list of at most 100, each text, at most 200 characters (optional)
- `dry_run`: true or false (optional)
- `latest`: true or false (optional; CLI only: a person's own choice, never taken from the Assistant's tool or HTTP)

**Output**

- text, for the person to read

**Errors:** `not_installed`, `not_found`, `lock_busy`, `invalid_local_file`; and, like every call, `invalid_request`, `invalid_developer_setting`, `internal_error`, `forbidden`

### `accept_held_update`

Served by local and hosted catalogs. Called through the Assistant's tool (`mcp`), the CLI (`cli`). It changes this machine's installed skills (`writes_machine`).

**Input**

- `name`: text, at most 200 characters (required)
- `target`: one of `user`, `project` (required)
- `version`: a whole number, at least 1 (required)
- `confirm`: text, at most 2,000 characters (required)
- `flags`: a list of at most 20, each text, at most 40 characters (required)

**Output**

- text, for the person to read

**Errors:** `conflict`, `not_installed`, `not_found`, `invalid_manifest`, `invalid_name`, `invalid_path`, `too_large`, `fingerprint_mismatch`, `exists_untracked`, `name_in_use`, `target_symlink`, `target_changed`, `target_not_private`, `target_unavailable`, `lock_busy`, `invalid_local_file`; and, like every call, `invalid_request`, `invalid_developer_setting`, `internal_error`, `forbidden`

### `list_installed_skills`

Served by local and hosted catalogs. Called through the Assistant's tool (`mcp`), the CLI (`cli`). It changes nothing (`reads`).

**Input**

- nothing

**Output**

- text, for the person to read

**Errors:** `not_found`, `invalid_local_file`; and, like every call, `invalid_request`, `invalid_developer_setting`, `internal_error`, `forbidden`

### `set_skill_update_policy`

Served by local and hosted catalogs. Called through the Assistant's tool (`mcp`), the CLI (`cli`). It changes this machine's installed skills (`writes_machine`).

**Input**

- `policy`: one of `auto`, `notify`, `pin` (required)
- `name`: text, at most 200 characters (optional)

**Output**

- text, for the person to read

**Errors:** `not_installed`, `lock_busy`, `invalid_local_file`; and, like every call, `invalid_request`, `invalid_developer_setting`, `internal_error`, `forbidden`

<!-- End of the written reference. -->
