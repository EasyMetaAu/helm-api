#!/bin/bash

# Auto-translate the admin SPA locale files (Contrack i18n pattern).
# Pipeline: extract $t() keys -> en.json, propagate keys to every locale,
# then AI-translate each target with the `translator` CLI against an
# OpenAI-compatible endpoint. Already-translated keys are left untouched
# (incremental). Helm admin ships 7 locales: en, zh-hans, zh-hant, ja, ko, es, pt.

# API config (override via env). Default points at the self-hosted relay.
export OPENAI_API_ENDPOINT="${OPENAI_API_ENDPOINT:-http://192.168.199.7:3001/v1}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-local}"

# The `translator` CLI always loads a .env file and errors if it is missing.
# Generate a dedicated one (config only — no project secrets) and pass it via -e
# so this works without a project-level .env. The file is gitignored.
ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.translator.env"
cat >"$ENV_FILE" <<EOF
OPENAI_API_ENDPOINT=${OPENAI_API_ENDPOINT}
OPENAI_API_KEY=${OPENAI_API_KEY}
EOF

# Translation model + batch size (keys per request).
TRANSLATOR_MODEL="${TRANSLATOR_MODEL:-gpt-5.2:high}"
BATCH="${TRANSLATOR_BATCH:-500}"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_status() { echo -e "${GREEN}[✓]${NC} $1"; }
print_error() { echo -e "${RED}[✗]${NC} $1"; }
print_info() { echo -e "${YELLOW}[i]${NC} $1"; }

# Extract and update i18n strings first (so new $t() keys are present in every
# locale before translating).
print_info "Extracting i18n strings..."
if pnpm run i18n:extract; then
  print_status "i18n strings extracted"
else
  print_error "i18n extraction failed"
  exit 1
fi

print_info "Updating locale files..."
if pnpm run i18n:update; then
  print_status "Locale files updated"
else
  print_error "Locale update failed"
  exit 1
fi

# Languages to translate. zh-hant is derived from zh-hans (Simplified ->
# Traditional); the rest translate from English.
declare -a languages=(
  "en:zh-hans"      # English -> Simplified Chinese
  "zh-hans:zh-hant" # Simplified -> Traditional Chinese
  "en:ja"           # Japanese
  "en:ko"           # Korean
  "en:es"           # Spanish
  "en:pt"           # Portuguese
)

translate_language() {
  local source_lang=$1
  local target_lang=$2
  local source_file="./src/locales/${source_lang}.json"

  print_info "Translating ${source_lang} -> ${target_lang}..."
  if translator -m "$TRANSLATOR_MODEL" -i "$source_file" -l "$target_lang" -b "$BATCH" -e "$ENV_FILE"; then
    print_status "${target_lang} translation completed"
    return 0
  else
    print_error "${target_lang} translation failed"
    return 1
  fi
}

total=${#languages[@]}
success=0
failed=0
failed_langs=()

print_info "Starting batch translation of ${total} languages..."
echo ""

for lang_pair in "${languages[@]}"; do
  IFS=':' read -r source target <<<"$lang_pair"
  if translate_language "$source" "$target"; then
    ((success++))
  else
    ((failed++))
    failed_langs+=("$target")
  fi
  echo -e "${YELLOW}Progress: ${success}/${total} completed${NC}"
  echo ""
done

echo "================================"
print_info "Translation task completed!"
print_status "Success: ${success} languages"

if [ ${failed} -gt 0 ]; then
  print_error "Failed: ${failed} languages"
  if [ ${#failed_langs[@]} -gt 0 ]; then
    echo -e "${RED}Failed languages:${NC} ${failed_langs[*]}"
  fi
  echo ""
  echo "You can manually retry failed languages:"
  for lang in "${failed_langs[@]}"; do
    if [ "$lang" = "zh-hant" ]; then
      echo "  translator -m $TRANSLATOR_MODEL -i ./src/locales/zh-hans.json -l zh-hant -b $BATCH"
    else
      echo "  translator -m $TRANSLATOR_MODEL -i ./src/locales/en.json -l $lang -b $BATCH"
    fi
  done
  exit 1
else
  print_status "All languages translated successfully!"
fi

echo "================================"
