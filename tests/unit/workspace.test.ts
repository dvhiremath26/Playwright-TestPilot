import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Workspace, WorkspaceViolationError } from '@tcoe/repo-intelligence'

describe('Workspace containment', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tp-ws-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('accepts a relative path inside the root', () => {
    const ws = new Workspace(root)
    const resolved = ws.tryResolve('pages/LoginPage/login.page.ts')

    expect(resolved).not.toBeNull()
    expect(resolved!.relative).toBe('pages/LoginPage/login.page.ts')
    expect(resolved!.resolved.startsWith(ws.rootPath)).toBe(true)
  })

  it('rejects parent traversal', () => {
    const ws = new Workspace(root)
    expect(ws.tryResolve('../../etc/passwd')).toBeNull()
    expect(ws.tryResolve('pages/../../outside.ts')).toBeNull()
  })

  it('rejects an absolute path outside the root', () => {
    const ws = new Workspace(root)
    expect(ws.tryResolve('/etc/passwd')).toBeNull()
  })

  it('accepts an absolute path inside the root', () => {
    const ws = new Workspace(root)
    const inside = join(root, 'tests', 'a.spec.ts')
    expect(ws.tryResolve(inside)?.relative).toBe('tests/a.spec.ts')
  })

  it('rejects a null byte', () => {
    const ws = new Workspace(root)
    expect(ws.tryResolve('tests/a.spec.ts\0.js')).toBeNull()
  })

  it('resolve() throws where tryResolve() returns null', () => {
    const ws = new Workspace(root)
    expect(() => ws.resolve('../escaped.ts')).toThrow(WorkspaceViolationError)
  })

  it('reports isInside consistently with tryResolve', () => {
    const ws = new Workspace(root)
    expect(ws.isInside('pages/a.page.ts')).toBe(true)
    expect(ws.isInside('../a.page.ts')).toBe(false)
  })

  it('validateModelPath enforces the extension and rejects absolute paths', () => {
    const ws = new Workspace(root)
    expect(() => ws.validateModelPath('/etc/passwd.ts', '.ts')).toThrow(WorkspaceViolationError)
    expect(() => ws.validateModelPath('tests/a.spec.js', '.ts')).toThrow(WorkspaceViolationError)
    expect(ws.validateModelPath('tests/a.spec.ts', '.ts').relative).toBe('tests/a.spec.ts')
  })

  it('rejects a symlink whose target is outside the root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'tp-outside-'))
    writeFileSync(join(outside, 'secret.ts'), 'secret')

    let linked = true
    try {
      symlinkSync(outside, join(root, 'link'), 'junction')
    } catch {
      // Windows without the required privilege. Skip rather than assert nothing.
      linked = false
    }

    if (linked) {
      const ws = new Workspace(root)
      expect(ws.tryResolve('link/secret.ts')).toBeNull()
    }

    rmSync(outside, { recursive: true, force: true })
  })
})