# Architecture

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

![An installed skill over time: the same as the catalog, behind, updated automatically or shown to you first](pictures/install-loop.svg)

A retrieved skill is still a copy, so it remembers where it came from. The installer's list records name, version, fingerprint and catalog. On an update it compares versions. Text-only changes apply on their own; anything that could change what runs on your machine stops and shows you first.

## How many skills, and what that means for search

| Skills | What works |
|---|---|
| up to ~50–70 | The assistant reads the whole list (a card averages ~113 tokens) |
| ~70 to ~10k | Keyword search narrows first; the assistant picks from a page (a generated 10k catalog: search p95 ≈ 6.5 ms) |
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
