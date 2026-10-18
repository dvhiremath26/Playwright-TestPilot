import { describe, expect, it } from 'vitest'

import { createBrowserSession } from '../src/browser-session-factory.ts'

describe('createBrowserSession', () => {
  it('creates a lazy CLI-primary session without a fallback by default', () => {
    const session = createBrowserSession({
      repositoryRoot: '/repo',
      cli: { command: 'playwright-cli-test' },
    })

    expect(session.activeBackend?.info.id).toBe('playwright-cli')
    expect(session.usedFallback).toBe(false)
  })

})
