# Architecture

What runs on the Developer's machine, what runs in the team's AWS account, and what is still to come. Both homes are built; the local catalog is the default and the hosted catalog is opt-in.

## On the Developer's machine

![The parts on one machine: the Developer runs the CLI and setup, the Assistant (Claude Code) calls the MCP server, both go through the core to the local catalog, and the installer writes checked skills into the skills folder, holding a risky update for a yes](pictures/map-local.svg)

<sub>The system map shows more than this picture ([open it](https://claude.ai/artifact/Tn6An3wQ9sVg9zD1eyB7aq)): the architecture, a few boxes with what's planned and the contracts that let a backend be swapped, with the ports one level down; the use cases, step by step; the context, who uses it and where each copy runs; a page for each part, with what's inside it; and the decisions, with the options weighed. The same pages are in [map/](map) (self-contained: download and open one). They are built from `docs/map/map.yaml` and `docs/decisions.yaml`, and checked against the code on every `npm run check`: the lines inside a part are read from its imports, and in AWS from the stack's template.</sub>

**Built.** The core, the local catalog, the MCP server (the Assistant's tools), the installer (it holds a risky update until the Developer says yes), the CLI with every catalog command, and the guided setup. All of them use one API ([api.md](api.md)).

## In AWS: the same API, hosted

![The parts in AWS: the hosted catalog in the team's AWS account (the API on Lambda behind CloudFront, with DynamoDB and S3), reached by the same CLI and MCP server once SKILLS_CATALOG names it and the Developer signs in](pictures/map-aws.svg)

**One API, two homes.** The Assistant and the Developer reach a catalog through one API ([api.md](api.md)): the local catalog by default, or the hosted catalog in the team's AWS account when `SKILLS_CATALOG` names its address and the Developer runs `skills-catalog login`. The same tests run against both. The owner's notes on the PRD asked for exactly this: "build the experience, interface and contracts without coupling ourselves with a specific choice".

## The parts

| Part | What it does | Status |
|---|---|---|
| **Core** | Validates skills (the Agent Skills `SKILL.md` format), assigns versions, computes fingerprints, diffs versions, flags risky changes, reviews each publish with the rules reviewer. Pure logic, no storage of its own | Built |
| **Local catalog** | SQLite for records and keyword search (FTS5), and a folder of files stored by fingerprint. One machine; safe across processes | Built (the default) |
| **Hosted catalog** | The same API over HTTP on Lambda, DynamoDB + S3, a search file in S3, sign-in with GitHub or a personal token | Built and deployed; opt-in |
| **Replaceable parts** | Storage, file store, search index, events, clock, ids and identity sit behind small interfaces; the local and hosted versions pass the same tests | Built |
| **Installer** | Puts a skill into Claude Code's skills folder, records where it came from, applies updates by the Developer's policy (auto, notify or pin), and holds a risky one for the Developer's yes | Built |
| **MCP server** (the Assistant's tools) | The catalog's tools for the Assistant, generated from the API, each reply with a part laid out for the Developer | Built |
| **CLI** | `search`, `read`, `versions`, `diff`, `install`, `list`, `update`, `policy`, `publish`, `stats`, `review`, `setup`, `teardown`, `mcp`, `serve`, `login`, `logout` | Built |
| **Guided setup** | `skills-catalog setup` asks about auto-updates first (default yes), then connects Claude Code; `--yes` or `--config <file>` for unattended setup; `teardown` puts the Developer's files back as they were | Built |
| **Rules reviewer** | Reviews every publish: a script or executable, a command run as the skill loads, granted tools, text that tries to steer the Assistant, a SKILL.md over its length budget, a new publisher. Findings show in search, read and versions; a clean skill shows nothing | Built; agent reviewers later |
| **Web page** | Browsing, comparing versions, publishing | Not built: `serve` gives the API on 127.0.0.1, without a page yet |
| **Other assistants, bundles, agent reviewers** | pi, then Copilot, Codex, Cursor and Gemini CLI; bundles of skills | Later |

## Each part and its technology (chosen by the owner)

What each part holds, what runs it on the Developer's machine, and what runs it in the hosted catalog.

| Part | What it holds or does | On the Developer's machine | Hosted catalog (built, opt-in) |
|---|---|---|---|
| **The API** | Every operation, defined once; the MCP server's tools, the CLI, the HTTP routes and a published schema come from it ([api.md](api.md)) | The MCP server and the CLI; `serve` on 127.0.0.1 | The same operations over HTTP, `POST /api/v1/<operation>` |
| **Skills: versions + files** | Each skill's versions, owners and files, stored by fingerprint | SQLite + a folder of files | DynamoDB + S3 |
| **Search** | Finding skills by words, tags, publisher or date | SQLite full-text search | A search file in S3, ranked in the function; OpenSearch Serverless to be re-assessed in phase 3 |
| **Compute** | What runs the catalog and its API | The Developer's machine | Lambda + HTTP API behind CloudFront and a firewall; files go up and down by short-lived S3 links |
| **Events** | Telling search that a version was published | An outbox saved with each version | A DynamoDB stream to a queue |
| **Sign-in** | Who is asking; owners publish, everyone signed in reads | "Acting as" a named Developer, a local sign-in for demo purposes | Sign in with GitHub; personal tokens for the Assistant |
| **The web page** | Browsing, comparing versions, publishing | Not built (`serve` gives the API only) | CloudFront + S3 in place; the page not built |
| **Where it runs** | The whole hosted shape | — | AWS serverless: nothing to pay or patch while idle |
| **Language and runtime** | Everything above | TypeScript on Node 24.15+, Node's own SQLite, one YAML parser | The same code |
| **The Assistant's server** | The tools the Assistant calls | A small hand-written MCP server (no SDK) | — (always on the Developer's machine) |
| **Install and update** | Putting skills in Claude Code's skills folder, and holding a risky update for a yes | The installer checks the files and works out the risk itself; one lock file; one writer at a time | — (always on the Developer's machine) |

## A retrieved skill stays the same skill

A retrieved skill is a copy, so the installer remembers where it came from:

| name | version | fingerprint | catalog |
|---|---|---|---|
| release-note-draft | 2 | `sha256:91d7f2a5…` (one hash of every file, its bytes and whether it can run) | the local catalog |

- **Same files, same fingerprint.** The installer checks the fingerprint of what it wrote against the catalog's, so "complete and unchanged" is something anyone can check.
- **A text-only update to a skill that can't run anything applies on its own.**
- **Anything that could change what runs on the Developer's machine waits for a yes**, with what changed: a new script or runnable file, an executable bit, new tool permissions or hooks, commands that run when the skill loads, a new publisher, or a rules-reviewer finding. A first install goes through the same check.
- **A copy the Developer edited by hand is kept aside, named, when an update replaces it.**

## How many skills, and what that means for search

| Skills | What works |
|---|---|
| up to ~20–30 | The Assistant reads the whole list. Claude Code keeps its skill listing to about 1% of the context, and picking the right tool gets worse past 30–50 |
| ~30 to ~10k | Keyword search narrows first; the Assistant picks from a page (a generated 10k catalog: search p95 ≈ 6.5 ms) |
| 100k+ | Ranking by meaning plus keywords, with a cutoff so "nothing matches" still happens |

Search is keyword search, with a small list of synonyms in the configuration; a paraphrase relies on the Assistant rewording. The index is rebuilt from the stored versions, so a new search engine needs no data migration. The owner's List (search with no words, plus filters) and Get (read) are kept; optional words were added.

## Known limits

- A local catalog (`file://`) is for one machine; a team shares the hosted catalog.
- The hosted search downloads its whole search file on each warm query; the budgets are met on the emulator.
- The session-start hook gives up its sync after 2 seconds.
- Only Claude Code is supported today: pi is phase 2; the other assistants are phase 3, after the owner's approval.

## Alternatives we weighed

| Alternative | Trade-off |
|---|---|
| AWS from day one | Needs an account, a deploy and sign-in before anything works |
| A hosted MCP server only | Zero install, but it can't write the skill onto the Developer's disk |
| A git repository as the catalog | History for free, weak search; kept as an export |
| Claude Code plugin marketplaces as the backend | Native install and per-marketplace auto-update, but no search the Assistant can call and no per-skill update policy; kept as the export for bundles |
| The Claude API's skills endpoint | Versioned storage for one workspace, with no discovery |

More: [the decisions](https://claude.ai/artifact/Tn6An3wQ9sVg9zD1eyB7aq) (the system map's Decisions tab: why each choice, over what), [requirements.md](requirements.md) (each requirement, its status and the checks that hold it), [agent-experience.md](agent-experience.md) (measured trials).
