<!-- Written by `npm run setup-doc` in client/ from the words file and setup's question table. Don't edit by hand. -->

# Skills Catalog

Find, share and keep up to date the skills your team's assistants use.

## Set up

One command, with a guided setup:

    skills-catalog setup

It asks a few questions (automatic updates, where the catalog lives, which assistant uses it, your name here) and sets
everything up on this machine. Nothing goes to the cloud. To remove what it added to your assistant: `skills-catalog teardown`.

Or hand it to your assistant:

> Set up our team's Skills Catalog on this machine: run `skills-catalog setup` and ask me the questions it prints.

In a hurry? Every default (automatic updates on, a local catalog, Claude Code):

> Set up our team's Skills Catalog on this machine with the defaults: run `skills-catalog setup --yes`.

**Assistants:** run `skills-catalog setup` yourself. Without a terminal it changes nothing and prints its questions, each with the
flag that answers it. Ask the person, then run it again with their answers, or with `--yes` to take every default.

## The questions, and the flag that answers each

| Question | Flag | Default |
|---|---|---|
| Keep installed skills up to date automatically? Updates that could change what runs on this machine still wait for you. | `--auto-update yes\|no` | yes |
| Where should the catalog live? | `--catalog <folder>` | a local folder, ~/.skills-catalog/catalog |
| Which assistant should use it? | `--for claude-code` | Claude Code, for you in every project |
| Your name as a developer here (lowercase letters, digits and hyphens)? The catalog shows it as who published what. | `--me <name>` | your login, made into a name |
| Add two demo developers, dev1 and dev2, to try it? | `--demo-developers` | no |
| Add the skills-catalog command to your terminal? Setup puts a two-line launcher in ~/.local/bin, never over a file already there. | `--terminal-command yes\|no` | yes |

Also: `--config <file>` (a JSON file with config.json's keys, the same answers as the flags), `--dry-run` (the plan, nothing changed), `--print-mcp-entry` (the entry for another MCP client). Exit 0 done, 1 refused (nothing changed), 3 needs answers. Undo with `skills-catalog teardown`.
