# Architecture: today and planned

What runs on your machine today, what comes next, and the hosted option designed for later. The README's picture shows only the system as it is.

## Today, and next

![Built today: the core catalog and its local store. Next, not built yet: the CLI and setup, the assistant's tools (MCP), the installer and the skills folder](pictures/today.svg)

**Built today, and next.** The core catalog is built and tested. The CLI, the assistant's tools and the installer come next, each on the same contract ([contract.md](contract.md)).

## Later: a hosted catalog (one contract, two homes)

![One contract, two homes: on your machine, the core catalog is built and the installer, CLI and assistant tools are planned; a hosted catalog in your AWS account is designed but not built](pictures/shape.svg)

**One contract, two homes.** Assistants and people reach one catalog through one contract ([contract.md](contract.md)). The core catalog runs on your machine today, and the installer, CLI and assistant tools come next; a hosted catalog in your AWS account is designed, not built. The owner's notes on the PRD asked for exactly this: "build the experience, interface and contracts without coupling ourselves with a specific choice".

## The parts

| Part | What it does | Status |
|---|---|---|
| **Core** | Validates skills (the Agent Skills `SKILL.md` format), assigns versions, computes fingerprints, diffs versions, flags risky changes. Pure logic, no storage of its own | Built |
| **Local catalog** | SQLite for records and keyword search (FTS5), and a folder of files stored by fingerprint. Safe across processes | Built |
| **Replaceable parts** | Storage, file store, search index, events, clock, ids and identity sit behind small interfaces, so a DynamoDB + S3 or a search-service version can drop in, checked by the same tests | Built as interfaces; local versions built |
| **Installer** | Puts a skill into your assistant's skills folder, records where it came from, applies updates by your policy (auto, notify or pin), and stops risky ones | Next |
| **The assistant's tools (MCP) and the CLI** | Generated from the one contract, so they can't drift apart | Next |
| **Guided setup** | One colourful command (an assistant can run it too), auto-updates on by default, `--yes` or a file for unattended setup, `teardown` to undo it | Next |
| **Web UI, hosted catalog, bundles, agent reviewers** | Designed; parked until phase 1 is done | Later |

## A retrieved skill stays the same skill

![A new version is checked first: if it could change what runs, or the reviewer flags it, it waits for you with what changed; otherwise it's applied on its own](pictures/update-gate.svg)

A retrieved skill is still a copy, so it remembers where it came from. The installer's list records name, version, fingerprint and catalog. On an update it compares versions. Text changes to a skill that can't run anything apply on their own. Anything that could change what runs on your machine stops and shows you first, including new instructions in a skill that is allowed to run commands. A first install goes through the same check.

## How many skills, and what that means for search

| Skills | What works |
|---|---|
| up to ~20–30 | The assistant reads the whole list. Claude Code keeps its skill listing to about 1% of the context, and picking the right tool gets worse past 30–50 |
| ~30 to ~10k | Keyword search narrows first; the assistant picks from a page (a generated 10k catalog: search p95 ≈ 6.5 ms) |
| 100k+ | Ranking by meaning plus keywords, with a cutoff so "nothing matches" still happens |

The index is rebuilt from the stored versions, so a new search engine needs no data migration. The owner's List (search with no words, plus filters) and Get (read) are kept; optional words were added.

## Alternatives we weighed

| Alternative | Trade-off |
|---|---|
| AWS from day one | Needs an account, a deploy and sign-in before anything works |
| A hosted MCP server only | Zero install, but it can't write the skill onto your disk |
| A git repository as the catalog | History for free, weak search; kept as an export |
| Claude Code plugin marketplaces as the backend | Native install and per-marketplace auto-update, but no search an agent can call and no per-skill update policy; kept as the export for bundles |
| The Claude API's skills endpoint | Versioned storage for one workspace, with no discovery |

More: [decisions.md](decisions.md) (why each choice), [requirements.md](requirements.md) (each requirement, where it lives, what checks it), [agent-experience.md](agent-experience.md) (measured trials).
