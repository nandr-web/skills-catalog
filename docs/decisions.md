# Decisions

The decision log, in the PRD's format: what was decided, why, when and by whom, and whether it is built. D1–D3 are the PRD's own; B1 onward were decided while building it. "The owner" is the person this was built for; "the team" is the architects, QA and agent-experience work behind the design. Details live in [architecture.md](architecture.md) and [contract.md](contract.md); the owner's words on the PRD are in [prd/notes.md](prd/notes.md). This page is built from [decisions.yaml](decisions.yaml); [the system map](map/decisions.html) shows each decision beside the parts it's about, with the options weighed where there were several.

**At a glance:** 41 decisions: 3 from the PRD, 21 by the owner, 11 by the team, 6 defaults awaiting the owner.

| Decided by | Decisions | Not built yet |
|---|---|---|
| The PRD | 3 | 0 |
| The owner | 21 | 4 |
| The team | 11 | 0 |
| Defaults awaiting the owner | 6 | 0 |

## From the PRD

| # | Decision | Rationale | Date | Decided by | How the build honours it | Built |
|---|---|---|---|---|---|---|
| D1 | Access is through an AI assistant | Low-effort reuse is the point; the assistant is the access path | 2026-07-23 | The PRD | Claude Code reaches the catalog through the MCP server's tools; the CLI does the same for the Developer at a terminal | Yes |
| D2 | Versioning is in scope for the MVP | Consistency over time, see changes, don't overwrite silently | 2026-07-23 | The PRD | Every publish is a numbered version with a fingerprint; history, diffs and an earlier version on request | Yes |
| D3 | Authentication and de-duplication are out of scope | Not needed to prove low-effort, consistent reuse | 2026-07-23 | The PRD | The local catalog needs no sign-in: it takes the computer's login as the Developer's name, labelled a local sign-in for demo purposes. De-duplication is not built. Extended with the owner's yes (B6): the opt-in hosted catalog signs people in, because a catalog on the internet must know who changes a skill | Yes |

## Decided by the owner

