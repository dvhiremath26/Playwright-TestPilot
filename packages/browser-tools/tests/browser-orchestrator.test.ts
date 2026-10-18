import { expect, test } from 'vitest'

import { BrowserSession } from '../src/browser-orchestrator.ts'

import type {
  BrowserActionResult,
  BrowserElementRef,
  BrowserSnapshot,
  BrowserTool,
  BrowserToolCapabilities,
} from '../src/browser-types.ts'

/** A test backend. The orchestrator reads `capabilities` as optional, so it is declared here. */
type FakeBackend = BrowserTool & { capabilities: BrowserToolCapabilities }

/**
 * A fake backend for tests.
 *
 * Deliberately never spawns anything: these tests exercise the orchestration logic
 * (fallback decisions, provenance, sticky backend) without a browser process involved.
 */
function makeFake(
  id: 'playwright-cli' | 'playwright-mcp',
  behavior: { available?: boolean; goto?: string; snapshot?: string; locator?: string },
): FakeBackend {
  return {
    info: { id, label: id },
    available: behavior.available ?? true,
    capabilities: {
      canSnapshot: true,
      canNavigate: true,
      canInteract: true,
      canEvaluate: true,
      canScreenshot: true,
      canGenerateLocator: true,
    },
    goto: async (): Promise<BrowserActionResult> => ({ ok: true, output: behavior.goto ?? 'navigated' }),
    navigate: async (): Promise<BrowserActionResult> => ({ ok: true, output: behavior.goto ?? 'navigated' }),
    snapshot: async (): Promise<BrowserActionResult> => ({ ok: true, output: behavior.snapshot ?? '' }),
    find: async (): Promise<BrowserActionResult> => ({ ok: true, output: '' }),
    click: async (): Promise<BrowserActionResult> => ({ ok: true, output: '' }),
    type: async (): Promise<BrowserActionResult> => ({ ok: true, output: '' }),
    fill: async (): Promise<BrowserActionResult> => ({ ok: true, output: '' }),
    eval: async (): Promise<BrowserActionResult> => ({ ok: true, output: '' }),
    generateLocator: async (): Promise<BrowserActionResult> => ({ ok: true, output: behavior.locator ?? '' }),
    screenshot: async (): Promise<BrowserActionResult> => ({ ok: true, output: '' }),
    close: async (): Promise<BrowserActionResult> => ({ ok: true, output: 'closed' }),
    parseSnapshot: (raw: string): BrowserSnapshot => {
      const elements: BrowserElementRef[] = []
      for (const m of raw.matchAll(/\[ref=([A-Za-z0-9_-]+)\]/g)) {
        const ref = m[1]
        if (ref) elements.push({ ref, actionable: true })
      }
      return { raw, elements, capturedAt: new Date().toISOString() }
    },
  }
}

/** A primary that fails every call with a configurable error. */
function makeFailingPrimary(error: string): FakeBackend {
  const fail = { ok: false, error } as BrowserActionResult
  return {
    info: { id: 'playwright-cli', label: 'Playwright CLI' },
    available: true,
    capabilities: {
      canSnapshot: true,
      canNavigate: true,
      canInteract: true,
      canEvaluate: true,
      canScreenshot: true,
      canGenerateLocator: true,
    },
    goto: async () => fail,
    navigate: async () => fail,
    snapshot: async () => fail,
    find: async () => fail,
    click: async () => fail,
    type: async () => fail,
    fill: async () => fail,
    eval: async () => fail,
    generateLocator: async () => fail,
    screenshot: async () => fail,
    close: async () => ({ ok: true, output: 'closed' }),
    parseSnapshot: (raw: string): BrowserSnapshot => ({
      raw,
      elements: [],
      capturedAt: new Date().toISOString(),
    }),
  }
}

test('primary backend serves requests when it works', async () => {
  const primary = makeFake('playwright-cli', { snapshot: 'button "Save" [ref=e15]' })
  const session = new BrowserSession({ primary, fallback: makeFake('playwright-mcp', {}) })

  const snap = await session.capture()
  expect(snap).toBeTruthy()
  expect(snap!.elements).toHaveLength(1)
  expect(snap!.elements[0]?.ref).toBe('e15')
  expect(session.usedFallback).toBe(false)
  expect(session.provenance?.backendId).toBe('playwright-cli')
})

