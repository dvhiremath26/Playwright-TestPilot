/**
 * GitHub Copilot bridge for the VS Code extension host.
 *
 * The extension core is provider-neutral and never imports `vscode` — that would
 * drag the host into the package and make it untestable from plain Node. This
 * module is the one place that crosses into the host: it adapts `vscode.lm` to
 * the `VscodeLmBridge` seam the core expects.
 *
 * Every failure here is returned, not thrown. Throwing out of a host API call
 * would look like a crash; returning `{ error }` lets the caller classify quota,
 * authorization, and network failures the same way a CLI run would.
 */

import type {
  ChatMessage,
  ChatRequestOptions,
  ModelInfo,
} from '@tcoe/shared-types'
import { ModelProviderError } from '@tcoe/shared-types'
import type * as vscode from 'vscode'

import { classifyLmError, type VscodeLmBridge } from '@tcoe/provider-abstraction'

/** Build the bridge that connects the extension core to GitHub Copilot. */
export function createCopilotBridge(): VscodeLmBridge {
  // Imported inside the function so the module can be loaded and type-checked
  // without a host. The host resolves `vscode` at runtime in the extension process.
  const vscode = require('vscode') as typeof import('vscode')

  /** A single usable Copilot model, as far as the core needs it. */
  async function discover(): Promise<{ available: boolean; reason?: string; models: ModelInfo[] }> {
    try {
      const sessions = await vscode.lm.selectChatModels({ vendor: 'copilot' })
      if (sessions.length === 0) {
        return {
          available: false,
          reason:
            'No GitHub Copilot models are visible. Sign in to Copilot Chat in this workspace, ' +
            'then run TestPilot again.',
          models: [],
        }
      }

      const models: ModelInfo[] = sessions.map((s) => ({
        id: s.id,
        displayName: s.name || s.id,
        vendor: s.vendor,
        family: s.family,
        contextTokens: s.maxInputTokens,
      }))

      return {
        available: true,
        models,
      }
    } catch (err) {
      return {
        available: false,
        reason: `Copilot discovery failed: ${err instanceof Error ? err.message : String(err)}`,
        models: [],
      }
    }
  }

  async function send(
    messages: ChatMessage[],
    options: ChatRequestOptions,
    model: ModelInfo | undefined,
  ): Promise<{ text?: string; modelId?: string; error?: ModelProviderError }> {
    try {
      const [lmModel] = await vscode.lm.selectChatModels({
        vendor: 'copilot',
        ...(model?.id ? { id: model.id } : {}),
      })
      if (!lmModel) {
        return {
          error: new ModelProviderError('Copilot returned no model, so no request could be sent.', 'unavailable'),
        }
      }

      const requestMessages = messages.map((message) => {
        const content = message.role === 'system'
          ? `Instructions for this request:\n${message.content}`
          : message.content
        return message.role === 'assistant'
          ? vscode.LanguageModelChatMessage.Assistant(content)
          : vscode.LanguageModelChatMessage.User(content)
      })

      const cancellation = new vscode.CancellationTokenSource()
      const cancelRequest = () => cancellation.cancel()
      if (options.signal?.aborted) cancellation.cancel()
      else options.signal?.addEventListener('abort', cancelRequest, { once: true })
      try {
        const response = await lmModel.sendRequest(requestMessages, {}, cancellation.token)
        let text = ''
        for await (const chunk of response.text) text += chunk
        return { text, modelId: lmModel.id }
      } finally {
        options.signal?.removeEventListener('abort', cancelRequest)
        cancellation.dispose()
      }
    } catch (err) {
      if (options.signal?.aborted) {
        return { error: new ModelProviderError('Request was cancelled.', 'cancelled') }
      }

      const message = err instanceof Error ? err.message : String(err)
      const code = (err as { code?: string } | undefined)?.code
      if (/model_not_supported|requested model is not supported/i.test(message)) {
        const selected = model ? `"${model.displayName}" (${model.id})` : 'the selected Copilot model'
        return {
          error: new ModelProviderError(
            `Copilot rejected ${selected} as unsupported for extension requests. Choose a supported model such as GPT-4o and try again. Provider response: ${message}`,
            'unavailable',
          ),
        }
      }
      return { error: classifyLmError(code, message) }
    }
  }

  return { discover, send }
}
