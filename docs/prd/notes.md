# The owner's notes on the PRD

The owner read the Skills Catalog PRD (v0.1.0, not included here) section by section, and wrote these notes before any design work began. They're copied exactly, per section. Two remarks about the review tooling itself are left out, because they aren't about the product.

The design answers each note; [the decisions](https://claude.ai/artifact/Tn6An3wQ9sVg9zD1eyB7aq) (the system map's Decisions tab) say how.

## 3. Goals and Success Metrics

Oh, by the way, we need a QA-first mentality.

We should think about how to build reproducible automation for this. (That automatically cleans up after itself / doesn't make permanent changes.)

---

The PRD says history is retained and inspectable - we may want a Web UI - we can do that in parallel (it's a secondary priority, but if we can have a designer plan the UX, a sub-architect plan the web application stack, security, deployment into my AWS account, then let's do it in parallel). There are several other requirements for the UI, so let's have a designer + architect come up with mock-ups that I can review.

We should make it easy to view and update skills from the UI. And importantly, a delta UX to view changes across revisions.

We should add the ability to create bundles of skills / plugins. Maybe some UX where I can select which skills to group together and share my bundle - likely with community feedback like votes.

Everything should be agent-first, so we should have an MCP and/or skill for all of this, and we should do constant QA on the agent-level experience first and foremost.

## 2. Personas

Long-term plan, not for initial iteration:

A way to automatically or on-demand review / sample one's own sessions / transcripts and have skills auto-recommended, and/or pass over ones own skills and determine if there's room to merge with others / share or get other skills.

Sooner - part of initial delivery: auto-updates

However, auto-updates should be a user option (it can be global and overridable per skill) - but at the same time, it should be a seamless user experience (e.g. no need to go into a file to configure it or run a CLI - although those should be available too; but rather when setting up our skill searching and fetching tooling [which should be available both via a CLI installer and a prompt for an agent], we'd make it a welcome, intuitive, (colorful) UX that asks you if you want auto-updates on (with a default of yes in case someone wants to run fast / unattended).

Unattended setup via CLI also should be a thing (e.g. pass all configurations / a file).

## 5. UC-01: Publish a skill

We need to consider how many skills we'll have over time.

This will inform our choices in the backend for searching, our APIs, etc.

That said, we should build the experience, interface and contracts without coupling ourselves with a specific choice.

For instance, later on we may need something like OpenSearch to do free-form or semantic search on skills. And we _may_ choose to start there if it's cost-effective. Otherwise, we could start with a different database like DynamoDB + S3.

And for both of those options, the API would be the same, like:

- List
  - Likely with the option to have filters
- Get (a specific skill or skills up to a limit)

^ this way regardless of what our backend is, agents can do the search themselves (a-la progressive disclosure). We'd measure and improve the system over time.

Again, we'd need to discuss the architecture; the above are just examples to illustrate the uber-point that we should stay flexible - please analyze and give me proposals for the architecture and APIs without limiting yourself by my assumptions.

## 5. UC-02: Discover a skill through an AI assistant

Again, paramount to QA on this, let's have a TDD/QA agent session who analyzes in detail and plans the oracles, test automation, test golden sets, etc.

## 10. Dependencies

Slightly unrelated, but we should have as a second phase / longer term / backlog item to have automated reviews / quality measurements (either on publish or offline).

All entrypoints searching for / installing skills (e.g. agents, UI, CLI) should have access to the measurements to rank and/or advice (e.g. against) using a specific skill with low quality (e.g. because it either does security-questionable things; because it uses too much context / has too much slop, etc.).

The review mechanism should be a pluggable set of agents and/or rules executed by independent agents.

Their goal should be to measure, with optional notes for the submitter.

All their findings should be grounded and they should be completely fine with approving without comments when something's good (preferred over being nit-picky and adding unnecessary toil).

^ store that as a requirement / set of requirements.
