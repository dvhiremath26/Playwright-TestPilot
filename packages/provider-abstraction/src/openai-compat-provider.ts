/**
 * Minimal OpenAI-compatible chat completions client using only Node.js builtins.
 *
 * Supports:
 * - Custom base URL (for proxies, local servers, LM Studio, etc.)
 * - API key via Authorization header
 * - Configurable timeout and retry with exponential backoff
 * - Streaming disabled by default (set streaming: true in options to enable)
 *
 * Throws a typed `Unavailable` error when the network is unreachable or the
 * API key is missing — never silently fakes a response.
 */

import type {
  ChatMessage,
  ChatRequestOptions,
  ChatResponse,
  ModelInfo,
  ModelProvider,
  ModelProviderInfo,
} from '@tcoe/shared-types'
import { ModelProviderError } from '@tcoe/shared-types'

import { redact } from './redaction.ts'

// ─── Error types ───────────────────────────────────────────────────────────────

export class Unavailable extends ModelProviderError {
  constructor(message: string) {
    super(message, 'unavailable')
    this.name = 'Unavailable'
  }
}

export class Unauthorized extends ModelProviderError {
  constructor(message: string) {
    super(message, 'unauthorized')
    this.name = 'Unauthorized'
  }
}

export class NetworkError extends ModelProviderError {
  constructor(message: string) {
    super(message, 'network')
    this.name = 'NetworkError'
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface OpenAICompatConfig {
  /** Base URL for the chat completions endpoint, e.g. 'https://api.openai.com/v1'. */
  baseUrl: string
  /** Environment variable name containing the API key. */
  apiKeyEnvVar: string
  /** Request timeout in ms. Default: 60 000. */
  timeoutMs?: number
  /** Max retries on 429 / 5xx. Default: 2. */
  maxRetries?: number
  /** Default model id. */
  model?: string
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function httpPost(
  url: string,
  body: object,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const { hostname, pathname, protocol } = new URL(url)
  const isHttps = protocol === 'https:'
  const mod = isHttps ? await import('node:https') : await import('node:http')

  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const req = mod.request(
      {
        hostname,
        path: pathname,
        method: 'POST',
        headers,
        signal: controller.signal as unknown as AbortSignal,
      },
      (res) => {
        clearTimeout(timer)
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const rawHeaders: Record<string, string> = {}
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) rawHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v)
          }
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            headers: rawHeaders,
          })
        })
      },
    )

    req.on('error', (err) => {
      clearTimeout(timer)
      reject(new NetworkError(`Request to ${redact(url)} failed: ${err.message}`))
    })

    req.write(JSON.stringify(body), () => req.end())
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function createOpenAICompatProvider(cfg: OpenAICompatConfig): ModelProvider {
  const timeoutMs = cfg.timeoutMs ?? 60_000
  const maxRetries = cfg.maxRetries ?? 2

  async function check(): Promise<ModelProviderInfo> {
    const apiKey = process.env[cfg.apiKeyEnvVar]
    if (!apiKey) {
      return {
        id: 'openai-compatible',
        displayName: 'OpenAI-compatible API',
        available: false,
        liveService: false,
        unavailableReason: `Environment variable "${cfg.apiKeyEnvVar}" is not set.`,
      }
    }

    try {
      // Hit the models endpoint to verify connectivity.
      const { hostname, pathname, protocol } = new URL(cfg.baseUrl)
      const modelsPath = pathname.endsWith('/chat/completions')
        ? cfg.baseUrl.replace(/\/chat\/completions$/, '/models')
        : cfg.baseUrl + '/models'

      const isHttps = protocol === 'https:'
      const mod = isHttps ? await import('node:https') : await import('node:http')

      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = mod.request(
          { hostname, path: new URL(modelsPath).pathname, method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => chunks.push(c))
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
          },
        )
        req.on('error', reject)
        req.end()
      })

      if (result.status === 401 || result.status === 403) {
        return {
          id: 'openai-compatible',
          displayName: 'OpenAI-compatible API',
          available: false,
          liveService: false,
          unavailableReason: `API key is invalid or has insufficient permissions (HTTP ${result.status}).`,
        }
      }

      return {
        id: 'openai-compatible',
        displayName: 'OpenAI-compatible API',
        available: result.status < 500,
        liveService: true,
        unavailableReason: result.status >= 500 ? `Server error: HTTP ${result.status}` : undefined,
      }
    } catch (err) {
      return {
        id: 'openai-compatible',
        displayName: 'OpenAI-compatible API',
        available: false,
        liveService: false,
        unavailableReason: err instanceof Error ? `Network error: ${err.message}` : 'Unknown network error',
      }
    }
  }

  async function listModels(): Promise<ModelInfo[]> {
    return [{ id: cfg.model ?? 'gpt-4o', displayName: cfg.model ?? 'OpenAI-compatible model' }]
  }

  async function selectDefault(): Promise<ModelInfo | null> {
    const info = await check()
    return info.available ? { id: cfg.model ?? 'gpt-4o', displayName: cfg.model ?? 'OpenAI-compatible model' } : null
  }

  async function chat(
    messages: ChatMessage[],
    options: ChatRequestOptions,
  ): Promise<ChatResponse> {
    const apiKey = process.env[cfg.apiKeyEnvVar]
    if (!apiKey) {
      throw new Unavailable(
        `API key environment variable "${cfg.apiKeyEnvVar}" is not set. ` +
          'Set it or switch to the mock provider in tcoe-testpilot.config.json.',
      )
    }

    const model = options.modelId ?? cfg.model ?? 'gpt-4o'
    const endpoint = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions'

    const body: Record<string, unknown> = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: options.temperature ?? 0.3,
    }
    if (options.maxTokens) body['max_tokens'] = options.maxTokens

    let lastError: Error | null = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await httpPost(
          endpoint,
          body,
          {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          timeoutMs,
        )

        if (response.status === 401 || response.status === 403) {
          throw new Unauthorized(`API key rejected (HTTP ${response.status}). Check that ${cfg.apiKeyEnvVar} is valid.`)
        }

        if (response.status === 429 || response.status >= 500) {
          if (attempt < maxRetries) {
            const backoff = Math.min(1000 * 2 ** attempt, 30_000)
            await sleep(backoff)
            continue
          }
          throw new Unavailable(`API returned HTTP ${response.status} after ${maxRetries} retries.`)
        }

        if (response.status < 200 || response.status >= 300) {
          throw new Unavailable(`Unexpected HTTP ${response.status}: ${redact(response.body.slice(0, 200))}`)
        }

        let parsed: { choices?: Array<{ message?: { content?: string } }>; model?: string }
        try {
          parsed = JSON.parse(response.body)
        } catch {
          throw new Unavailable(`Non-JSON response from API: ${redact(response.body.slice(0, 200))}`)
        }

        const content = parsed.choices?.[0]?.message?.content
        if (!content && content !== '') {
          throw new Unavailable('Response contained no content. Model may be misconfigured.')
        }

        return {
          text: content,
          modelId: parsed.model ?? model,
          liveService: true,
        }
      } catch (err) {
        if (
          err instanceof Unauthorized ||
          err instanceof Unavailable
        ) {
          throw err
        }
        lastError = err instanceof Error ? err : new Error(String(err))
        if (attempt < maxRetries) {
          const backoff = Math.min(1000 * 2 ** attempt, 30_000)
          await sleep(backoff)
        }
      }
    }

    throw new Unavailable(
      lastError?.message ?? 'OpenAI-compatible API call failed after retries.',
    )
  }

  return { check, listModels, selectDefault, chat }
}
