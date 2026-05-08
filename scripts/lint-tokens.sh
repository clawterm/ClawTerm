#!/bin/sh
# Layout/brand token guard (#493 Bucket 4, #494).
#
# Forbids hardcoded hex colors, numeric font-sizes, and numeric font-weights
# anywhere outside the :root token block in src/style.css. Once a value
# belongs in the design scale it should be defined in :root and referenced
# via var(--*) — otherwise the system rots back into "almost-systematic."

set -eu

CSS=src/style.css

# Strip comments and the entire :root block so token *definitions* don't
# trip the guard. Use a small awk filter rather than a separate file.
body=$(awk '
  BEGIN { in_root = 0; in_comment = 0 }
  /\/\*/ { in_comment = 1 }
  in_comment { if (/\*\//) in_comment = 0; next }
  /^:root[[:space:]]*\{/ { in_root = 1; next }
  in_root && /^\}/ { in_root = 0; next }
  !in_root { print }
' "$CSS")

violations=$(printf '%s\n' "$body" | grep -nE \
  -e '#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?\b' \
  -e 'font-size:[[:space:]]*[0-9.]+(px|em|rem)\b' \
  -e 'font-weight:[[:space:]]*[0-9]+\b' \
  || true)

if [ -n "$violations" ]; then
  echo "❌ Hardcoded design values found in $CSS — move into :root and reference via var(--*):" >&2
  echo "$violations" >&2
  exit 1
fi

echo "✓ $CSS uses tokens for all colors / font-sizes / font-weights"
