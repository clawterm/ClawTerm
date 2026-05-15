#!/bin/sh
# Brand-name guard (#494, #524).
#
# Canonical capitalization is "ClawTerm" (capital T). The old "Clawterm"
# form is wrong and tends to creep back in via auto-capitalization or
# copy-paste of historical strings. The brand book at docs/brand.md
# is the only file allowed to mention `Clawterm` (it documents the rule).
# Shipped CHANGELOG.md entries are exempt too — they're historical
# release notes and should not be retroactively rewritten.
#
# Lowercase `clawterm` is fine in identifier-safe contexts (paths, URLs,
# package names, bundle ids, CSS class names) so the match is word-bounded
# and targets only docs/UI file extensions.

set -eu

violations=$(grep -rwn "Clawterm" \
  --include="*.md" --include="*.ts" --include="*.tsx" \
  --include="*.json" --include="*.toml" --include="*.html" --include="*.css" \
  --include="*.yml" --include="*.yaml" \
  --exclude-dir=node_modules --exclude-dir=target --exclude-dir=dist \
  --exclude-dir=.git --exclude-dir=.clawterm-worktrees --exclude-dir=.claude \
  --exclude-dir=gen \
  . 2>/dev/null \
  | grep -v '^\./docs/brand\.md:' \
  | grep -v '^\./CHANGELOG\.md:' \
  || true)

if [ -n "$violations" ]; then
  echo "❌ Use 'ClawTerm' (capital T) — see docs/brand.md:" >&2
  echo "$violations" >&2
  exit 1
fi

echo "✓ Brand name is consistently 'ClawTerm'"
