#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DESKTOP_DIR = path.resolve(PROJECT_ROOT, '..');
const RELEASE_OUTPUT_DIR = path.join(DESKTOP_DIR, 'SE-AiProxy Release');
const RELEASE_DIR = path.join(RELEASE_OUTPUT_DIR, 'SE-AiProxy');

// 1. Read version from package.json
const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
const version = pkg.version || '1.0.0';

console.log(`\n======================================================`);
console.log(`  Building Release Packages for Version v${version}`);
console.log(`======================================================\n`);

// 2. Clean and re-create release directory
console.log('[1/4] Preparing clean distribution directory...');
if (fs.existsSync(RELEASE_DIR)) {
  fs.rmSync(RELEASE_DIR, { recursive: true, force: true });
}
fs.mkdirSync(RELEASE_DIR, { recursive: true });

// 3. Sync clean files excluding tests, local env, and private data
console.log('[2/4] Syncing production assets...');
execSync(`rsync -av \
  --exclude 'node_modules' \
  --exclude 'data' \
  --exclude 'test' \
  --exclude 'scripts' \
  --exclude '.git' \
  --exclude '.env' \
  --exclude '*.log' \
  --exclude '.claude-launch-tmp' \
  "${PROJECT_ROOT}/" "${RELEASE_DIR}/"`, { stdio: 'pipe' });

// 4. Create isolated empty template data/config.json
const dataDir = path.join(RELEASE_DIR, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const cleanTemplate = {
  tokens: [],
  proxyKeys: [],
  settings: {
    contextWindow: 1048576,
    autoCompactLimit: 400000,
    sessionRotateChars: 180000,
    fullPromptMaxChars: 120000
  }
};
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(cleanTemplate, null, 2) + '\n', 'utf8');

// 5. Build zip packages
console.log('[3/4] Creating versioned distribution archives...');
const zipNames = [`SE-AiProxy-v${version}.zip`];

fs.mkdirSync(RELEASE_OUTPUT_DIR, { recursive: true });

for (const name of zipNames) {
  const targetZip = path.join(RELEASE_OUTPUT_DIR, name);
  if (fs.existsSync(targetZip)) {
    fs.rmSync(targetZip);
  }
  execSync(`cd "${RELEASE_OUTPUT_DIR}" && zip -r -q "${name}" "SE-AiProxy"`, { stdio: 'pipe' });
  const stats = fs.statSync(targetZip);
  const kb = (stats.size / 1024).toFixed(1);
  console.log(`   [OK] Created ${name} (${kb} KB)`);
}

console.log(`\n======================================================`);
console.log(`[SUCCESS] Release build completed for v${version}!`);
console.log(`Archives generated at:`);
for (const name of zipNames) {
  console.log(`  -> ${path.join(RELEASE_OUTPUT_DIR, name)}`);
}
console.log(`======================================================\n`);
