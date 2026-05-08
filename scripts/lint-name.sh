#!/bin/sh
# Brand-name guard (#494).
#
# Canonical capitalization is "Clawterm". `ClawTerm` (capital T) is wrong
# and tends to creep back in via auto-capitalization or copy-paste. The
# brand book at docs/brand.md is the only file allowed to mention
# `ClawTerm` (it documents the rule).

set -eu

violations=$(grep -rn "ClawTerm" \
  --include="*.md" --include="*.ts" --include="*.tsx" \
  --include="*.json" --include="*.toml" --include="*.html" --include="*.css" \
  --include="*.rs" --include="*.yml" --include="*.yaml" \
  --exclude-dir=node_modules --exclude-dir=target --exclude-dir=dist \
  --exclude-dir=.git --exclude-dir=.clawterm-worktrees \
  . 2>/dev/null | grep -v '^./docs/brand\.md:' || true)

if [ -n "$violations" ]; then
  echo "❌ Use 'Clawterm' (lowercase t) — see docs/brand.md:" >&2
  echo "$violations" >&2
  exit 1
fi

echo "✓ Brand name is consistently 'Clawterm'"
