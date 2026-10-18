#!/usr/bin/env node
/**
 * Extension build: bundles the activation entry and the webview UI into a
 * self-contained `out/` tree, then optionally packages a .vsix.
 *
 * The bundle pulls in every workspace package and its npm dependencies, so the
 * packaged extension does not depend on the monorepo layout on the target
 * machine. Only `vscode` and Playwright stay external — the former is a host
 * builtin, the latter is the user's own install.
 */

import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = resolve(here, '..')
const repoRoot = resolve(extensionRoot, '..', '..')
const outDir = resolve(extensionRoot, 'out')

const args = new Set(process.argv.slice(2))
const packageOnly = args.has('--vsix')
const clean = args.has('--clean') || packageOnly

/**
 * Shared esbuild options for the extension-host side.
 *
 * Everything is bundled except `vscode` (a host builtin, always external) and
 * `@playwright/test` (the user's own install, which must not be frozen at build
 * time or the extension would silently run a stale Playwright).
 */
function hostOptions(options) {
  return {
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: true,
    logLevel: 'warning',
    external: ['vscode', '@playwright/test', '@playwright/test/*'],
    ...options,
  }
}

if (clean) {
  rmSync(outDir, { recursive: true, force: true })
}
mkdirSync(outDir, { recursive: true })

if (!existsSync(resolve(extensionRoot, 'src', 'main.ts'))) {
  console.error('apps/vscode-extension/src/main.ts not found')
  process.exit(1)
}

// The activation entry. This is the only file VS Code loads.
await build(
  hostOptions({
    entryPoints: [resolve(extensionRoot, 'src', 'main.ts')],
    outdir: outDir,
  }),
)

console.log('✓ extension host bundled')

// Package manifest and static assets are copied, not compiled.
const sourceFiles = ['package.json', 'tsconfig.json', 'README.md', 'CHANGELOG.md', 'LICENSE']
for (const f of sourceFiles) {
  const src = resolve(extensionRoot, f)
  if (existsSync(src)) cpSync(src, resolve(outDir, f))
}
for (const d of ['media', 'webview-ui']) {
  const src = resolve(extensionRoot, d)
  if (existsSync(src)) cpSync(src, resolve(outDir, d), { recursive: true })
}

if (packageOnly) {
  console.log('Packaging .vsix …')
  const vsce = resolve(repoRoot, 'node_modules', '@vscode', 'vsce', 'vsce')
  const result = spawnSync(process.execPath, [vsce, 'package', '--no-dependencies'], {
    cwd: extensionRoot,
    stdio: 'inherit',
    env: { ...process.env, NO_COLOR: '1' },
  })
  if (result.error) {
    console.error(
      '\n`vsce` was not found in the project dependencies.\n' +
        'Install it with `npm install --save-dev @vscode/vsce`, then re-run `npm run package:vsix`.',
    )
  }
  process.exit(result.status ?? 1)
}

process.exit(0)
