#!/bin/sh
# Checks that a commit message follows Conventional Commits (https://www.conventionalcommits.org):
#   <type>[(scope)][!]: <description>
# Used by the commit-msg hook (.githooks) and by CI. Usage: check-commit-msg.sh <message-file>
first=$(head -n 1 "$1" | tr -d '\r')
case "$first" in
  "Merge "* | "Revert "* | "fixup! "* | "squash! "* | "amend! "*) exit 0 ;;
esac
types='feat|fix|perf|refactor|docs|style|test|build|ci|chore|revert'
if printf '%s\n' "$first" | grep -Eq "^($types)(\([A-Za-z0-9._/-]+\))?!?: [^ ]"; then
  exit 0
fi
cat >&2 <<MSG
"$first" is not a Conventional Commit. Use

  <type>[(scope)][!]: <description>

with type one of: $(printf '%s' "$types" | tr '|' ' '). Examples:

  feat(preview): render Mermaid diagrams
  fix: keep the cursor when reloading a file
  feat!: drop the old settings format     (breaking change)
MSG
exit 1
