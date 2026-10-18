#!/usr/bin/env node
/**
 * Framework conformance checker for TCOE-Playwright-Framework.
 *
 * This is the machine-checkable half of the "Stage 8c — Checklist" section in
 * TCOE-Playwright-Framework/.github/skills/update-playwright-test/SKILL.md.
 *
 * Why it exists: the Playwright generator agent writes idiomatic Playwright, which
 * violates this framework's conventions on every line. The checklist in the skill is
 * prose and easy to half-follow, so this script fails on the violations instead of
 * hoping the agent re-read the doc.
 *
 * It runs with plain `node --experimental-strip-types` — no dependency on a bundler.
 *
 * Usage:
 *   node --experimental-strip-types packages/cli/src/conformance.ts                 (all specs in tests/)
 *   node --experimental-strip-types packages/cli/src/conformance.ts path.spec.ts    (a specific file)
 *   node --experimental-strip-types packages/cli/src/conformance.ts --json
 *
 * Exit codes: 0 when every checked file is conformant, 1 otherwise.
 */

import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/**
 * Files that are scaffolding rather than tests and are therefore excluded from the
 * default scan. tests/seed.spec.ts is a Playwright MCP harness file whose imports are
 * required for the generator agent's <seed-file> flow, so checking it here would flag
 * code that must stay as-is.
 */
const DEFAULT_EXCLUDES = ['tests/seed.spec.ts']

/** A single finding. */
export interface Violation {
  /** Stable rule id, e.g. "fixture-import". */
  ruleId: string
  /** Repo-relative path of the offending file. */
  file: string
  /** 1-based line number, or 0 when unknown. */
  line: number
  /** Short rule label. */
  rule: string
  /** What is wrong and why it matters. */
  detail: string
  /** How to fix it. */
  fix: string
}

export interface ConformanceReport {
  root: string
  checked: string[]
  violations: Violation[]
  pass: boolean
}

export interface ConformanceOptions {
  /** Repo root. Defaults to process.cwd(). */
  root?: string
  /** Explicit paths to check. Empty means: scan tests/ recursively. */
  paths?: string[]
  /**
   * Base for resolving explicitly named paths. Defaults to root — the library
   * convention, where a path like 'tests/seed.spec.ts' means root/tests/….
   * The CLI passes process.cwd() instead, because a path on the command line is
   * relative to where you stood, which may be a different repo than root.
   */
  pathsBase?: string
}

export function checkConformance(opts: ConformanceOptions = {}): ConformanceReport {
  const root = resolve(opts.root ?? process.cwd())

  const explicit = opts.paths && opts.paths.length > 0 ? opts.paths : []
  // Two bases, deliberately distinct. Explicit paths resolve against pathsBase, which
  // the CLI sets to the caller's cwd because a path on the command line is relative to
  // where you stood. Discovered specs resolve against root, which is also the base
  // everything is reported relative to. Collapsing these is what originally sent
  // explicit paths into the wrong tree.
  const base = resolve(opts.pathsBase ?? root)
  const targets = [
    ...explicit.map((p) => resolve(base, p)),
    ...(explicit.length > 0 ? [] : discoverSpecs(root).map((p) => resolve(root, p))),
  ]
  const checked = targets.map((abs) => relative(root, abs).replace(/\\/g, '/'))
  const violations: Violation[] = []

  for (let i = 0; i < targets.length; i++) {
    const repoRel = checked[i]!
    let src: string
    try {
      src = readFileSync(targets[i]!, 'utf-8')
    } catch (err) {
      violations.push({
        ruleId: 'read-error',
        file: repoRel,
        line: 0,
        rule: 'Could not read file',
        detail: `Failed to read "${repoRel}": ${(err as Error).message}`,
        fix: 'Check that the path is inside the repo and readable.',
      })
      continue
    }
    violations.push(...checkSource(repoRel, src))
  }

  violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)))

  return { root, checked, violations, pass: violations.length === 0 }
}

function discoverSpecs(root: string): string[] {
  const out: string[] = []
  const testsDir = join(root, 'tests')
  let entries: Dirent<string>[]
  try {
    entries = readdirSync(testsDir, { withFileTypes: true })
  } catch {
    return out
  }
  walk(testsDir, (abs) => {
    const name = abs.split(/[\\/]/).pop() ?? ''
    if (/\.(spec|test)\.ts$/.test(name)) out.push(relative(root, abs).replace(/\\/g, '/'))
  }, entries)
  return out.filter((f) => !DEFAULT_EXCLUDES.includes(f))
}

function walk(dir: string, visit: (abs: string) => void, entries: { name: string; isDirectory(): boolean }[]): void {
  for (const e of entries) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) {
      let sub: { name: string; isDirectory(): boolean }[]
      try {
        sub = readdirSync(abs, { withFileTypes: true })
      } catch {
        continue
      }
      walk(abs, visit, sub)
    } else if (e.name) {
      visit(abs)
    }
  }
}

