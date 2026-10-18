/**
 * Provider configuration loading.
 *
 * Sources (in priority order, highest wins):
 * 1. Direct config object passed to `loadConfig()`
 * 2. `tcoe-testpilot.config.json` in the project root or current directory
 * 3. Environment variables prefixed `TCOE_`
 *
 * Secrets (apiKey, token) are resolved from environment variables only —
 * they must NEVER appear as literal values in a config file or error message.
 *
 * Run: `npx tcoe-testpilot config --show` to print the resolved config
 * with secrets masked.
 */

import { readFileSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'
import { redact, redactObject } from './redaction.ts'

/**
 * Supported providers.
 *
 * 'vscode-lm' is the only supported AI resource: GitHub Copilot models through the
 * VS Code Language Model API. 'mock' is deterministic and offline, for tests and CI.
 */
export type ProviderId = 'mock' | 'vscode-lm' | 'openai-compatible'

export interface ProviderConfig {
  /** Which provider to use. Default: 'mock' when nothing else is set. */
  provider: ProviderId
  /** Model id, e.g. 'gpt-4o'. */
  model?: string
  /** Base URL for OpenAI-compatible endpoints. */
  baseUrl?: string
  /**
   * Environment variable name containing the API key, e.g. 'OPENAI_API_KEY'.
   * The actual key is never stored in the config object.
   */
  apiKeyEnvVar?: string
  /** Request timeout in milliseconds. */
  timeoutMs?: number
  /** Max retries on transient errors. */
  maxRetries?: number
  /** Sampling temperature. */
  temperature?: number
  /**
   * How the agent handles generation:
   * - 'manual'  → plan is shown in VS Code Quick Pick; user approves before code is emitted
   * - 'auto'    → plan is generated and applied without prompting
   * Default: 'manual'
   */
  approvalMode: 'manual' | 'auto'
}

const CONFIG_FILE = 'tcoe-testpilot.config.json'
const ENV_PREFIX = 'TCOE_'

/** Fields that can be set via TCOE_<NAME> env vars (upper-cased, underscores). */
const CONFIG_ENV_KEYS: Record<string, keyof ProviderConfig> = {
  TCOE_PROVIDER: 'provider',
  TCOE_MODEL: 'model',
  TCOE_BASE_URL: 'baseUrl',
  TCOE_API_KEY: 'apiKeyEnvVar',
  TCOE_TIMEOUT_MS: 'timeoutMs',
  TCOE_MAX_RETRIES: 'maxRetries',
  TCOE_TEMPERATURE: 'temperature',
  TCOE_APPROVAL_MODE: 'approvalMode',
}

function parseIntOrUndefined(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = parseInt(raw, 10)
  return isNaN(n) ? undefined : n
}

function loadFromEnv(): Partial<ProviderConfig> {
  const partial: Partial<ProviderConfig> = {}
  for (const [envKey, configKey] of Object.entries(CONFIG_ENV_KEYS)) {
    const value = process.env[envKey]
    if (value === undefined) continue
    if (configKey === 'timeoutMs' || configKey === 'maxRetries') {
      ;(partial as Record<string, unknown>)[configKey] = parseIntOrUndefined(value)
    } else if (configKey === 'approvalMode') {
      ;(partial as Record<string, unknown>)[configKey] = value === 'auto' ? 'auto' : 'manual'
    } else {
      ;(partial as Record<string, unknown>)[configKey] = value
    }
  }
  return partial
}

function loadFromFile(searchDir: string): Partial<ProviderConfig> {
  try {
    const raw = readFileSync(resolve(searchDir, CONFIG_FILE), 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const cfg = parsed as Record<string, unknown>
    // Only pick known keys to avoid spreading unknown fields.
    const allowed: (keyof ProviderConfig)[] = [
      'provider', 'model', 'baseUrl', 'timeoutMs', 'maxRetries', 'temperature', 'approvalMode',
    ]
    const result: Partial<ProviderConfig> = {}
    for (const key of allowed) {
      if (key in cfg) (result as Record<string, unknown>)[key] = cfg[key]
    }
    // apiKey in config is treated as an env-var reference, never a literal.
    if (typeof cfg['apiKey'] === 'string' && (cfg['apiKey'] as string).startsWith('env:')) {
      result['apiKeyEnvVar'] = (cfg['apiKey'] as string).slice(4)
    }
    return result
  } catch {
    return {}
  }
}

/**
 * Merge config sources into a final ProviderConfig.
 * The defaults are applied last so any source can override them.
 */
export function buildConfig(
  overrides: Partial<ProviderConfig> = {},
  projectRoot?: string,
): ProviderConfig {
  const defaults: ProviderConfig = {
    provider: 'mock',
    approvalMode: 'manual',
  }

  const fileCfg = loadFromFile(projectRoot ?? process.cwd())
  const envCfg = loadFromEnv()

  return {
    ...defaults,
    ...fileCfg,
    ...envCfg,
    ...overrides,
  }
}

/**
 * Return a safe-for-logging view of the config.
 * Secrets are replaced with `[REDACTED]`.
 */
export function safeConfigDump(cfg: ProviderConfig): ProviderConfig {
  return redactObject(cfg) as ProviderConfig
}

/** Attempt to resolve the actual API key from the configured env var name. */
export function resolveApiKey(cfg: ProviderConfig): string | undefined {
  if (!cfg.apiKeyEnvVar) return undefined
  return process.env[cfg.apiKeyEnvVar]
}

// re-export redactObject for convenience
export { redactObject }

/**
 * Validate a config and return a list of problems.
 * Returns an empty array when the config is valid.
 */
export function validateConfig(cfg: ProviderConfig): string[] {
  const errors: string[] = []
  if (cfg.provider === 'openai-compatible') {
    if (!cfg.baseUrl) errors.push('provider=openai-compatible requires baseUrl to be set.')
    if (!cfg.apiKeyEnvVar) errors.push('provider=openai-compatible requires apiKeyEnvVar (env var name) to be set.')
    else if (!process.env[cfg.apiKeyEnvVar]) errors.push(`apiKeyEnvVar "${cfg.apiKeyEnvVar}" is set but the env var is not present in the environment.`)
  }
  if (cfg.temperature !== undefined && (cfg.temperature < 0 || cfg.temperature > 2)) {
    errors.push('temperature must be between 0 and 2.')
  }
  return errors
}
