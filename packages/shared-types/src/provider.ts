/**
 * Provider-neutral model interface.
 *
 * The agent core depends only on this interface. Concrete providers
 * (VS Code Language Model API, deterministic mock, future CLI/Electron
 * integrations) implement it behind an adapter, so the core never touches
 * VS Code APIs and can be unit-tested offline.
 */

/** A provider available on this host. */
export interface ModelProviderInfo {
  /** Stable provider id, e.g. `vscode-lm` or `mock`. */
  id: string
  /** Human name. */
  displayName: string
  /** Whether a model is actually available right now. */
  available: boolean
  /** Why it is unavailable, when it is. */
  unavailableReason?: string
  /** Whether it was exercised against a real service, or is deterministic. */
  liveService: boolean
}

/** Capability metadata for a selectable model. */
export interface ModelInfo {
  id: string
  displayName: string
  vendor?: string
  family?: string
  /** Approximate context window, when the provider reports it. */
  contextTokens?: number
}

/** One message in a model request. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequestOptions {
  /** Purpose label, recorded in task metadata. */
  purpose: string
  /** Preferred model id. Providers may substitute a different model. */
  modelId?: string
  temperature?: number
  /** Max output tokens, when the provider supports it. */
  maxTokens?: number
  /** Cancel signal. */
  signal?: AbortSignal
  /** Called with partial text as it arrives, when supported. */
  onDelta?: (partialText: string) => void
}

export interface ChatResponse {
  text: string
  /** The model that actually served the request. */
  modelId?: string
  /** Whether the provider reported it as a real live model. */
  liveService: boolean
}

export class ModelProviderError extends Error {
  readonly kind: ModelProviderErrorKind

  constructor(
    message: string,
    kind: ModelProviderErrorKind,
  ) {
    super(message)
    this.name = 'ModelProviderError'
    this.kind = kind
  }
}

export type ModelProviderErrorKind =
  | 'unauthorized'
  | 'unavailable'
  | 'quota'
  | 'cancelled'
  | 'timeout'
  | 'network'
  | 'invalid-response'
  | 'unknown'

export interface ModelProvider {
  /** Discover this provider's status. Never throws. */
  check(): Promise<ModelProviderInfo>
  /** List selectable models when the provider supports it. */
  listModels(): Promise<ModelInfo[]>
  /**
   * Select the best available model when the user has not chosen one.
   * Resolves null when no model is available; callers must then report the
   * provider as unavailable instead of pretending success.
   */
  selectDefault(): Promise<ModelInfo | null>
  /** Run a chat request. */
  chat(messages: ChatMessage[], options: ChatRequestOptions): Promise<ChatResponse>
}