/* ------------------------------------------------------------------ */
/* The checks                                                          */
/* ------------------------------------------------------------------ */

type FileKind = 'spec' | 'page' | 'locator' | 'unknown'

function classifyFile(path: string): FileKind {
  const name = path.split(/[\\/]/).pop() ?? ''
  if (name.endsWith('.spec.ts') || name.endsWith('.test.ts')) return 'spec'
  if (name.endsWith('.locators.ts')) return 'locator'
  if (name.endsWith('.page.ts')) return 'page'
  return 'unknown'
}

/**
 * A rule has two parts, and keeping them separate is what prevents false positives:
 *
 *   tokenRe — where a candidate *might* be. Narrow. It locates a syntactic shape.
 *   match   — whether that candidate is actually wrong. It can look around the match,
 *             and returning null means "this is fine, ignore it".
 *
 * Without `match`, a token like `import` would flag every import statement in the file,
 * including the correct `import { test, expect } from '@src/config/fixture'` — which is
 * the framework's own first line in tests/example.spec.ts.
 */
interface Rule {
  id: string
  rule: string
  detail: string
  fix: string
  /** Which file shapes this rule applies to. */
  appliesTo: FileKind[]
  /** Locate candidate positions. Must be a global regex. */
  tokenRe: RegExp
  /** Validate a candidate; null means it is not a violation. */
  match(src: string, idx: number): string | null
}

