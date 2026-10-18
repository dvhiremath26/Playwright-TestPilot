import { describe, expect, it } from 'vitest'

import { ModelProviderError } from '@tcoe/shared-types'

import {
  classifyLmError,
  createVscodeLmProvider,
  VSCODE_LM_PROVIDER_ID,
} from '../src/vscode-lm-provider.ts'
import type { VscodeLmBridge } from '../src/vscode-lm-provider.ts'
import { getProvider } from '../src/provider-registry.ts'
import { buildConfig } from '../src/config.ts'

const MODEL = { id: 'copilot-gpt-5', displayName: 'GPT-5 (Copilot)' }
const EMPTY_REQUEST = { purpose: 'plan' as const }

function bridge(over: Partial<VscodeLmBridge> = {}): VscodeLmBridge {
  return {
    discover: async () => ({ available: true, models: [MODEL] }),
    send: async () => ({ text: 'plan text', modelId: MODEL.id }),
    ...over,
  }
}

describe('vscode-lm provider', () => {
  it('reports unavailable with an actionable reason when no bridge is injected', async () => {
    const provider = createVscodeLmProvider()
    const info = await provider.check()

    expect(info.id).toBe(VSCODE_LM_PROVIDER_ID)
    expect(info.available).toBe(false)
    expect(info.liveService).toBe(false)
    expect(info.unavailableReason).toContain('VS Code extension host')
  })

  it('throws an unavailable error rather than faking a response', async () => {
    const provider = createVscodeLmProvider()
    await expect(provider.chat([{ role: 'user', content: 'x' }], EMPTY_REQUEST)).rejects.toMatchObject({
      kind: 'unavailable',
    })
  })

  it('reports unavailable when discovery says no Copilot session exists', async () => {
    const provider = createVscodeLmProvider({
      bridge: bridge({ discover: async () => ({ available: false, reason: 'Not signed in', models: [] }) }),
    })

    const info = await provider.check()
    expect(info.available).toBe(false)
    expect(info.unavailableReason).toContain('Not signed in')
    expect(await provider.selectDefault()).toBeNull()
  })

  it('surfaces a discovery exception as unavailability instead of throwing', async () => {
    const provider = createVscodeLmProvider({
      bridge: bridge({ discover: async () => { throw new Error('boom') } }),
    })

    const info = await provider.check()
    expect(info.available).toBe(false)
    expect(info.unavailableReason).toContain('boom')
    expect(await provider.listModels()).toEqual([])
  })

  it('selects the preferred model when available', async () => {
    const provider = createVscodeLmProvider({
      preferredModel: 'copilot-gpt-5',
      bridge: bridge({
        discover: async () => ({ available: true, models: [MODEL, { id: 'other', displayName: 'Other' }] }),
      }),
    })

    expect(await provider.selectDefault()).toEqual(MODEL)
    expect(await provider.check()).toMatchObject({ available: true, liveService: true })
  })

  it('falls back to the first available model when the preferred one is missing', async () => {
    const provider = createVscodeLmProvider({ preferredModel: 'does-not-exist', bridge: bridge() })
    expect(await provider.selectDefault()).toEqual(MODEL)
  })

  it('resolves null when no model is available at all', async () => {
    const provider = createVscodeLmProvider({
      bridge: bridge({ discover: async () => ({ available: true, models: [] }) }),
    })
    expect(await provider.selectDefault()).toBeNull()
  })

  it('returns chat text and labels the result a live service', async () => {
    const provider = createVscodeLmProvider({ bridge: bridge() })
    const res = await provider.chat([{ role: 'user', content: 'plan it' }], EMPTY_REQUEST)

    expect(res.text).toBe('plan text')
    expect(res.modelId).toBe('copilot-gpt-5')
    expect(res.liveService).toBe(true)
  })

  it('propagates a bridge error as a typed provider error', async () => {
    const provider = createVscodeLmProvider({
      bridge: bridge({
        send: async () => ({ error: new ModelProviderError('over quota', 'quota') }),
      }),
    })

    await expect(provider.chat([{ role: 'user', content: 'x' }], EMPTY_REQUEST)).rejects.toMatchObject({
      kind: 'quota',
    })
  })

  it('treats an aborted signal as cancellation', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const provider = createVscodeLmProvider({
      bridge: bridge({ send: async () => ({ error: new ModelProviderError('aborted', 'unknown') }) }),
    })

    await expect(
      provider.chat([{ role: 'user', content: 'x' }], { ...EMPTY_REQUEST, signal: aborted.signal }),
    ).rejects.toMatchObject({ kind: 'cancelled' })
  })

  it('rejects an empty response as invalid', async () => {
    const provider = createVscodeLmProvider({ bridge: bridge({ send: async () => ({}) }) })
    await expect(provider.chat([{ role: 'user', content: 'x' }], EMPTY_REQUEST)).rejects.toMatchObject({
      kind: 'invalid-response',
    })
  })

  it('reports no model as unavailable rather than succeeding', async () => {
    const provider = createVscodeLmProvider({
      bridge: bridge({ discover: async () => ({ available: true, models: [] }) }),
    })

    await expect(provider.chat([{ role: 'user', content: 'x' }], EMPTY_REQUEST)).rejects.toMatchObject({
      kind: 'unavailable',
    })
  })
})

describe('classifyLmError', () => {
  it('maps quota, auth, timeout and network signals', () => {
    expect(classifyLmError('429', 'quota exceeded').kind).toBe('quota')
    expect(classifyLmError(undefined, 'please sign in').kind).toBe('unauthorized')
    expect(classifyLmError(undefined, 'request timeout').kind).toBe('timeout')
    expect(classifyLmError(undefined, 'fetch failed').kind).toBe('network')
    expect(classifyLmError(undefined, 'something odd').kind).toBe('unknown')
  })
})

describe('registry', () => {
  it('returns the vscode-lm provider, degrading to unavailable without a bridge', async () => {
    const cfg = buildConfig({ provider: 'vscode-lm' })
    const provider = getProvider(cfg)

    expect(provider).toBeDefined()
    expect(await provider.check()).toMatchObject({ id: VSCODE_LM_PROVIDER_ID, available: false })
  })

  it('passes the injected bridge through to the provider', async () => {
    const cfg = buildConfig({ provider: 'vscode-lm' })
    const provider = getProvider(cfg, { vscodeLmBridge: bridge() })

    expect(await provider.check()).toMatchObject({ available: true, liveService: true })
  })

  it('defaults to mock when no provider is configured', async () => {
    expect(await getProvider(buildConfig()).check()).toMatchObject({ id: 'mock' })
  })
})
