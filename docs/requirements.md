# Requirements

Every requirement, in the PRD's or the owner's words, confirmed by the owner; where it lives in the design; and the
automated checks that hold it. Generated from the requirement list and the QA plan's traceability file, so it can't drift.
Contract sections (§) are in [contract.md](contract.md); the test layers are in [the QA plan](../qa/qa-plan.md).

## Phase 1: built, local

### Publish once, reuse through an assistant, end to end

> As Developer 2, I want to discover and retrieve, through an AI assistant, the same skill Developer 1 published, with no file handoff and no repo sharing, so that skill reuse is low-effort and consistent.

- **Source:** the PRD (`docs/prd/`)
- **Done when:** One scripted run: Developer 1 publishes a skill; Developer 2's assistant, asked in plain words, finds it and installs it; the installed files' fingerprint equals the published one; no file or repo was handed over.
- **Where it lives:** the core, the installer, the MCP server; contract §2, §3
- **Checked by:**
  - agent: A16: dev1 publishes (SKILLS_AS=dev1); dev2's assistant finds and installs it; fingerprints equal; results say acting_as dev2

### Publish a skill

> As Developer 1, I want to publish my skill to the catalog so another developer can reuse it without me handing over files.

- **Source:** the PRD (`docs/prd/`)
- **Done when:** From FR-01 and UC-01: a developer can publish a skill (manifest + any supporting files) to the catalog; a published skill is available to another developer, complete; a skill missing a name, description, or body is rejected with an explanation, and nothing partial is stored; a confirmation is returned.
- **Where it lives:** the core, the CLI, the MCP server; contract §2, §3, §5.1
- **Checked by:**
  - storage: publish_version then fetch_version equals the fixture
  - interface: publish_skill_to_catalog through CLI and MCP gives the same fingerprint
  - interface: step 1 (no confirm) lists files, skipped files, diff and risk_flags and stores nothing; step 2 with the token publishes; a folder changed in between gives conflict and stores nothing
  - agent: A6 one turn: preview, show the files and what's skipped, ask; no confirm; the .env sentinel never leaks
  - agent: A6c publish after the person agreed (step 2 with confirm; the permission prompt)
  - interface: every publish result echoes dry_run and names the acting identity as publisher
  - storage: search finds a skill right after publish_version (the index listens to version_published)
  - interface: the card shows the latest description after a new version
  - interface: catalog_size grows by one with a new name and stays the same with a new version
  - unit: manifest validation table
  - storage: logical snapshot unchanged after each invalid publish
  - storage: fault injection (Nth write fails) leaves no version
  - interface: dry_run stores nothing and returns the diff
  - agent: A7 relays the reason and proposes the fix; never edits the person's files unasked
  - interface: an error whose fix is a change to the person's files tells the agent to propose it and wait (contract §9)
  - interface: secret_suspected with path and line; the ignore list skipped and reported; the MCP schema has no override
  - interface: secret_suspected's text never repeats the secret's value (nor the sentinel)
  - agent: A7s no tool call carries the override

### Discover skills through an AI assistant

> As Developer 2, I want to ask my AI assistant what skills exist for a need so I can reuse one instead of writing my own.

- **Source:** the PRD (`docs/prd/`)
- **Done when:** From FR-02 and UC-02: through an AI assistant, in natural language, a developer can find published skills that match a described need; each result identifies the skill (at least name and description); when nothing matches, the assistant clearly says so.
- **Where it lives:** the core, the MCP server; contract §2
- **Checked by:**
  - interface: search recall@5 = 1.0 on the gate set for the adapter's mode (keyword-gate-any for any-word, the contract's) and on each semantic-gap reformulation
  - interface: semantic-gap misses reported (not gated) so a later semantic search shows its gain
  - interface: every card lists matched_words; the common-words list equals the adapter's
  - interface: every page says catalog_size 64 on the corpus; total_matches equals the distinct cards across all pages, and is 0 exactly when match is none
  - agent: A1, A2 discover by keyword and by paraphrase
  - agent: every run records recall
  - interface: for each no-match query: match is partial or none, and no card's matched_words covers every content word
  - agent: A3 sourdough: says none plainly, invents nothing
  - agent: A3g GraphQL: says nothing fits and never offers sql-migration-writer as a fit
  - interface: match follows the index's stemming: 'review pull request' puts pr-review-checklist first with matched_words [review, pull, request] and match all

