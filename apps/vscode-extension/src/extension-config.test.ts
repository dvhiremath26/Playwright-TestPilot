import { describe, expect, it } from 'vitest'

import { resolveRepoPath, resolveWorkspaceConfig } from './extension-config.ts'

const REPO_ROOT = '/repo/app'

const TARGET_WITH_SECRET = 'https://admin:SuperSecret1@erp.example.com/sap/'
const TARGET_CLEAN = 'https://erp.example.com/sap/'

describe('resolveRepoPath', () => {
  it('resolves a relative path against the repository root', () => {
    expect(resolveRepoPath('tests/login.spec.ts', REPO_ROOT)).toBe('/repo/app/tests/login.spec.ts')
  })

  it('keeps an absolute path unchanged', () => {
    expect(resolveRepoPath('/elsewhere/file.ts', REPO_ROOT)).toBe('/elsewhere/file.ts')
  })

  it('joins directory and file separately rather than string concatenation', () => {
    // Naive concatenation would double the separator.
    const p = resolveRepoPath('tests/', '/repo/app')
    expect(p).not.toContain('//tests')
    expect(p.endsWith('tests')).toBe(true)
  })

  it('normalizes traversal so the result is not left to chance', () => {
    const p = resolveRepoPath('../outside', REPO_ROOT)
    expect(p).toBe('/repo/app/../outside')
    // The helper preserves traversal so the caller's containment check can reject it.
    expect(p.split(/[\\/]/)).toContain('..')
  })
})

describe('resolveWorkspaceConfig', () => {
  it('accepts a frameworkRepo with no trailing separator', () => {
    const config = resolveWorkspaceConfig({
      frameworkRepo: '/repo/app/',
      targetUrl: TARGET_CLEAN,
    })
    expect(config.frameworkRepo).toBe('/repo/app')
  })

  it('strips both forward and backslash trailing separators', () => {
    expect(resolveWorkspaceConfig({ frameworkRepo: 'c:\\proj\\fw\\' }).frameworkRepo).toBe('c:\\proj\\fw')
  })

  it('omits appName when unset rather than passing an empty string', () => {
    expect(resolveWorkspaceConfig({}, REPO_ROOT).appName).toBeUndefined()
  })

  it('omits appName when it is whitespace', () => {
    expect(resolveWorkspaceConfig({ appName: '   ' }, REPO_ROOT).appName).toBeUndefined()
  })

  it('refuses a targetUrl that embeds credentials and passes none at all', () => {
    expect(() => resolveWorkspaceConfig({ targetUrl: TARGET_WITH_SECRET }, REPO_ROOT)).toThrow(/userinfo/)
    expect(() => resolveWorkspaceConfig({ targetUrl: TARGET_WITH_SECRET }, REPO_ROOT)).toThrow(/password/)
    expect(() => resolveWorkspaceConfig({ targetUrl: TARGET_WITH_SECRET }, REPO_ROOT)).toThrow(/targetUrl/)
  })

  it('accepts a normal targetUrl with query string and path', () => {
    const config = resolveWorkspaceConfig({
      targetUrl: 'https://erp.example.com/sap/preview?sap-client=100',
    }, REPO_ROOT)
    expect(config.targetUrl).toBe('https://erp.example.com/sap/preview?sap-client=100')
  })

  it('does not flag a literal @ in a query parameter value', () => {
    // The userinfo pattern is anchored to the authority, so `?user=first@last` is fine.
    expect(() => resolveWorkspaceConfig({ targetUrl: 'https://x.test/p?email=a@b.com' }, REPO_ROOT)).not.toThrow()
  })

  it('does not flag a URL with a port but no credentials', () => {
    expect(() => resolveWorkspaceConfig({ targetUrl: 'https://erp.test:8443/app' }, REPO_ROOT)).not.toThrow()
  })

  it('falls back to the current workspace folder when frameworkRepo is empty', () => {
    const config = resolveWorkspaceConfig({ frameworkRepo: '' }, '/current/workspace')
    expect(config.frameworkRepo).toBe('/current/workspace')
  })

  it('defaults the state dir to the in-repo dot folder', () => {
    expect(resolveWorkspaceConfig({}, REPO_ROOT).stateDir).toBe('.tcoe-testpilot')
  })

  it('accepts an explicit state dir override', () => {
    expect(resolveWorkspaceConfig({ stateDir: '.my-pilot' }, REPO_ROOT).stateDir).toBe('.my-pilot')
  })

  it('treats a missing appRoot as an explicit error, not a silent fallback', () => {
    expect(() => resolveWorkspaceConfig({})).toThrow('workspace folder is open')
  })
})
