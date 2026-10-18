import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  checkConformance,
  checkSource,
  charContext,
  parseArgs,
  reportExitCode,
  RULES,
} from '../../packages/cli/src/conformance'

function write(repo: string, relPath: string, content: string): string {
  const abs = join(repo, relPath)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf-8')
  return relPath
}

function ids(violations: { ruleId: string }[]): string[] {
  return violations.map((v) => v.ruleId).sort()
}

let repo: string

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'tcoe-conform-'))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('fixture-import', () => {
  it('flags specs that import from @playwright/test', () => {
    const src = "import { test } from '@playwright/test'\n\ntest('x', () => {})\n"
    const v = checkSource('tests/foo.spec.ts', src)
    expect(ids(v)).toContain('fixture-import')
  })

  it('accepts the framework fixture import', () => {
    const src = "import { test, expect } from '@src/config/fixture'\n\ntest('x', () => {})\n"
    expect(ids(checkSource('tests/foo.spec.ts', src))).not.toContain('fixture-import')
  })

  it('does not fire on non-spec files', () => {
    const src = "import { test } from '@playwright/test'\n"
    expect(ids(checkSource('pages/login.page.ts', src))).not.toContain('fixture-import')
  })
})

describe('context awareness', () => {
  it('charContext identifies comments, strings and code', () => {
    expect(charContext('code()', 0)).toBe('code')
    expect(charContext('// x', 3)).toBe('comment')
    expect(charContext("let a = 'waitForTimeout('", 12)).toBe('string')
  })

  it('does not flag waitForTimeout inside a comment', () => {
    const src = '// await page.waitForTimeout(100)\n'
    expect(ids(checkSource('tests/foo.spec.ts', src))).not.toContain('no-wait-timeout')
  })

  it('does not flag a URL inside a comment (documentation is fine)', () => {
    const src = "// see https://docs.example.com for the flow\n"
    expect(ids(checkSource('tests/foo.spec.ts', src))).not.toContain('no-hardcoded-url')
  })

  it('does flag a URL used as a literal in code', () => {
    const src = 'const url = "https://sap.example.com"\n'
    expect(ids(checkSource('tests/foo.spec.ts', src))).toContain('no-hardcoded-url')
  })
})

describe('rule scoping', () => {
  it('no-page-direct only applies to specs', () => {
    const src = 'await page.locator("#x").click()\n'
    expect(ids(checkSource('tests/foo.spec.ts', src))).toContain('no-page-direct')
    expect(ids(checkSource('pages/login.page.ts', src))).not.toContain('no-page-direct')
  })

  it('every rule id is unique and has at least one applicable file kind', () => {
    const seen = new Set<string>()
    for (const rule of RULES) {
      expect(seen.has(rule.id), `duplicate rule id ${rule.id}`).toBe(false)
      seen.add(rule.id)
      expect(rule.appliesTo.length, `${rule.id} has no appliesTo`).toBeGreaterThan(0)
    }
  })
})

describe('line numbers', () => {
  it('reports the 1-based line of the violation', () => {
    const src = "// line 1\nimport { test } from '@playwright/test'\n"
    const v = checkSource('tests/foo.spec.ts', src)
    const hit = v.find((x) => x.ruleId === 'fixture-import')
    expect(hit?.line).toBe(2)
  })
})

describe('checkConformance', () => {
  it('passes on a conformant tests directory', () => {
    write(
      repo,
      'tests/good.spec.ts',
      "import { test } from '@src/config/fixture'\n\ntest('a', () => {})\n",
    )
    const report = checkConformance({ root: repo })
    expect(report.pass).toBe(true)
    expect(report.violations).toHaveLength(0)
  })

  it('excludes the Playwright MCP seed harness from the default scan', () => {
    write(repo, 'tests/seed.spec.ts', "import { test } from '@playwright/test'\n")
    write(
      repo,
      'tests/good.spec.ts',
      "import { test } from '@src/config/fixture'\ntest('a', () => {})\n",
    )
    const report = checkConformance({ root: repo })
    expect(report.checked).not.toContain('tests/seed.spec.ts')
    expect(report.pass).toBe(true)
  })

  it('still checks the seed file when it is named explicitly', () => {
    write(repo, 'tests/seed.spec.ts', "import { test } from '@playwright/test'\n")
    const report = checkConformance({ root: repo, paths: ['tests/seed.spec.ts'] })
    expect(report.pass).toBe(false)
    expect(ids(report.violations)).toContain('fixture-import')
  })

  it('recursively discovers nested specs and skips non-test files', () => {
    mkdirSync(join(repo, 'tests', 'mod'), { recursive: true })
    write(
      repo,
      'tests/mod/deep.spec.ts',
      "import { test } from '@playwright/test'\ntest('x', () => {})\n",
    )
    write(repo, 'tests/notes.md', 'not a test')
    const report = checkConformance({ root: repo })
    expect(report.checked).toContain('tests/mod/deep.spec.ts')
    expect(report.checked).not.toContain('tests/notes.md')
    expect(report.pass).toBe(false)
  })

  it('records a read-error instead of throwing for a missing file', () => {
    const report = checkConformance({ root: repo, paths: ['tests/missing.spec.ts'] })
    expect(report.pass).toBe(false)
    expect(ids(report.violations)).toContain('read-error')
  })
})

describe('parseArgs', () => {
  it('treats a bare path as a path, not a root value', () => {
    // Regression: the old parser compared against argv[rootIdx + 1], which with no
    // --root present is argv[0] itself — so the named file was dropped and the
    // whole tests/ tree was scanned instead.
    expect(parseArgs(['tests/a.spec.ts'], '/cwd')).toEqual({
      root: '/cwd',
      paths: ['tests/a.spec.ts'],
      asJson: false,
    })
  })

  it('consumes the value following --root', () => {
    const got = parseArgs(['--root', '../fw', 'tests/a.spec.ts'], '/cwd')
    expect(got.root).toBe('../fw')
    expect(got.paths).toEqual(['tests/a.spec.ts'])
  })

  it('takes the next argument as --root\'s value, flags included', () => {
    // Standard CLI behavior: --root consumes the following token. Only another flag
    // (or nothing at all) is left as the default root.
    expect(parseArgs(['--root', 'tests/a.spec.ts'], '/cwd').root).toBe('tests/a.spec.ts')
  })

  it('keeps the default root when --root has no value at all', () => {
    expect(parseArgs(['--root'], '/cwd').root).toBe('/cwd')
  })

  it('ignores unknown flags but keeps --json', () => {
    const got = parseArgs(['--json', '--bogus', 'tests/a.spec.ts'], '/cwd')
    expect(got).toEqual({ root: '/cwd', paths: ['tests/a.spec.ts'], asJson: true })
  })

  it('returns an empty path list for a bare invocation', () => {
    expect(parseArgs([], '/cwd')).toEqual({ root: '/cwd', paths: [], asJson: false })
  })
})