export const RULES: Rule[] = [
  {
    id: 'fixture-import',
    rule: 'Import test/expect from the framework fixture',
    detail:
      'Specs import { test, expect } from the framework fixture, not @playwright/test. ' +
      'The fixture provides the shared context, action helpers and custom reporter wiring.',
    fix: "import { test, expect } from '@src/config/fixture'",
    appliesTo: ['spec'],
    // Only the bad import is a candidate; anything else is ignored outright.
    tokenRe: /from\s*['"]@playwright\/test['"]/g,
    match(src, idx) {
      // A commented-out import is documentation, not a live violation.
      if (charContext(src, idx) !== 'code') return null
      return '@playwright/test'
    },
  },
  {
    id: 'no-wait-timeout',
    rule: 'No waitForTimeout',
    detail:
      'Fixed sleeps mask race conditions and slow every run down. Wait on the state you ' +
      'actually care about instead.',
    fix: 'await expect(...).toBeVisible(), or an explicit waitUntil* for a concrete condition.',
    appliesTo: ['spec', 'page', 'locator'],
    tokenRe: /\bwaitForTimeout\s*\(/g,
    match(src, idx) {
      // Only count real code — a commented-out call or a string mentioning it is not a bug.
      if (charContext(src, idx) !== 'code') return null
      return 'waitForTimeout('
    },
  },
  {
    id: 'no-test-only',
    rule: 'No test.only',
    detail:
      'test.only silently skips the rest of the suite. It is almost always a debugging ' +
      'leftover rather than intent.',
    fix: 'Remove .only.',
    appliesTo: ['spec'],
    tokenRe: /\btest\.only\b/g,
    match(src, idx) {
      if (charContext(src, idx) !== 'code') return null
      return 'test.only'
    },
  },
  {
    id: 'no-hardcoded-url',
    rule: 'No hardcoded URLs',
    detail:
      'Environment URLs belong in config or test data. A literal URL ties the test to one ' +
      'environment and cannot be shared.',
    fix: 'Resolve the URL via ConfigManager / test-data instead of a literal.',
    appliesTo: ['spec', 'page'],
    tokenRe: /https?:\/\/\S+/g,
    match(src, idx) {
      const ctx = charContext(src, idx)
      // Only a literal string is actionable — code that actually runs. A URL in a
      // comment or docstring is documentation, and flagging it just trains people to
      // ignore the checker.
      if (ctx !== 'string') return null
      return 'literal URL'
    },
  },
  {
    id: 'no-page-direct',
    rule: 'No inline page.locator() in specs',
    detail:
      'Selectors belong in the *.locators.ts class as named readonly fields, so specs refer ' +
      'to them by name rather than re-declaring a selector inline.',
    fix: 'Move the selector to pages/**/…locators.ts and reference it by name.',
    appliesTo: ['spec'],
    tokenRe: /\bpage\s*\.\s*locator\s*\(/g,
    match(src, idx) {
      if (charContext(src, idx) !== 'code') return null
      return 'page.locator('
    },
  },
]

/**
 * What syntactic context sits at character `idx`?
 *
 * One forward pass tracking string and comment state. Cheap and good enough: this is a
 * linter, not a parser, and the only thing it must get right is telling a live `import`
 * from a commented-out or documented one.
 *
 *   'code'         — ordinary source
 *   'string'       — inside a ' " or ` literal (a real, executed string)
 *   'comment'      — inside a line or block comment (documentation, never a violation)
 *
 * Handles escapes; does not handle template-literal expression holes, which is acceptable
 * because a backtick string is still not code.
 */
export type CharContext = 'code' | 'string' | 'comment'

export function charContext(src: string, idx: number): CharContext {
  let state: CharContext = 'code'
  let quote = ''
  // A comment never ends on its own, so remember which kind opened it to know how to close.
  let commentKind: 'line' | 'block' | null = null
  let escaped = false

  for (let i = 0; i < idx && i < src.length; i++) {
    const c = src[i]!
    const next = src[i + 1] ?? ''

    // Escapes only matter inside strings; in code or comments a backslash is just a
    // character, and treating it as an escape here could swallow a comment terminator.
    if (escaped) {
      escaped = false
      continue
    }
    if (c === '\\' && state === 'string') {
      escaped = true
      continue
    }

    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'comment'
        commentKind = 'line'
      } else if (c === '/' && next === '*') {
        state = 'comment'
        commentKind = 'block'
      } else if (c === '"' || c === "'" || c === '`') {
        state = 'string'
        quote = c
      }
    } else if (state === 'string') {
      if (c === quote) state = 'code'
    } else if (state === 'comment') {
      if (commentKind === 'line') {
        if (c === '\n') state = 'code'
      } else if (c === '*' && next === '/') {
        state = 'code'
      }
    }
  }

  return state
}

/**
 * Check one file. `src` is raw file content; each rule decides for itself whether its
 * token is real code or just a comment/string, via charContext.
 */
export function checkSource(path: string, src: string): Violation[] {
  const kind = classifyFile(path)
  const violations: Violation[] = []

  for (const rule of RULES) {
    if (!rule.appliesTo.includes(kind)) continue

    for (const m of src.matchAll(rule.tokenRe)) {
      const idx = m.index ?? 0
      const where = rule.match(src, idx)
      if (where === null) continue
      violations.push({
        ruleId: rule.id,
        file: path,
        line: lineAt(src, idx),
        rule: rule.rule,
        detail: `${rule.detail} (${where})`,
        fix: rule.fix,
      })
    }
  }

  return violations
}

function lineAt(src: string, idx: number): number {
  let n = 1
  for (let i = 0; i < idx; i++) if (src[i] === '\n') n++
  return n
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

export interface CliArgs {
  root: string
  paths: string[]
  asJson: boolean
}

export function parseArgs(argv: string[], defaultRoot: string): CliArgs {
  let asJson = false
  let root = defaultRoot
  const paths: string[] = []

  // Flags are consumed in place rather than filtered by string equality: without --root,
  // argv[0] is a path, and filtering by the root value's position would drop the very
  // file the caller asked to check.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--json') asJson = true
    else if (a === '--root') {
      const v = argv[++i]
      if (v && !v.startsWith('--')) root = v
    } else if (a.startsWith('--')) {
      // Unknown flag: ignore rather than treating it as a path.
    } else paths.push(a)
  }

  return { root, paths, asJson }
}

/**
 * Exit code for a report:
 *   0 — files checked, all conformant
 *   1 — at least one violation
 *   2 — nothing was checked. A mistyped --root or path would otherwise produce a
 *       clean-looking PASS, which is a green build on nothing.
 */
export function reportExitCode(report: ConformanceReport): number {
  if (report.checked.length === 0) return 2
  return report.pass ? 0 : 1
}

export function main(argv: string[]): number {
  const { root, paths, asJson } = parseArgs(argv, process.cwd())

  const report = checkConformance({ root, paths, pathsBase: process.cwd() })
  const exitCode = reportExitCode(report)

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`Conformance check — root: ${report.root}`)
    console.log(`Files checked: ${report.checked.length}`)
    if (exitCode === 2) {
      console.log('')
      console.log('ERROR: nothing was checked — no .spec.ts/.test.ts files were found.')
      console.log('  A mistyped --root or path silently produces a clean-looking PASS,')
      console.log(`  so fail instead. Looked under: ${report.root}`)
      console.log('  Pass --root <framework checkout> or an explicit spec path.')
      return 2
    }
    if (report.violations.length === 0) {
      console.log('PASS: no violations found.')
    } else {
      for (const v of report.violations) {
        console.log(`  ${v.file}${v.line ? ':' + v.line : ''}  [${v.ruleId}] ${v.rule}`)
        console.log(`      ${v.detail}`)
        console.log(`      fix: ${v.fix}`)
      }
      console.log(`FAIL: ${report.violations.length} violation(s).`)
    }
  }

  return exitCode
}

// Runs the CLI only when this file was executed directly, not imported by a test.
// Comparing basenames rather than full paths keeps it working under npm scripts, where
// process.argv[1] may be a relative path and import.meta.url is always absolute.
const invoked = process.argv[1]
const selfName = new URL(import.meta.url).pathname.split(/[\\/]/).pop() ?? ''
if (invoked && (invoked.replace(/\\/g, '/').split('/').pop() === selfName)) {
  const code = main(process.argv.slice(2))
  if (code !== 0) process.exitCode = code
}