### Retrieve a skill through an AI assistant

> As Developer 2, I want my AI assistant to retrieve a published skill so I get the same one Developer 1 has, ready to use.

- **Source:** the PRD (`docs/prd/`)
- **Done when:** From FR-03 and UC-03: through an AI assistant, a developer can retrieve a named skill; it is complete and unchanged from what was published (manifest + supporting files); retrieving a skill that doesn't exist returns a clear "not found."
- **Where it lives:** the core, the installer, the MCP server; contract §2, §3
- **Checked by:**
  - interface: read_shared_skill include: contents equals the fixture's text files
  - interface: include: files types each file by its bytes (only logo.png is binary); include: contents gives content for every text file, SKILL.md included, encoding back to the exact bytes; never for a binary
  - interface: install_shared_skill writes the same tree and a lock entry
  - agent: A4 installs the skill intact
  - interface: not_found per name on every face, with suggestions by spelling only
  - agent: A5 says not found

### Version a skill

> As Developer 1, I want publishing an updated skill to create a new version so changes are tracked and nothing is silently overwritten.

- **Source:** the PRD (`docs/prd/`)
- **Done when:** From FR-04, UC-04 and the goals: publishing a skill whose name already exists creates a new version and prior versions are retained; a developer can see a skill's version history; retrieving returns the latest version by default and an earlier version when asked for; a malformed update is rejected and existing versions are untouched; history is retained and inspectable.
- **Where it lives:** the core; contract §2, §4.4
- **Checked by:**
  - storage: history steps
  - storage: 20 publishes from separate processes all land; stale expected_latest conflicts
  - storage: two publishes race on one expected_latest: one lands, the other conflicts; no orphan blob, and every version is still retrievable
  - storage: expected_latest 0 means a new name: it creates version 1, and conflicts on a name that exists, storing nothing
  - unit: version numbering property test under random interleavings
  - interface: list_shared_skill_versions and diff_shared_skill_versions equal the goldens (with risk_flags)
  - agent: A8 says what changed
  - storage: get and get version k per history step
  - interface: reading version k also says latest_version, the current latest
  - agent: A9 installs version 1 on request
  - storage: the malformed step in the history

### A retrieved skill is complete and unchanged

> As Developer 2, I want a retrieved skill to be complete and unchanged from what was published, with no silent loss or alteration, so that I have the same skill Developer 1 published.

