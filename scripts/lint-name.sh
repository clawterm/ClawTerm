#!/bin/sh
# Brand-name guard.
#
# Canonical capitalization is "ClawTerm" (capital T). The old "Clawterm"
# form is wrong and tends to creep back in via auto-capitalization or
# copy-paste of historical strings.
#
# Exempt files:
# - docs/brand.md documents both spellings explicitly.
# - CHANGELOG.md preserves shipped release notes intact.
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
  | grep -Ev '^\./(docs/brand|CHANGELOG)\.md:' \
  || true)

if [ -n "$violations" ]; then
  echo "❌ Use 'ClawTerm' (capital T) — see docs/brand.md:" >&2
  echo "$violations" >&2
  exit 1
fi

echo "✓ Brand name is consistently 'ClawTerm'"