test('locator generation keeps backend provenance for an observed ref', async () => {
  const session = new BrowserSession({
    primary: makeFake('playwright-cli', { locator: "getByRole('button', { name: 'Save' })" }),
  })
  const result = await session.generateLocator('e15')
  expect(result.ok).toBe(true)
  expect(result.output).toContain("getByRole('button'")
  expect(result.provenance.backendLabel).toBe('playwright-cli')
})

test('falls back to MCP when the primary is structurally unavailable', async () => {
  const primary = { ...makeFake('playwright-cli', {}), available: false }
  const fallback = makeFake('playwright-mcp', { snapshot: 'a [ref=e1]' })
  const session = new BrowserSession({ primary, fallback })

  const snap = await session.capture()
  expect(snap).toBeTruthy()
  expect(session.usedFallback).toBe(true)
  expect(session.provenance?.backendId).toBe('playwright-mcp')
  expect(session.provenance?.fellBack).toBe(true)
})

test('falls back when the primary reports the tool is not installed', async () => {
  const primary = makeFailingPrimary('Command not found: playwright')
  const fallback = makeFake('playwright-mcp', { snapshot: 'div [ref=e2]' })
  const session = new BrowserSession({ primary, fallback })

  const snap = await session.capture()
  expect(snap).toBeTruthy()
  expect(session.usedFallback).toBe(true)
  expect(session.provenance?.fallbackReason ?? '').toMatch(/Command not found/)
})

test('falls back when the primary is not configured at all', async () => {
  const primary = makeFailingPrimary('Playwright CLI is not configured')
  const fallback = makeFake('playwright-mcp', { snapshot: 'body [ref=e1]' })
  const session = new BrowserSession({ primary, fallback })

  const snap = await session.capture()
  expect(snap).toBeTruthy()
  expect(session.usedFallback).toBe(true)
})

test('does NOT fall back on genuine input errors — bad input fails identically elsewhere', async () => {
  const primary = makeFailingPrimary('target e99 not found in the current page')
  const fallback = makeFake('playwright-mcp', {})
  const session = new BrowserSession({ primary, fallback })

  const snap = await session.capture()
  expect(snap).toBeUndefined()
  expect(session.usedFallback).toBe(false)
})

test('does NOT fall back on a missing selector or a stale element', async () => {
  for (const err of [
    'Selector "button" resolved to nothing',
    'No element matches .save-btn',
    'Element is not visible',
    'Stale element reference',
  ]) {
    const primary = makeFailingPrimary(err)
    const fallback = makeFake('playwright-mcp', {})
    const session = new BrowserSession({ primary, fallback })
    const snap = await session.capture()
    expect(snap, `should not fall back for: ${err}`).toBeUndefined()
    expect(session.usedFallback, `should not fall back for: ${err}`).toBe(false)
  }
})

test('once the fallback is engaged it stays engaged for the session', async () => {
  const primary = makeFailingPrimary('Command not found: playwright')
  const fallback = makeFake('playwright-mcp', {})
  const session = new BrowserSession({ primary, fallback })

  await session.capture()
  await session.navigate('https://example.com')
  expect(session.usedFallback).toBe(true)
  expect(session.activeBackend?.info.id).toBe('playwright-mcp')
})

test('provenance records why a fallback happened', async () => {
  const primary = makeFailingPrimary('Command not found: playwright')
  const fallback = makeFake('playwright-mcp', {})
  const session = new BrowserSession({ primary, fallback })

  const ev = await session.evaluate('document.title')
  expect(ev.kind).toBe('eval')
  expect(ev.source.backendId).toBe('playwright-mcp')
  expect(ev.source.fellBack).toBe(true)
  expect(ev.source.fallbackReason ?? '').toMatch(/Command not found/)
})

test('a healthy primary records provenance with fellBack false', async () => {
  const primary = makeFake('playwright-cli', {})
  const session = new BrowserSession({ primary })
  const ev = await session.evaluate('1+1')
  expect(ev.kind).toBe('eval')
  expect(ev.source.backendId).toBe('playwright-cli')
  expect(ev.source.fellBack).toBe(false)
})

test('no fallback configured and primary unavailable yields a clear error', async () => {
  const primary = { ...makeFake('playwright-cli', {}), available: false }
  const session = new BrowserSession({ primary })
  const ev = await session.navigate('https://example.com')
  expect(ev.detail).toMatch(/failed/)
  expect(session.provenance?.backendId ?? '').toMatch(/playwright-cli/)
})
