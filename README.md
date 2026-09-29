# Skills Catalog

Publish an AI-assistant skill once; another developer's assistant finds it, installs the same skill, and keeps it up to date.

![One contract, two homes: everything runs on your machine; a hosted catalog in your AWS account is designed but not built](docs/pictures/shape.svg)

## Where it stands

| | |
|---|---|
| **Built** | The core catalog: publish (all-or-nothing, owner-only), versions with fingerprints, keyword search that says when nothing matches exactly, read, history, diffs with risk flags, a local SQLite + file store behind replaceable parts. |
| **Next** | The installer and CLI, the assistant's tools (MCP), the update gate, and one guided `setup` command. Designed in [docs/contract.md](docs/contract.md), in progress. |
| **Later** | A web UI with a delta view, a hosted catalog in AWS, bundles, agent reviewers. |

This repository is published while work continues; each new piece lands after its tests and an independent review.

## Run it

Needs Node.js 24.15 or later. Nothing is installed globally, and nothing outside the repository is touched.

```sh
cd core
npm ci
npm run check      # typecheck and the full test suite (temporary folders only)
npm run perf       # a generated 10,000-skill catalog: open, publish, search, read timings
```

## Read more

- [Architecture](docs/architecture.md): the shape, the parts, and the alternatives we weighed
- [Decisions](docs/decisions.md): what was chosen, what else was considered, why, and who decided
- [The contract](docs/contract.md): operations, data, rules and errors
- [Requirements](docs/requirements.md): each requirement, where it lives, and the test that checks it
- [How we test](qa/qa-plan.md): oracles, golden sets, test layers
- [Agent experience](docs/agent-experience.md): what we measured with real assistants
- [The owner's notes on the PRD](docs/prd/notes.md) and [how we worked](docs/how-we-worked.md)
