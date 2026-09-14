#!/bin/bash
# Is anything in the program corpus FROZEN that should be decided at run time? A program must not bake in a
# date, a specific entity's id, or a value that varies from one asking to the next.
#
# Findings go in vm/AUTHORING_OBSERVATIONS.jsonl — a LOG, not a rulebook. One sighting is an anecdote and says
# nothing about where a fix belongs; several of a kind say whether it wants a prompt line, an example, a check,
# or nothing. Acting on the first sighting is how a generic engine fills with rules about one dataset.
#
# One JSON object per line:
#   at        when it was seen
#   project   which project's workspace
#   source    which data source it came through
#   category  the KIND — this is the field that matters, because counting it is the whole point
#   program   which program, or a family (pl-revenue-*)
#   where     file:line
#   observed  the thing itself, quoted
#   why       what makes it a drift, and where a fix would belong IF it earns one
#   evidence  how it was established — a query, a count, this scan
#   acted     false unless something was changed, then `action` says what
#
#   count by category:  jq -r .category vm/AUTHORING_OBSERVATIONS.jsonl | sort | uniq -c | sort -rn
#
#   usage: vm/tools/authoring-scan.sh [workspace]     (default: the first project under ~/.superatom/state)
set -u
# The first workspace that actually HAS programs — a project can exist with none, and defaulting
# to an empty one just looks like a clean scan.
WS="${1:-$(for d in "${ENGINE_STATE_DIR:-$HOME/.superatom/state}"/*/workspace; do [ -d "$d/programs" ] && ls "$d/programs" >/dev/null 2>&1 && [ -n "$(ls -A "$d/programs" 2>/dev/null)" ] && echo "$d" && break; done)}"
cd "$WS/programs" 2>/dev/null || { echo "no programs under $WS"; exit 1; }
echo "scanning $WS/programs — $(ls -d */ 2>/dev/null | wc -l | tr -d ' ') programs"
echo

# Examples are excluded everywhere: they are reference material, written to be read.
say() { echo; echo "── $1"; }
none() { echo "   (nothing above = clean)"; }

say "FROZEN DATES — a literal date cannot move with the calendar"
grep -rnoE "['\"][0-9]{4}-[0-9]{2}-[0-9]{2}['\"]|['\"][0-9]{2}/[0-9]{2}/[0-9]{4}['\"]" */program.ts */units/*.ts 2>/dev/null | grep -v "example\." | head -12
none
echo "   NOTE a sentinel is not a violation: excluding a placeholder date that exists IN THE DATA is correct,"
echo "        as long as the real comparison uses asOf. Read the line before recording it."

say "FROZEN YEARS"
grep -rnoE "(===|==|:) ?20[0-9]{2}\b" */program.ts */units/*.ts 2>/dev/null | grep -v "example\." | head -8
none

say "A SPECIFIC ENTITY'S ID inside a filter — the program would answer for one thing only"
grep -rnE "=\s*'?[0-9]{5,}'?|IN \(\s*'?[0-9]{4,}" */program.ts */units/*.ts 2>/dev/null | grep -v "example\." | head -8
none

say "DEFAULTS — a default should say HOW TO CHOOSE ('the current week'), not WHAT WAS CHOSEN"
echo "   Read these: 'limit ?? 10' is a convention and fine; a list of account numbers is one asker's answer."
grep -rhoE "params\??\.[a-zA-Z]+ \?\? [^,;)]{1,60}" */program.ts */units/*.ts 2>/dev/null | grep -v "example\." | sort -u | head -20
