# Our thinking

The PRD says: "We care more about your thinking than about how much you ship." This page answers the questions it leaves to the builder.

| Question | Short answer | |
|---|---|---|
| What's most valuable once the core loop works? (Q1) | **Draft, awaiting the owner's ranking.** The candidates, unranked | [↓](#q1-the-most-valuable-additions-draft) |
| What did we cut, and why? | A web page, bundles, agent reviewers, de-duplication, a catalog shared through a synced folder | [↓](#what-we-cut-and-why) |
| The ~4-hour time box? | We went well past it. The 4-hour core is the part that runs first, with no account and no server | [↓](#the-4-hour-time-box) |
| Why build sign-in, when the PRD puts it out of scope (D3)? | Only for the hosted catalog, which is opt-in. The local loop needs no account | [↓](#beyond-the-prd) |
| What does "phase 2" mean here? | One thing: what comes after the MVP | [↓](#one-meaning-of-phase-2) |

## Q1: the most valuable additions (draft)

> [!IMPORTANT]
> **Waiting for the owner.** The PRD gives Q1 to the builder, and here the owner answers it. Until they do, this section lists the candidates our docs already name, in no order. It is not a ranking.

| Candidate | The gap it closes | Where it stands |
|---|---|---|
| More assistants: pi, then Copilot, Codex, Cursor, Gemini CLI | D1 makes the assistant the way in, and today only Claude Code is wired | pi is phase 2; the others phase 3, each after the owner's yes |
| One install for every assistant on a machine | Each assistant would otherwise need its own setup | Phase 2, designed |
| Search by meaning | Search matches keywords; a paraphrase works only when the assistant rewords it. On our golden asks: 54 of 55 found, 17 of 55 shown as a match, 9 of 9 no-match asks answered "nothing matches" | Keyword search with a short synonym list; the index rebuilds from stored versions, so a switch needs no migration |
| Agent reviewers | The rules reviewer catches patterns; judging a skill's quality takes an agent | The reviewer is pluggable; the rules reviewer ships |
| Bundles | Some skills only make sense together | Later |
| A web page with a delta view | People see what changed between versions only in a terminal or through the assistant | `skills-catalog serve` serves the API on this machine; no page yet |
| De-duplication of similar skills | The PRD's other deferred item (§8) | Not built; publishing identical content to the latest version changes nothing |
| A team catalog without AWS | A folder catalog is safe on one machine only | Not built: one machine would run `serve` on the network, as SQLite's own docs advise |
| Usage across a team | `skills-catalog stats` counts use on one machine only | Usage metrics are in phase 2; the count on one machine is built |
| Agent-level checks that run on their own | 17 checks with a real assistant are run by hand today | The runner can't seed its starting catalog yet |

## What we cut, and why

| Cut | Why | Where it stands |
|---|---|---|
| A web page (and its delta view) | The PRD's access path is the assistant (D1); a page adds nothing to the core loop | Later; the API it would use is built |
| Bundles, agent reviewers | The owner's choice: finish and ship what was in flight first | Later |
| De-duplication | Out of scope in the PRD (D3) | Not built |
| A catalog in a shared or synced folder across machines | Not safe: SQLite's WAL mode doesn't work across machines, and a synced folder can lose a version silently | Withdrawn. One machine per folder catalog; a team uses the hosted catalog. Setup warns about a catalog in a synced or network folder |
| Search by meaning | Needs a model or a service to run and pay for; keywords plus the assistant's rewording measured well enough to start | Next, when measurement says so |

## The 4-hour time box

The PRD frames this as a ~4-hour exercise: "a smaller, coherent, working system beats a larger broken one." We went well past it. A team of AI agents built this over several days for the owner ([how we worked](how-we-worked.md)).

What we did so that the time box still reads clearly:

- **The 4-hour core runs first.** A local catalog, the assistant's tools, versions and history, with no account and no server. The README's first try (`npm run try-it`) runs just that, in about a minute, and shows every PRD item as a scene.
- **Everything beyond the core is opt-in.** The hosted catalog in AWS is off by default. Guided setup, held updates and reviews sit around the core loop, not inside it.
- **What the README shows is real.** Its copies of what the commands print are checked against real runs by `npm run check`, and its PRD table links each item to the requirement that lists its tests.

## Beyond the PRD

The PRD puts authentication and access control out of scope (§8, D3): "Assume a trusted set of developers." Two things here go further, on purpose.

| Added | Why | Off by default? |
|---|---|---|
| **Only a skill's first publisher publishes its new versions** | D2: "don't overwrite silently." Without it, any teammate's publish would replace someone else's skill. Signing in isn't permission to change someone else's skill | It's on, locally too. Locally, who you act as is a demo label (your login name), not security |
| **GitHub sign-in and personal tokens on the hosted catalog** | A hosted catalog has an address on the internet; that is not a trusted set of developers | Yes. The hosted catalog is opt-in; the local catalog needs no account |

## One meaning of "phase 2"

**Phase 2**, everywhere in these docs, is the PRD's Phase 2: what comes after the MVP. What goes in it, and in what order, is the answer to Q1 above. "Phase 3" items (the other assistants) come after it.