| # | Decision | Rationale | Date | Decided by | Built |
|---|---|---|---|---|---|
| B1 | **What ships first:** everything runs locally by default; AWS is opt-in, off by default. Over: building the web UI and AWS hosting first | The PRD's time box and "run on a reviewer's machine from a short README": no account, no server | 2026-09-28 | The owner | Yes |
| B2 | **Guided setup:** one command (`skills-catalog setup`) that the Assistant can also run; it asks about auto-updates first, default yes; `--yes` or `--config <file>` for unattended setup; `teardown` undoes it. Over: configuring by hand | The owner's notes: a welcome, seamless setup, with no need to go into a file | 2026-09-28 | The owner | Yes |
| B3 | **Risky updates wait for a yes:** auto-updates are on by default; an update waits for the Developer's yes only when it could change what runs on the machine or the reviewer flagged it, on every surface. While the Assistant runs commands without asking, a newly added command in a skill's text is flagged too. Over: applying every update silently; holding every update | A skill is instructions the Assistant follows, so an update can change what runs; asking about every update trains people to say yes | 2026-09-28, narrowed 2026-09-29 | The owner | Yes |
| B4 | **A pinned skill stays pinned:** installing a newer version over a pinned or "tell me first" (notify) skill waits for the Developer's yes, as an update does | The Developer's own setting for that skill decides, not the Assistant | 2026-09-29 | The owner | Yes |
| B5 | **Reviews:** a rules reviewer reviews every publish; pluggable agent reviewers that measure quality come later; a clean skill shows nothing. Over: reviews only later | The owner asked for reviewer-based measurements, prompt-injection risk included; approving with no comments is a normal result | 2026-09-28 | The owner | The rules reviewer, yes; agent reviewers, later |
| B6 | **Who may publish:** only a skill's owners (its first publisher, plus maintainers later). Hosted: everyone signs in, even to read. Locally, a simplified sign-in: the Developer acts as a named developer, labelled for demo purposes. Over: anyone signed in publishes | Signing in isn't permission to change someone else's skill; locally, sign-in must not block publishing | 2026-09-28, simplified locally 2026-10-02 | The owner | Yes |
| B7 | **Search to start with:** keyword search built in, upgraded when measurement says so (recall on a golden query set, speed). Over: a search service by meaning from day one | Nothing to run or pay for; the index is rebuilt from stored versions, so switching later needs no migration | 2026-09-28 | The owner | Yes |
| B8 | **Where an installed skill's origin is kept:** the installer's own list (name, version, fingerprint, which catalog), by install location. Over: metadata inside SKILL.md; a small file beside it | The skill's files stay exactly as published, so "complete and unchanged" stays checkable | 2026-09-28 | The owner | Yes |
| B9 | **Local edits to an installed skill:** an update replaces a copy the Developer changed, as most installed software does; local edits not shared upstream may be lost. Over: warn, back up, or skip changed skills | The owner's call, like most installed software | 2026-09-28 | The owner | Yes |
| B10 | **Stay flexible:** one API (List with filters, Get, and the rest), with storage and search behind replaceable parts. Over: building straight on one backend | The owner's notes: "build the experience, interface and contracts without coupling ourselves with a specific choice" | 2026-09-28 | The owner | Yes |
| B11 | **One definition, every face:** each operation is defined once; the MCP server's tools, the CLI, the HTTP routes, setup's allow list and a published schema come from it. "The API" names the list of operations; "catalog" names the shared skills and the service that keeps them. Over: separate APIs per face | Assistants can do everything a person can, and the faces can't drift apart; two names that sounded alike confused readers | 2026-09-29 | The owner | Yes |
| B12 | **Architecture:** a local-first core with replaceable storage, search and identity; the same tests run against every backend (moved from the team to the owner). Over: AWS from day one; a git repository as the catalog; plugin marketplaces as the backend; a hosted MCP server only | Runs anywhere in minutes, and keeps every one of those as a later option or an export | 2026-09-29 | The owner | Yes |
| B13 | **Hosted technologies:** Lambda + HTTP API with files by short-lived S3 links; DynamoDB + S3; a search file in S3 (OpenSearch Serverless to be re-assessed in phase 3); sign-in with GitHub; events by a DynamoDB stream to a queue; the web page on CloudFront + S3; TypeScript on Node; a hand-written MCP server; install and update always on the Developer's machine. The full table is in [architecture.md](architecture.md) | Serverless: nothing to pay or patch while idle; each element picked from an options explainer | 2026-09-29 | The owner | Yes, except the web page |
| B14 | **The AWS setup:** written in AWS CDK (TypeScript), by agents; deployed only after a second go from the owner | One language for the product and its infrastructure, and tests that run offline | 2026-09-29, deployed 2026-09-30 | The owner | Yes |
| B15 | **A wait on shared catalogs:** on a shared or hosted catalog, a new version waits (about 3 days) before auto-update applies it, with a way to ask for the latest | Auditors and security checkers who follow the latest get time to look first | 2026-09-29 | The owner | Not built yet |
| B16 | **Other assistants:** pi in phase 2; Copilot, Codex, Cursor and Gemini CLI in phase 3, not started without the owner's approval; risky updates wait for a yes on every assistant | Claude Code first; the MCP server is not tied to it, but the installer writes Claude Code's skills folder | 2026-09-29 | The owner | Not built yet |
| B17 | **The web page:** a local page in plain browser modules, from five approved mock-ups, with a view of what changed between versions; phase 2. Over: React + Vite | The owner's notes: viewing and updating skills, and a delta view, as a secondary priority | 2026-09-29 | The owner | Not built yet (`serve` gives the API only) |
| B18 | **Bundles of skills**, with community feedback such as votes; later | The owner's notes; after the core loop | 2026-09-28 | The owner | Not built yet |
| B19 | **What the Developer reads:** the CLI speaks to a person; each MCP reply carries a part laid out for the Developer (tables, short lines, a box for what needs a yes); things are named by what the Developer will see happen | Assistants and people read differently; the person's layer follows the owner's visual-first tenets | 2026-09-30 | The owner | Yes |
| B20 | **Testing:** QA first; reproducible runs that clean up after themselves; the Assistant's experience tested first; our own test runner improved rather than a framework adopted | The owner's notes on the PRD: "a QA-first mentality" | 2026-09-28, runner 2026-09-30 | The owner | Yes; agent-level runs are not scheduled, and 17 of their checks are still manual |
| B21 | **The time box:** the PRD's ~4 hours is a soft target, not a hard limit | The owner's answer when asked | 2026-09-29 | The owner | — |

## Decided by the team

