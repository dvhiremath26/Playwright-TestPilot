import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyChanges, buildUnifiedDiff, snapshotRepository, verifyRepositorySnapshot } from '../../packages/cli/src/apply'
import { checkPaths, checkDiff, readScripts } from '../../packages/cli/src/validate'
import type { FileChange, TaskRecord } from '@tcoe/shared-types'

function change(over: Partial<FileChange> = {}): FileChange {
  return {
    path: 'tests/new.spec.ts',
    kind: 'create',
    newContent: 'export const a = 1\n',
    reason: 'test',
    evidence: ['test'],
    ...over,
  }
}

function task(): TaskRecord {
  return {
    taskId: 't1',
    title: 'T',
    status: 'AwaitingApproval',
    createdAt: '',
    updatedAt: '',
    testCaseSource: 'pasted',
    repositoryRoot: '',
    stages: [],
    plan: [],
    reuseReport: null,
    proposedChanges: [],
    modelCalls: [],
  } as unknown as TaskRecord
}

describe('applyChanges', () => {
  let root: string
  let stateDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tp-apply-'))
    stateDir = join(root, '.tcoe-testpilot')
    mkdirSync(join(root, 'tests'), { recursive: true })
    writeFileSync(join(root, 'tests', 'existing.spec.ts'), 'existing\n', 'utf-8')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates a new file', () => {
    const r = applyChanges({ repositoryRoot: root, stateDir, task: task(), changes: [change()] })
    expect(r.written).toEqual(['tests/new.spec.ts'])
    expect(readFileSync(join(root, 'tests', 'new.spec.ts'), 'utf-8')).toBe('export const a = 1\n')
  })

  it('modifies an existing file', () => {
    const r = applyChanges({
      repositoryRoot: root,
      stateDir,
      task: task(),
      changes: [change({ path: 'tests/existing.spec.ts', kind: 'modify', newContent: 'changed\n' })],
    })
    expect(r.written).toEqual(['tests/existing.spec.ts'])
    expect(readFileSync(join(root, 'tests', 'existing.spec.ts'), 'utf-8')).toBe('changed\n')
  })

  it('writes nothing in dry-run mode', () => {
    const r = applyChanges({
      repositoryRoot: root,
      stateDir,
      task: task(),
      changes: [change()],
      dryRun: true,
    })
    expect(r.wouldWrite).toEqual(['tests/new.spec.ts'])
    expect(r.written).toEqual([])
    expect(existsSync(join(root, 'tests', 'new.spec.ts'))).toBe(false)
    // The diff is still produced, so it can be reviewed.
    expect(r.diffs).toHaveLength(1)
  })

  it('refuses a path that escapes the repository', () => {
    const r = applyChanges({
      repositoryRoot: root,
      stateDir,
      task: task(),
      changes: [change({ path: '../escaped.spec.ts' })],
    })
    expect(r.written).toEqual([])
    expect(r.skipped).toHaveLength(1)
    expect(r.skipped[0]!.reason).toMatch(/outside/i)
  })

  it('refuses to overwrite when the plan says create but the file exists', () => {
    const r = applyChanges({
      repositoryRoot: root,
      stateDir,
      task: task(),
      changes: [change({ path: 'tests/existing.spec.ts', kind: 'create' })],
    })
    expect(r.skipped).toHaveLength(1)
    expect(r.skipped[0]!.reason).toMatch(/already exists/i)
    expect(readFileSync(join(root, 'tests', 'existing.spec.ts'), 'utf-8')).toBe('existing\n')
  })

  it('refuses when the plan says modify but the file is missing', () => {
    const r = applyChanges({
      repositoryRoot: root,
      stateDir,
      task: task(),
      changes: [change({ path: 'tests/absent.spec.ts', kind: 'modify' })],
    })
    expect(r.skipped).toHaveLength(1)
    expect(existsSync(join(root, 'tests', 'absent.spec.ts'))).toBe(false)
  })

  it('skips a change with no content rather than writing an empty file', () => {
    const r = applyChanges({
      repositoryRoot: root,
      stateDir,
      task: task(),
      changes: [change({ newContent: undefined })],
    })
    expect(r.skipped).toHaveLength(1)
    expect(existsSync(join(root, 'tests', 'new.spec.ts'))).toBe(false)
  })
})

describe('saved task source snapshots', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tp-snapshot-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'page.ts'), 'export const page = 1\n', 'utf-8')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('accepts unchanged source and detects source drift', () => {
    const snapshot = snapshotRepository(root, ['src/page.ts'])
    expect(verifyRepositorySnapshot(root, snapshot)).toEqual([])
    writeFileSync(join(root, 'src', 'page.ts'), 'export const page = 2\n', 'utf-8')
    expect(verifyRepositorySnapshot(root, snapshot)).toContain('Source changed after planning: src/page.ts')
  })

  it('requires a source snapshot before resuming', () => {
    expect(verifyRepositorySnapshot(root, undefined)[0]).toMatch(/no repository snapshot/i)
  })
})

describe('buildUnifiedDiff', () => {
  it('marks an added file', () => {
    const d = buildUnifiedDiff('a.ts', undefined, 'x\n')
    expect(d).toContain('--- a/a.ts')
    expect(d).toContain('+++ b/a.ts')
    expect(d).toContain('+x')
  })

  it('marks removed and added lines in a modification', () => {
    const d = buildUnifiedDiff('a.ts', 'one\ntwo\n', 'one\nthree\n')
    expect(d).toContain('-two')
    expect(d).toContain('+three')
    expect(d).toContain(' one')
  })
})

describe('validation checks', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tp-val-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('checkDiff passes when every change is documented', () => {
    const c = checkDiff([change()])
    expect(c.passed).toBe(true)
  })

  it('checkPaths passes for contained paths', () => {
    const c = checkPaths([change()], root)
    expect(c.passed).toBe(true)
    expect(c.skipped).toBe(false)
  })

  it('checkPaths fails for an escaping path', () => {
    const c = checkPaths([change({ path: '../x.ts' })], root)
    expect(c.passed).toBe(false)
    expect(c.detail).toContain('escape')
  })

  it('checkDiff requires a reason and evidence on every change', () => {
    const c = checkDiff([change({ reason: '', evidence: [] })])
    expect(c.passed).toBe(false)
    expect(c.detail).toMatch(/reason/)
    expect(c.detail).toMatch(/evidence/)
  })

  it('readScripts returns an empty object when package.json is absent', () => {
    expect(readScripts(root)).toEqual({})
  })

  it('readScripts parses scripts when present', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint' } }), 'utf-8')
    expect(readScripts(root)).toEqual({ lint: 'eslint' })
  })
})

describe('workspace write isolation', () => {
  it('never writes outside the repository root even with a traversal path', () => {
    const parent = mkdtempSync(join(tmpdir(), 'tp-parent-'))
    const root = join(parent, 'repo')
    mkdirSync(join(root, 'tests'), { recursive: true })

    const r = applyChanges({
      repositoryRoot: root,
      stateDir: join(root, '.state'),
      task: task(),
      changes: [change({ path: '../sibling.spec.ts' })],
    })

    expect(r.written).toEqual([])
    expect(existsSync(join(parent, 'sibling.spec.ts'))).toBe(false)
    rmSync(parent, { recursive: true, force: true })
  })
})
