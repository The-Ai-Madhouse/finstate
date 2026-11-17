import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { finstateStorage } from './server/storage';

/** Versionsinfo bages ind ved build/start, så appen kan vise, præcis hvilken version der kører. */
function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const build = {
  version: pkg.version,
  commit: git('rev-parse --short HEAD') || 'ukendt',
  commitDate: git('log -1 --format=%cI'),
  buildNo: Number(git('rev-list --count HEAD')) || 0,
  dirty: git('status --porcelain') !== '',
  builtAt: new Date().toISOString(),
};

// Fast port for både dev og preview: localStorage er bundet til origin (protokol+host+port),
// så en anden port ville se ud som en tom app.
export default defineConfig({
  // Data gemmes i en fil på computeren (se server/storage.ts) – ikke kun i browseren.
  plugins: [react(), finstateStorage()],
  define: { __BUILD_INFO__: JSON.stringify(build) },
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  preview: { port: 5173, strictPort: true, host: '127.0.0.1' },
  test: { environment: 'node' },
});
