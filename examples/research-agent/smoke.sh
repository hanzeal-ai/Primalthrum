#!/usr/bin/env bash
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="$DEMO_DIR/agent.config.json"
DOCUMENT_PATH="$DEMO_DIR/documents/research-brief.md"

CONFIG_PATH="$CONFIG_PATH" DOCUMENT_PATH="$DOCUMENT_PATH" node <<'NODE'
const fs = require('node:fs')

const config = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, 'utf8'))
const document = fs.readFileSync(process.env.DOCUMENT_PATH, 'utf8')

const requiredStringFields = ['name', 'description', 'memoryProvider', 'cacheProvider', 'ragProvider']
for (const field of requiredStringFields) {
  if (typeof config[field] !== 'string' || config[field].trim() === '') {
    throw new Error(`missing config field: ${field}`)
  }
}

for (const field of ['enabledTools', 'enabledSkills']) {
  if (!Array.isArray(config[field]) || config[field].length === 0) {
    throw new Error(`missing non-empty config array: ${field}`)
  }
}

if (!config.modelConfig?.default?.provider || !config.modelConfig?.embedding?.provider) {
  throw new Error('modelConfig must include default and embedding providers')
}

if (!document.includes('Launch Readiness Research Brief')) {
  throw new Error('document fixture heading not found')
}

console.log('demo research agent smoke ok')
NODE
