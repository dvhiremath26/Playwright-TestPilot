/**
 * Provider registry — wires config to concrete provider instances.
 *
 * `getProvider(config)` returns the right `ModelProvider` for the given config.
 * Default is 'mock' when no real provider is configured.
 */

import type { ModelProvider } from '@tcoe/shared-types'

import { createOpenAICompatProvider } from './openai-compat-provider.ts'
import { createVscodeLmProvider, type VscodeLmBridge } from './vscode-lm-provider.ts'
import { mockProvider } from './mock-provider.ts'
import type { ProviderConfig } from './config.ts'

/**
 * An optional extension-supplied bridge for the Copilot provider.
 * Outside the VS Code extension host nothing can provide one, so `vscode-lm` reports
 * itself unavailable there rather than faking a response.
 */
export interface ProviderRegistryOptions {
  vscodeLmBridge?: VscodeLmBridge
}

/**
 * Return the configured ModelProvider.
 *
 * Defaults to 'mock'. Requesting 'vscode-lm' without an injected bridge yields a
 * provider whose check() reports unavailability — never a successful fake call.
 */
export function getProvider(config: ProviderConfig, options: ProviderRegistryOptions = {}): ModelProvider {
  switch (config.provider) {
    case 'mock':
      return mockProvider

    case 'vscode-lm':
      return createVscodeLmProvider({
        bridge: options.vscodeLmBridge,
        preferredModel: config.model,
      })

    case 'openai-compatible':
      return createOpenAICompatProvider({
        baseUrl: config.baseUrl ?? 'https://api.openai.com/v1',
        apiKeyEnvVar: config.apiKeyEnvVar ?? 'OPENAI_API_KEY',
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
        model: config.model,
      })

    default: {
      const exhaustive: never = config.provider
      throw new Error(
        `Unknown provider "${exhaustive}". Available providers: mock, vscode-lm, openai-compatible.`,
      )
    }
  }
}
