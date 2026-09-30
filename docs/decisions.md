# Decisions

Each decision: what was chosen, what else was on the table, why, and who decided. "The owner" is the person this was built for; "the team" is the architects, QA and agent-experience work behind the design. Details live in [contract.md](contract.md); the owner's words are in [prd/notes.md](prd/notes.md).

At a glance: 17 decisions, 8 decided by the owner and 9 by the team.

## Decided by the owner

| Decision | Chosen | Alternatives | Why |
|---|---|---|---|
| **What ships first** | Everything runs locally by default, set up by one guided command (an assistant can run it too); AWS is an opt-in, off by default. Phase 1 is all local | Build the web UI and AWS hosting now | The PRD's time box and "run on a reviewer's machine from a short README": no account, no server |
| **Risky updates wait for a yes** | Auto-updates on by default, but an update stops and shows you what changed when it could change what runs on your machine: a runnable file, an executable bit, tool grants or hooks, commands that run when the skill loads, or a new publisher. Unattended runs hold such an update and report it | Apply every update silently | A skill is instructions an assistant follows; an update is a way to change what runs on your machine |
| **Reviewer flags** | A built-in rules reviewer flags risks on every publish (phase 1); pluggable agent reviewers that measure quality come later. Findings are grounded; approving with no comments is a normal result | Reviews only later | The owner asked for reviewer-based metrics, prompt-injection risk included |
| **Who may publish** | Only a skill's owners (its first publisher, plus maintainers later). Hosted: everyone signs in, even to read. Locally, for demos, you can act as another developer, clearly labelled | Anyone signed in publishes | Signing in isn't permission to change someone else's skill |
| **Search to start with** | Keyword search built in, upgraded when measurement says so (recall on a golden query set, speed) | A search service by meaning from day one | Nothing to run or pay for; the index is rebuilt from stored versions, so switching later needs no migration |
| **Where an installed skill's origin is kept** | The installer's own list (name, version, fingerprint, which catalog), by install location | Metadata inside SKILL.md; a small file beside it | The skill's files stay exactly as published, so "complete and unchanged" stays checkable |
| **Local edits to an installed skill** | For now, standard: an update replaces a copy you changed. How to protect local edits is an open question | Warn, back up, or skip changed skills | The owner's call, like most installed software |
| **Stay flexible** | One contract (List with filters, Get, and the rest) with storage and search behind replaceable parts | Build straight on one backend | "build the experience, interface and contracts without coupling ourselves with a specific choice" |

## Decided by the team

| Decision | Chosen | Alternatives | Why |
|---|---|---|---|
| **Skill format** | The Agent Skills `SKILL.md` format; tags in `metadata.tags` | Our own manifest | A retrieved skill is drop-in for assistants that read the standard |
| **What a version is** | A number (the handle) plus a fingerprint of every file and whether it can run (the identity). Publishing identical content to the latest is a no-op; restoring an old version makes a new one | Semantic versions | Makes "complete and unchanged" and "nothing silently overwritten" checkable by anyone |
| **Retrieve means install** | Written into the assistant's skills folder and tracked | Content returned into the conversation only | "Ready to use", and what makes updates and drift checks possible |
| **One contract, many faces** | Each operation is defined once; the assistant's tools, the CLI and a future web API come from it | Separate APIs per face | Agents can do everything a person can ("agent-first"), and faces can't drift apart |
| **Tool names** | No tool is called "get": `read_shared_skill` and `install_shared_skill` | `get_skill` | In trials, people saying "get me X" meant install; renaming took success from 0/2 to 2/3 |
| **How the assistant finds the catalog** | The MCP server's own instructions; a small companion skill for the CLI-only setup | Tool names alone | Without instructions, a small model answered "no such skill" without looking (0/3); with them, 3/3 |
| **Search matching** | Any word ranks results; each result says which words matched, and a page says "partial" when nothing matches all of them | Every word must match | Assistants send several words at once; requiring all made them loop 3–13 times, while "partial" keeps "nothing matches" honest |
| **Publishing** | Two steps: see what would be published, then confirm | One step | An assistant never publishes something the person didn't see |
| **Architecture** | A local-first core with replaceable storage, search and identity; the same tests run against every backend | AWS from day one; a git repo as the catalog; plugin marketplaces as the backend; a hosted MCP server only | Runs anywhere in minutes, and keeps every one of those as a later option or an export |
| **CloudFront pricing** | Pay-as-you-go | The flat-rate Free plan | AWS refused the Free tier for this stack's web ACL on the first deploy ("not eligible for this subscription tier"); pay-as-you-go costs cents at demo scale, and the firewall stays |
| **Tokens without GitHub** | A personal token, issued by whoever holds the AWS account (`npm run issue-token`), only its hash stored | Only GitHub sign-in | CI and people outside the sign-in list still need a way in; the account holder already controls everything the token could reach |
