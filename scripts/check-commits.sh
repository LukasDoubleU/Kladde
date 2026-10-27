#!/bin/sh
# Checks every commit message in a git revision range, e.g. scripts/check-commits.sh main..HEAD
set -e
status=0
tmp=$(mktemp)
for c in $(git rev-list --no-merges "$1"); do
  git log -1 --format=%B "$c" > "$tmp"
  if ! sh "$(dirname "$0")/check-commit-msg.sh" "$tmp"; then
    echo "  in commit $(git log -1 --format=%h "$c")" >&2
    status=1
  fi
done
rm -f "$tmp"
exit $status
