/**
 * GitHub Copilot via the VS Code Language Model API (`vscode.lm`).
 *
 * This is the only supported AI resource. It is deliberately provider-neutral and
 * holds no reference to `vscode` — that would drag a VS Code dependency into the
 * agent core, which must stay testable from plain Node.
 *
 * Instead the extension injects a `VscodeLmBridge` when it constructs this provider.
 * Outside the extension host there is no bridge to inject, so the provider reports
 * itself unavailable with an actionable reason rather than faking a response. That is
 * the honest-degradation contract: never claim a model integration works unless it has
 * been exercised successfully.
 *
 * Nothing here touches Copilot tokens, private endpoints, or authentication. Model
 * access flows through the official `vscode.lm` API and the user's own Copilot
 * subscription; quotas and organizational restrictions are surfaced as errors.
 */

import type {
  ChatMessage,
  ChatRequestOptions,
  ChatResponse,
  ModelInfo,
  ModelProvider,
  ModelProviderInfo,
} from '@tcoe/shared-types'

import { ModelProviderError, type ModelProviderErrorKind } from '@tcoe/shared-types'

export const VSCODE_LM_PROVIDER_ID = 'vscode-lm'

const NOT_IN_EXTENSION_HOST =
  'GitHub Copilot via vscode.lm is only available inside the VS Code extension host. ' +
  'Open TCOE TestPilot in VS Code with GitHub Copilot Chat enabled, or use provider "mock" ' +
  'for deterministic offline runs.'

/**
 * The seam the extension implements. Everything about `vscode.lm` lives behind this,
 * so the rest of the codebase never imports VS Code.
 */
export interface VscodeLmBridge {
  /**
   * List the models available through `vscode.lm.selectChatModels` and report whether a
   * Copilot session exists at all. Must not throw.
   */
  discover(): Promise<{ available: boolean; reason?: string; models: ModelInfo[] }>

  /**
   * Send one request through `vscode.lm.sendRequest`. Must not throw: return
   * `{ error }` so the caller can classify the failure.
   *
   * `onDelta` is where streaming is forwarded, if the selected model supports it.
   */
  send(
    messages: ChatMessage[],
    options: ChatRequestOptions,
    model: ModelInfo | undefined,
  ): Promise<{ text?: string; modelId?: string; error?: ModelProviderError }>
}

export interface VscodeLmProviderOptions {
  bridge?: VscodeLmBridge
  /** Preferred model id when the user has not selected one. */
  preferredModel?: string
}

function info(bridge: VscodeLmBridge | undefined): ModelProviderInfo {
  if (!bridge) {
    return {
      id: VSCODE_LM_PROVIDER_ID,
      displayName: 'GitHub Copilot (VS Code)',
      available: false,
      liveService: false,
      unavailableReason: NOT_IN_EXTENSION_HOST,
    }
  }
  return {
    id: VSCODE_LM_PROVIDER_ID,
    displayName: 'GitHub Copilot (VS Code)',
    available: true,
    liveService: true,
  }
}

/**
 * Pick the model the user asked for, else the first Copilot session the bridge reports.
 * Resolves null when no model is available — callers must then report unavailability
 * instead of pretending success.
 */
function pickModel(models: ModelInfo[], preferred?: string): ModelInfo | undefined {
  if (preferred) {
    const match = models.find((m) => m.id === preferred || m.displayName === preferred)
    if (match) return match
  }
  return models[0]
}

/** Build the Copilot provider. Pass a bridge from the extension host; omit it elsewhere. */
export function createVscodeLmProvider(options: VscodeLmProviderOptions = {}): ModelProvider {
  const bridge = options.bridge

  async function discover(): Promise<{ available: boolean; reason?: string; models: ModelInfo[] }> {
    if (!bridge) {
      return { available: false, reason: NOT_IN_EXTENSION_HOST, models: [] }
    }
    try {
      return await bridge.discover()
    } catch (err) {
      return {
        available: false,
        reason: `vscode.lm discovery failed: ${err instanceof Error ? err.message : String(err)}`,
        models: [],
      }
    }
  }

  async function selectDefault(): Promise<ModelInfo | null> {
    return pickModel((await discover()).models, options.preferredModel) ?? null
  }

  return {
    async check() {
      const base = info(bridge)
      if (!bridge) return base
      const d = await discover()
      if (!d.available) {
        return { ...base, available: false, unavailableReason: d.reason ?? 'No Copilot model is available.' }
      }
      return { ...base, available: d.models.length > 0, liveService: true }
    },

    async listModels() {
      return (await discover()).models
    },

    async selectDefault() {
      return selectDefault()
    },

    async chat(messages, requestOptions) {
      if (!bridge) {
        throw new ModelProviderError(NOT_IN_EXTENSION_HOST, 'unavailable')
      }

      const model = await selectDefault()
      if (!model) {
        throw new ModelProviderError(
          'No GitHub Copilot model is available. Confirm Copilot Chat is signed in and authorized in this workspace.',
          'unavailable',
        )
      }

      const result = await bridge.send(messages, requestOptions, model)
      if (result.error) {
        if (requestOptions.signal?.aborted) {
          throw new ModelProviderError('Request was cancelled.', 'cancelled')
        }
        throw result.error
      }
      if (!result.text) {
        throw new ModelProviderError('Copilot returned an empty response.', 'invalid-response')
      }

      return { text: result.text, modelId: result.modelId ?? model.id, liveService: true }
    },
  }
}

/**
 * Map a VS Code-side failure onto a provider error kind. Kept here so the bridge
 * implementation does not have to know the taxonomy.
 */
export function classifyLmError(code: string | undefined, message: string): ModelProviderError {
  const lower = `${code ?? ''} ${message}`.toLowerCase()
  const kind: ModelProviderErrorKind = lower.includes('quota')
    ? 'quota'
    : lower.includes('unauthor') || lower.includes('sign in') || lower.includes('license')
      ? 'unauthorized'
      : lower.includes('timeout')
        ? 'timeout'
        : lower.includes('network') || lower.includes('fetch')
          ? 'network'
          : 'unknown'
  return new ModelProviderError(message, kind)
}