| # | Decision | Rationale | Date | Decided by | Built |
|---|---|---|---|---|---|
| B22 | **Skill format:** the PRD's manifest is `SKILL.md`'s front matter in the Agent Skills format; tags in `metadata.tags`. Over: a manifest format of our own | A retrieved skill is drop-in for assistants that read the standard | 2026-09-28 | The team | Yes |
| B23 | **What a version is:** a number (the handle) plus a fingerprint of every file and whether it can run (the identity). Publishing files identical to the latest changes nothing; restoring an old version makes a new one. Over: semantic versions | Makes "complete and unchanged" and "nothing silently overwritten" checkable by anyone | 2026-09-28 | The team | Yes |
| B24 | **Retrieve means install:** written into Claude Code's skills folder and tracked. Over: content returned into the conversation only (still there as `read`) | "Ready to use", and what makes updates and drift checks possible | 2026-09-28 | The team | Yes |
| B25 | **Tool names:** no tool is called "get": `read_shared_skill` and `install_shared_skill`. Over: `get_skill` | In trials, people saying "get me X" meant install; renaming took success from 0/2 to 2/3 | 2026-09-28 | The team | Yes |
| B26 | **How the Assistant finds the catalog:** the MCP server's own instructions. Over: tool names alone | Without instructions, a small model answered "no such skill" without looking (0/3); with them, 3/3 | 2026-09-28 | The team | Yes |
| B27 | **Search matching:** a search ranks by any word; skills that match every word are listed as matches, and skills that share only some words are listed apart, under "Not matches"; common words of an ask are ignored, a small list of synonyms is in the configuration, and words in a skill's name count more. Over: every word must match | The Assistant sends several words at once; requiring all made it loop 3–13 times, while listing partial matches apart keeps "nothing matches" honest | 2026-09-28, refined 2026-10-02 | The team | Yes |
| B28 | **Publishing:** two steps: see what would be published (the files, the skipped files with a reason each, what changed), then confirm; at a terminal the CLI asks. Over: one step | The Assistant never publishes something the Developer didn't see | 2026-09-28 | The team | Yes |
| B29 | **A hosted publish is checked before any upload:** the hosted catalog checks `SKILL.md` before files go to S3, and indexes the version at publish, so search finds it at once | A refused publish leaves nothing behind, as it does locally | 2026-10-02 | The team | Yes |
| B30 | **Reviews are bounded:** at most 3 findings of one kind per file and 20 in all, the rest counted; findings are measurements, with no score | A review fits in one stored record and in a read's size budget; the rules reviewer gives measurements by name (estimated tokens), never a made-up score | 2026-10-02 | The team | Yes |
| B31 | **CloudFront pricing:** pay-as-you-go. Over: the flat-rate Free plan | AWS refused the Free tier for this stack's web firewall on the first deploy ("not eligible for this subscription tier"); pay-as-you-go costs cents at demo scale, and the firewall stays | 2026-09-29 | The team | Yes |
| B32 | **Tokens without GitHub:** a personal token, issued by whoever holds the AWS account (`npm run issue-token`), only its hash stored. Over: only GitHub sign-in | CI and people outside the sign-in list still need a way in; the account holder already controls everything the token could reach | 2026-09-29 | The team | Yes |

## Defaults awaiting the owner

Taken during the review fixes because each was the recommended, reversible option; each is built and on the owner's list.

| # | Decision | Rationale | Date | Decided by | Built |
|---|---|---|---|---|---|
| B33 | **The local sign-in takes the computer's login** (`USER`) as the Developer's name, when neither `SKILLS_AS` nor setup's name is set | Publishing works on the README's install with no sign-in step | 2026-10-02 | The team (default, awaiting the owner) | Yes |
| B34 | **That local sign-in applies only on the default local catalog**; any other catalog needs a name or a sign-in | A shared or hosted catalog must not trust a computer's login | 2026-10-02 | The team (default, awaiting the owner) | Yes |
| B35 | **Setup adds the `skills-catalog` launcher by default** (in `~/.local/bin`, never overwriting a file there) | The CLI's messages name `skills-catalog`, so it should run as named | 2026-10-02 | The team (default, awaiting the owner) | Yes |
| B36 | **File modes are kept as 0644 or 0755**, and the publish preview names each file whose mode changes (0600 becomes 0644) | Two modes are what every machine can reproduce; the Developer sees the change before saying yes | 2026-10-02 | The team (default, awaiting the owner) | Yes |
| B37 | **A warning in a skill's prose is advice:** the reviewer shows it, but it never holds an update | Text that only warns about a pattern isn't the pattern; holding on it would train people to say yes | 2026-10-02 | The team (default, awaiting the owner) | Yes |
| B38 | **A hand-edited copy is kept aside on update:** before an update replaces a copy the Developer changed, the changed copy is kept aside and the result names where | The owner's stance is that local edits may be lost; keeping them aside costs nothing and loses nothing. It came with the review fixes | 2026-10-02 | The team (default, awaiting the owner) | Yes |

## Open

| # | Question | Owner | Due |
|---|---|---|---|
| Q1 | What are the most valuable additions once the core loop works? (the PRD's) | The owner | Phase 2 |
