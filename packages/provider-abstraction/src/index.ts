export { buildSystemPrompt, buildPlanUserPrompt, buildGenerationUserPrompt } from './prompts.ts'
export type { PlanRequestContext, GenerationContext } from './prompts.ts'

export { mockProvider } from './mock-provider.ts'

export { createOpenAICompatProvider } from './openai-compat-provider.ts'
export { Unavailable, Unauthorized, NetworkError } from './openai-compat-provider.ts'

export {
  createVscodeLmProvider,
  classifyLmError,
  VSCODE_LM_PROVIDER_ID,
} from './vscode-lm-provider.ts'
export type { VscodeLmBridge, VscodeLmProviderOptions } from './vscode-lm-provider.ts'

export { getProvider } from './provider-registry.ts'
export type { ProviderRegistryOptions } from './provider-registry.ts'

export {
  buildConfig,
  safeConfigDump,
  resolveApiKey,
  validateConfig,
  redactObject,
} from './config.ts'
export type { ProviderConfig, ProviderId } from './config.ts'

export { redact } from './redaction.ts'
