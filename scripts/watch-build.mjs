#!/usr/bin/env node
/**
 * watch-build.mjs
 *
 * Watches src/ and resources/ for changes, recompiles TypeScript, and
 * re-packages a fresh VSIX into dist/ automatically.
 *
 * Usage:  npm run watch-vsix
 */

import { spawn, execSync } from 'child_process';
import { watch } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Helpers ──────────────────────────────────────────────────────────────────

function timestamp() {
  return new Date().toLocaleTimeString();
}

function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

function run(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    log(`▶ ${cmd}`);
    const proc = spawn(cmd, { shell: true, cwd: ROOT, stdio: 'inherit', ...opts });
    proc.on('close', code => (code === 0 ? resolve() : reject(new Error(`Exit ${code}`))));
  });
}

// ── Build + package pipeline ──────────────────────────────────────────────────

let pending = false;
let running = false;

async function buildAndPackage() {
  if (running) {
    pending = true;
    return;
  }
  running = true;

  try {
    await run('npx tsc -p tsconfig.json');
    await run('npx @vscode/vsce package --allow-missing-repository --out dist/ --no-git-tag-version');
    log('✅ VSIX updated in dist/');
  } catch (err) {
    console.error(`❌ Build failed: ${err.message}`);
  } finally {
    running = false;
    if (pending) {
      pending = false;
      buildAndPackage();
    }
  }
}

// ── File watcher ─────────────────────────────────────────────────────────────

const WATCH_DIRS = [
  resolve(ROOT, 'src'),
  resolve(ROOT, 'resources'),
];

const DEBOUNCE_MS = 800;
let debounceTimer = null;

function scheduleRebuild(eventType, filename) {
  if (filename && (filename.endsWith('.ts') || filename.endsWith('.svg') || filename.endsWith('.json'))) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      log(`Changed: ${filename} — rebuilding…`);
      buildAndPackage();
    }, DEBOUNCE_MS);
  }
}

for (const dir of WATCH_DIRS) {
  watch(dir, { recursive: true }, scheduleRebuild);
  log(`👁  Watching ${dir}`);
}

// ── Initial build ─────────────────────────────────────────────────────────────

log('🚀 Starting initial build…');
buildAndPackage();