- **Source:** the PRD (`docs/prd/`)
- **Done when:** Publish then retrieve; compare against the original (the PRD's method): the test computes the fingerprint of every file, byte and file mode, itself and it matches.
- **Where it lives:** the core, the installer; contract §4.3
- **Checked by:**
  - unit: round-trip property test over generated trees (paths
  - storage: round trip on every adapter
  - storage: a failed publish deletes the blobs it created (not ones it found); a killed process or a failed delete leaves them, and the next open removes them only once over an hour old (injected clock); a blob shared with a version, or written by a publish in flight, is never removed
  - storage: a publish that fails and deletes its blob never breaks a concurrent publish of the same content: that one re-puts the blob and lands
  - storage: no version ever points at a missing blob: a retry of hour-old leftovers lands (put-if-absent refreshes their time); a publish stalled over an hour lands (the append re-puts a removed blob under the write lock); a failed re-put stores no version

### Access is through an AI assistant

> As Developer 2, I want discover and retrieve to happen through an AI assistant acting for me on natural-language intent, not only a direct human-operated interface, so that I can reuse skills with little effort.

- **Source:** the PRD (`docs/prd/`)
- **Done when:** Exercise discover and retrieve via an AI assistant (the PRD's method): the QA plan's agent scenarios drive a real assistant in plain words, and the trace shows catalog calls before the answer.
- **Where it lives:** the MCP server; contract §1
- **Checked by:**
  - agent: every scenario's trace shows a catalog call before the answer

### Fast enough to feel interactive

> As Developer 2, I want discovery and retrieval to be fast enough to feel interactive within an assistant conversation, so that asking my assistant is quicker than asking a colleague.

- **Source:** the PRD (`docs/prd/`)
- **Done when:** Observed during a normal exchange (the PRD's method), plus the QA plan's budgets: local search p95 ≤ 100 ms at 10,000 skills, hosted search p95 ≤ 300 ms warm and ≤ 1.5 s for the first query after idle.
- **Where it lives:** the core; contract §7
- **Checked by:**
  - perf: search/read/publish p95 on the 10
  - perf: update at session start for 50 skills; initialize answered first
  - agent: median scenario wall time and catalog calls

### Runs on a reviewer's machine from a short README

> As a reviewer of the exercise, I want it to be self-contained and run on my machine from a short README, so that I can try it myself.

- **Source:** the PRD (`docs/prd/`)
- **Done when:** The README's quickstart, run word for word in a fresh home folder, installs, runs the tests and completes the publish → discover → retrieve loop with no account and no server.
- **Where it lives:** the core, the CLI; contract §7
- **Checked by:**
  - setup: README quickstart run word for word in a fresh home (npm prefix and caches in the sandbox)
  - setup: README lint: exactly one quickstart command; an architecture diagram that renders (light and dark); every link resolves

### Scoped to the time box

> As the reviewer of the exercise, I want the build scoped to the time box, a smaller, coherent, working system rather than a larger broken one, so that what's shipped works.

- **Source:** the PRD (`docs/prd/`)
- **Done when:** Everything in the submission passes its tests; what isn't built is shown as design, and the owner's scope decision says which is which.
- **Where it lives:** the core
- **Checked by:**
  - cleanup: qa run phase1 passes on the submission commit, from a fresh copy of the repo
  - unit: every phase-1 requirement's checks exist and run; later items are listed as design in the README

### Agent-first: an MCP and/or skill for everything

> As a developer working through an AI assistant, I want everything to be agent-first, with an MCP and/or skill for all of it, so that my assistant can do all of it for me.

- **Source:** the owner's notes on the PRD
- **Done when:** Every operation in the contract's registry is reachable by an assistant (an MCP tool, or the companion skill with the CLI), except those marked for a person only; nothing the web UI can do is out of an agent's reach.
- **Where it lives:** the MCP server, the CLI; contract §1
- **Checked by:**
  - agent: access matrix (MCP / MCP + skill / skill + CLI) per scenario
  - interface: every phase-1 operation marked MCP is in tools/list; the server sends its instructions; the companion skill names only real tools
  - interface: an internal error gives internal_error {log}: no traceback in CLI or MCP output; the traceback is in a log under $SKILLS_HOME
  - interface: the name is skills-catalog everywhere: CLI, package, MCP server
  - agent: the assistant asks run before every merge: Claude Haiku on all of them, Claude Opus on the core asks

### Constant QA on the agent-level experience

> As the owner, I want constant QA on the agent-level experience, first and foremost, so that how assistants really use the catalog is what we measure.

- **Source:** the owner's notes on the PRD
- **Done when:** Agent scenarios drive a real assistant, headless, in three setups (MCP only, MCP + companion skill, skill + CLI), three runs each; every safety rule holds in all runs and each task succeeds in at least two of three; results are kept per run.
- **Where it lives:** the test suite, the MCP server; contract §1
- **Checked by:**
  - agent: access matrix (MCP / MCP + skill / skill + CLI) per scenario
  - interface: every phase-1 operation marked MCP is in tools/list; the server sends its instructions; the companion skill names only real tools
  - interface: an internal error gives internal_error {log}: no traceback in CLI or MCP output; the traceback is in a log under $SKILLS_HOME
  - interface: the name is skills-catalog everywhere: CLI, package, MCP server
  - agent: the assistant asks run before every merge: Claude Haiku on all of them, Claude Opus on the core asks

### Auto-updates: global and per skill

> As Developer 2, I want auto-updates as a user option, global and overridable per skill, as part of the initial delivery, so that my installed skills stay the same as the catalog.

- **Source:** the owner's notes on the PRD
- **Done when:** A global update policy with per-skill overrides; the update gate table (contract.md §5.3) passes the QA plan's policy goldens; an update replaces the installed copy (the owner's stance for now: local edits not shared upstream may be lost, as with other installed tools; handling them is an open question).
- **Where it lives:** the installer; contract §3, §5.3
- **Checked by:**
  - unit: update gate table
  - interface: update_installed_skills replaces a hand-edited copy and records version and fingerprint in the lock (phase 1: the owner's decision)
  - agent: A10 update my skills
  - agent: A10u an unattended update holds a flagged change
  - agent: A10n the hold is reported when the next session starts: a system message names it, and the assistant relays it
  - setup: the session-start hook: while an update is held it prints JSON with systemMessage and additionalContext; with nothing held it prints nothing
  - setup: the session-start hook always exits 0, even with the catalog missing or broken, and stops syncing after 2 seconds
  - setup: the 'synced recently' stamp stops a second sync at MCP start
  - setup: teardown removes the hook and restores settings.json byte for byte
  - manual: how the interactive terminal shows the session-start message, looked at once (manual)
  - agent: A10g a held update is relayed to the person and never accepted by the assistant
  - interface: accept_held_update with the held result's confirm installs that version, and the lock records the flags it let through
  - interface: a newer version published between hold and accept gives conflict and changes nothing; a confirm for another name or version is refused
  - setup: setup's allowed tools never include accept_held_update or publish_skill_to_catalog

### Contracts not coupled to a backend

> As the owner, I want the experience, interface and contracts built without coupling ourselves to a specific backend choice, so that we stay flexible (e.g. OpenSearch, or DynamoDB + S3).

- **Source:** the owner's notes on the PRD
- **Done when:** One conformance suite passes unchanged against the local catalog and at least one other backend; changing the search engine needs no data migration.
- **Where it lives:** the core; contract §7
- **Checked by:**
  - storage: one suite unchanged on every adapter (SQLite + folder now; others plug in later)
  - agent: A11 finds a skill in a 10

### A simple demo login: act as another developer

> As someone running the catalog locally or for a demo, I want a simplified login where I can act as other developers, with a seamless, discreet label saying it's for demo purposes, so that I can show two developers sharing a skill on one machine.

- **Source:** the owner's decision (`docs/decisions.md`)
- **Done when:** With no sign-in, a person chooses who they act as (a flag, a setting, or the MCP server's config); every result says who is acting, and the CLI shows one discreet 'for demo purposes' line; setup can add two demo developers; the README demo shows Developer 1 publishing and Developer 2 installing but not overwriting.
- **Where it lives:** the core, the CLI, the MCP server; contract §6, §7
- **Checked by:**
  - interface: --as, SKILLS_AS and the MCP server's config each set acting_as; every result carries it
  - interface: the CLI prints exactly one 'for demo purposes' line per command, and none in --json output

### List with filters, and Get one or several

> As an AI assistant acting for a developer, I want to List skills (likely with filters) and Get a specific skill or skills up to a limit, so that I can do the search myself, a-la progressive disclosure, whatever the backend.

- **Source:** the owner's notes on the PRD
- **Done when:** Search with no words is the List, with filters and pages; get takes one name or up to 20; asking for more returns a clear error naming the limit.
- **Where it lives:** the core, the MCP server; contract §2
- **Checked by:**
  - interface: search with no query and each filter (tags
  - interface: tags filter: [docs] returns exactly tagged, tags-deduped, tags-at-limit; [docs, release] only the skills with both; a top-level tags list is never a tag
  - unit: metadata.tags parsing: trimmed, deduplicated in order, ≤10 of 1-32 [a-z0-9-]; each bad form is invalid_manifest {fields: [metadata.tags]}
  - interface: read_shared_skill with 20 names works; 21 gives invalid_request {field: names, limit: 20}; search limit 51 gives invalid_request {field: limit, limit: 50}; each with a why
  - interface: cursor paging returns every skill once while publishes happen

### Everything local by default; AWS is an option, off

> As a developer, I want everything to run locally by default, with the guided setup offering to set it up in AWS as an option that's off by default, so that nothing needs an account or a server unless I choose it.

- **Source:** the owner's decision (`docs/decisions.md`)
- **Done when:** Setup with its defaults creates no cloud resources and needs no account; choosing AWS deploys the same core there, shows what it creates and costs first, and teardown removes it.
- **Where it lives:** the CLI, the AWS stack; contract §6
- **Checked by:**
  - setup: setup with every default writes hosting: local and a local catalog, and never reads a sentinel AWS profile
  - cleanup: the whole phase-1 run passes with the network to AWS blocked

### Only a skill's owners can publish it

> As Developer 1, I want only a skill's owners to be able to publish it, so that no one else can change what my skill's subscribers get.

- **Source:** the owner's decision (`docs/decisions.md`)
- **Done when:** Locally, in the core: the first publisher owns the name; a publish of that name by anyone else returns a clear not-owner error naming the owners, and stores nothing; the recorded publisher is always the acting identity.
- **Where it lives:** the core; contract §7, §9
- **Checked by:**
  - storage: publish as dev2 of dev1's skill gives not_owner {owners}, preview included; the snapshot (rows and blobs) is unchanged
  - interface: every version's publisher equals the acting identity, never a field in the request

### QA first, with automation that cleans up after itself

> As the owner, I want a QA-first mentality and reproducible automation that automatically cleans up after itself and doesn't make permanent changes, so that every check can be run again safely.

- **Source:** the owner's notes on the PRD
- **Done when:** One command runs every test layer in a throwaway sandbox; a footprint check after each run finds nothing changed outside the sandbox; a deliberately leaky canary test makes the footprint check fail.
- **Where it lives:** the test suite; contract §4
- **Checked by:**
  - cleanup: before/after check (folders and files) equal after every run
  - cleanup: leaky canary makes the check fail
  - cleanup: assistant-run leftovers (projects, session-env, tmp, and the MCP-log cache ~/Library/Caches/claude-cli-nodejs/<working-folder slug>/) removed by session id and sandbox path; each server's log is first kept with the run's transcripts
  - cleanup: pre-flight starts the catalog's MCP server with exactly the runs' settings (environment, paths, MCP config), and a server that dies at start stops the round
  - agent: no_read_outside_sandbox holds in every run: reads are allowed only under the sandbox, and the MCP setups have no Bash
  - unit: fail-safe guard is on in every run, and trips when HOME points elsewhere (real home from the OS)
  - unit: safe deletion: a symlinked base deletes nothing; a symlinked run folder is skipped; a run id with '..' is rejected; a live run is kept; an entry without run.json is skipped, never judged by mtime
  - unit: safe deletion outside the base: only the run's own leftovers; a non-UUID session id, a slug outside the base's prefix or colliding with another run, and a path differing only in case are refused
  - unit: tests of teardown and the janitor use a fake home and tmp root; a test resolving a deletion path under the real ones fails
  - cleanup: qa janitor --dry-run lists what it would delete and deletes nothing

### Automated skill quality reviews

> As someone finding or installing skills (through an agent, the UI or the CLI), I want every skill measured by a pluggable set of independent reviewer agents and rules, on publish or offline, so that skills with low quality (security-questionable, too much context, slop) rank lower or come with advice against them.

- **Source:** the owner's notes on the PRD
- **Done when:** see the checks below

- **Checked by:**
  - unit: every flagged fixture gets exactly its expected findings, each grounded (path, line, evidence on that line)
  - unit: every valid fixture gets a review with no findings
  - unit: the 64-skill discovery corpus gets no findings (no noise on good skills)
  - interface: a card carries quality only when the skill is flagged; read returns reviews; install and update return advisories
  - unit: one reason per file: a script path gets runnable_file only, never also non_markdown
  - agent: A13 the assistant is warned about a skill with a planted instruction
  - agent: known-good skills approved with no comments (≥ 95%); known-bad flagged
  - unit: every finding cites an existing file and line that supports it

### A simple, visual README

> As a reviewer of the exercise, I want a very easy, visual, simple README, with an architecture diagram, how to run it (one command with a guided setup) and links to other documents, so that I understand and run it in minutes.

- **Source:** the owner's decision (`docs/decisions.md`)
- **Done when:** The README shows an architecture diagram, one command that starts the guided setup, and links to the other documents; the README walker runs that command word for word in a fresh home folder and it completes.
- **Where it lives:** the CLI; contract §6
- **Checked by:**
  - setup: README quickstart run word for word in a fresh home (npm prefix and caches in the sandbox)
  - setup: README lint: exactly one quickstart command; an architecture diagram that renders (light and dark); every link resolves

### Reviewer flags such as prompt-injection risk

> As Developer 2, I want reviewer-based metrics or flags, such as the risk of prompt injection, considered alongside auto-updates, so that a risky skill or update is flagged before it reaches my assistant.

- **Source:** the owner's decision (`docs/decisions.md`)
- **Done when:** Phase 1: a built-in rules reviewer flags scripts and executables, tool-granting frontmatter, a publisher change, prompt-injection patterns (instructions to ignore prior guidance, exfiltration or curl-to-shell, hidden unicode or HTML comments) and context cost, each finding grounded; a clean skill gets an empty list; the update gate stops on any risk flag; search cards show the flags.
- **Where it lives:** the core, the installer; contract §10, §5.3
- **Checked by:**
  - unit: every flagged fixture gets exactly its expected findings, each grounded (path, line, evidence on that line)
  - unit: every valid fixture gets a review with no findings
  - unit: the 64-skill discovery corpus gets no findings (no noise on good skills)
  - interface: a card carries quality only when the skill is flagged; read returns reviews; install and update return advisories
  - unit: one reason per file: a script path gets runnable_file only, never also non_markdown
  - agent: A13 the assistant is warned about a skill with a planted instruction

### Skill reviewers measure, not nit-pick

> As a skill submitter, I want reviewers to measure, ground every finding and add notes only when they help, and to approve without comments when a skill is good, so that reviews don't add unnecessary toil.

- **Source:** the owner's notes on the PRD
- **Done when:** see the checks below

- **Checked by:**
  - unit: every flagged fixture gets exactly its expected findings, each grounded (path, line, evidence on that line)
  - unit: every valid fixture gets a review with no findings
  - unit: the 64-skill discovery corpus gets no findings (no noise on good skills)
  - interface: a card carries quality only when the skill is flagged; read returns reviews; install and update return advisories
  - unit: one reason per file: a script path gets runnable_file only, never also non_markdown
  - agent: A13 the assistant is warned about a skill with a planted instruction

### Plan for how many skills we'll have

> As the owner, I want the design to consider how many skills we'll have over time, so that it informs our choices in the backend for searching and our APIs.

- **Source:** the owner's notes on the PRD
- **Done when:** The design states the scale tiers, with measured card sizes, and the point at which search moves to the next backend; a generated 10,000-skill catalog meets the search budget.
- **Where it lives:** the core; contract §5
- **Checked by:**
  - storage: one suite unchanged on every adapter (SQLite + folder now; others plug in later)
  - agent: A11 finds a skill in a 10

### Measure and improve search over time

> As the owner, I want the system measured and improved over time, so that search choices follow evidence.

- **Source:** the owner's notes on the PRD
- **Done when:** Every run records recall of the labelled discovery queries, tokens per successful discovery and first-query time, and keeps them per run so trends show.
- **Where it lives:** the test suite
- **Checked by:**
  - interface: search recall@5 = 1.0 on the gate set for the adapter's mode (keyword-gate-any for any-word, the contract's) and on each semantic-gap reformulation
  - interface: semantic-gap misses reported (not gated) so a later semantic search shows its gain
  - interface: every card lists matched_words; the common-words list equals the adapter's
  - interface: every page says catalog_size 64 on the corpus; total_matches equals the distinct cards across all pages, and is 0 exactly when match is none
  - agent: A1, A2 discover by keyword and by paraphrase
  - agent: every run records recall

### An agent can run the guided setup

> As a developer, I want the guided CLI setup to be something my agent can run instead of me, as a skill or by reading a doc, so that setup is agent-first too.

- **Source:** the owner's decision (`docs/decisions.md`)
- **Done when:** An assistant given only the setup skill or the setup doc completes setup in a sandbox, choosing the same options the person would, with no one typing into the CLI; the result equals the same answers given to the wizard.
- **Where it lives:** the CLI, the installer; contract §6
- **Checked by:**
  - setup: wizard through a pseudo-terminal: Enter at the auto-update prompt means yes; AWS prompt defaults to no
  - setup: --yes means auto-updates on and hosting local
  - agent: A12 set it up from the README's hand-off prompt
  - agent: A12s a vague ask never touches the assistant's own settings
  - agent: A12p a partial preference is carried and the open questions relayed
  - agent: A15 set it up by reading the README
  - agent: A14 teardown puts things back
  - setup: teardown leaves the assistant home byte-identical to before setup
  - setup: setup's result leads with the remaining step and 'N skills to search; none installed yet'
  - manual: the owner watches a recording of the wizard (manual)

### Unattended setup from flags or a file

> As a developer, I want unattended setup via the CLI, passing all configurations or a file, so that setup can run fast and unattended.

- **Source:** the owner's notes on the PRD
- **Done when:** Setup with all defaults, or with a config file, writes the same config as the same answers typed at the prompts; with no terminal attached it never waits.
- **Where it lives:** the CLI, the installer; contract §6
- **Checked by:**
  - setup: --config gives the same config as the wizard with the same answers; closed stdin never waits
  - setup: no terminal and no --yes/--config: prints every question with its flag and the --yes line, exits 3, changes nothing (before/after check)
  - unit: one question list: the wizard's questions, the flags, the --config schema and the no-terminal output match (parity)
  - setup: exit codes: 0 done, 1 error, 3 needs answers
  - setup: set_skill_update_policy and a hand edit of config.json both change the effective policy

### A welcoming setup, from a CLI installer or a prompt

> As a developer setting up skill searching and fetching, from a CLI installer or a prompt for an agent, I want a welcome, intuitive, colorful setup that asks if I want auto-updates on (default yes), so that I never need to go into a file or run a CLI to configure it.

- **Source:** the owner's notes on the PRD
- **Done when:** The installer asks once, in colour, with auto-updates defaulting to yes; an agent can run the same setup from a prompt; the file and the CLI exist too; teardown undoes everything setup wrote.
- **Where it lives:** the CLI, the installer; contract §3, §6
- **Checked by:**
  - setup: wizard through a pseudo-terminal: Enter at the auto-update prompt means yes; AWS prompt defaults to no
  - setup: --yes means auto-updates on and hosting local
  - agent: A12 set it up from the README's hand-off prompt
  - agent: A12s a vague ask never touches the assistant's own settings
  - agent: A12p a partial preference is carried and the open questions relayed
  - agent: A15 set it up by reading the README
  - agent: A14 teardown puts things back
  - setup: teardown leaves the assistant home byte-identical to before setup
  - setup: setup's result leads with the remaining step and 'N skills to search; none installed yet'
  - manual: the owner watches a recording of the wizard (manual)

## Phase 2: designed, local, not built yet

### Bundles of skills you can share

> As a developer, I want to create bundles of skills / plugins, selecting which skills to group together, and share my bundle, so that others get the whole set in one step.

- **Source:** the owner's notes on the PRD
- **Done when:** A person picks skills (each pinned to a version) into a named bundle and shares it; another developer installs the bundle in one step and gets exactly those versions.
- **Where it lives:** the core, the web UI; contract §2, §5.3
- **Checked by:**
  - interface: a bundle installs exactly its pinned versions

### Web UI: see what changed between versions

> As a developer, I want a delta view of the changes across a skill's revisions, so that I can see what changed.

- **Source:** the owner's notes on the PRD
- **Done when:** Choosing two versions shows each file added, changed or removed with its differences, and flags new scripts and changed frontmatter.
- **Where it lives:** the web UI, the core; contract §2, §5.3
- **Checked by:**
  - web: the page's diff equals the golden diff

### Web UI: view and update skills

> As a developer, I want a web UI where it's easy to view and update skills and inspect their history, so that I don't need an assistant or a CLI to look after them.

- **Source:** the owner's notes on the PRD
- **Done when:** In the web UI a person can browse skills, open one and its history, and edit it; saving publishes a new version, and is refused if someone published since.
- **Where it lives:** the web UI; contract §2
- **Checked by:**
  - web: Playwright view and publish on the local server (the web plan)
  - manual: the owner reviews the mock-ups (manual)

## AWS, opt-in: designed, not built

### Everyone signed in can read

> As the owner, I want everyone to sign in to read a hosted catalog, so that our skills stay within the people we share them with.

- **Source:** the owner's decision (`docs/decisions.md`)
- **Done when:** On the hosted catalog, every read without a valid sign-in or token is refused, and every signed-in person can read every skill.
- **Where it lives:** the AWS stack, the web UI; contract §7
- **Checked by:**
  - web: no or revoked token gives 401; a signed-in read works (the web plan)

### Web UI: stack, security and deployment into my AWS account

> As the owner, I want the web application's stack, security and deployment into my AWS account planned, so that the web UI can run there.

- **Source:** the owner's notes on the PRD
- **Done when:** A reviewed plan covers stack, security and deployment; one command deploys a throwaway stack and tears it down, leaving nothing behind; nothing is reachable without the sign-in the owner chooses.
- **Where it lives:** the web UI, the AWS stack
- **Checked by:**
  - web: CDK assertions and cdk-nag
  - storage: the suite on moto every change and on a throwaway stack on request
  - cleanup: janitor finds leftovers by run tag and by name prefix (untagged log groups)

## Later

### Community votes on bundles

> As a developer, I want community feedback like votes on shared bundles, so that good bundles stand out.

- **Source:** the owner's notes on the PRD
- **Done when:** A signed-in person votes once per bundle and can take it back; counts show on the bundle; an unsigned request can't vote.
- **Where it lives:** the core, the web UI; contract §2
- **Checked by:**
  - interface: one vote per identity per bundle; unvote works; an unsigned request can't vote

### find merges and sharing for your own skills

> As a developer, I want a pass over my own skills that finds room to merge with others, share mine, or get other skills, so that I don't keep near-copies.

- **Source:** the owner's notes on the PRD
- **Done when:** It lists each own skill with its near-duplicates in the catalog, and the unpublished ones worth sharing; it changes nothing on its own.
- **Where it lives:** the installer
- **Checked by:**
  - interface: lists the hand-labelled near-duplicate pairs from the discovery corpus; the before/after check shows nothing changed

### Owners give others permission to publish

> As a skill's owner, I want to assign permissions to others, so that maintainers I choose can publish new versions too.

- **Source:** the owner's decision (`docs/decisions.md`)
- **Done when:** An owner adds and removes maintainers; a maintainer's publish succeeds; anyone else still gets the not-owner error; each update shows who published it.
- **Where it lives:** the core; contract §7
- **Checked by:**
  - storage: maintainer add/remove changes who can publish; a removed maintainer gets not_owner

### skills recommended from your own sessions

> As a developer, I want my own sessions and transcripts reviewed or sampled, automatically or on demand, and skills auto-recommended, so that I find skills I'd use without searching.

- **Source:** the owner's notes on the PRD
- **Done when:** Run on demand or on a schedule, it recommends catalog skills that match needs found in recent sessions; the analysis runs on the developer's machine, and a planted marker in a transcript never leaves it.
- **Where it lives:** the installer
- **Checked by:**
  - interface: made-up session transcripts with labelled needs give the labelled skills
  - cleanup: a sentinel planted in the transcripts never leaves the machine (no request body or log carries it)

## Plans

### Web UI mock-ups to review

> As the owner, I want a designer and an architect to come up with mock-ups that I can review, so that I shape the UI before it's built.

- **Source:** the owner's notes on the PRD
- **Done when:** Mock-ups of the main web pages (browse, a skill and its history, the delta view, editing, bundles) are in front of the owner for review.
- **Where it lives:** the web UI
- **Checked by:**
  - web: Playwright view and publish on the local server (the web plan)
  - manual: the owner reviews the mock-ups (manual)

