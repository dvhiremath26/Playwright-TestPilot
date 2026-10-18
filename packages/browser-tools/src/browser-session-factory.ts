import { BrowserSession } from './browser-orchestrator.ts'
import { PlaywrightCliAdapter, type PlaywrightCliAdapterOptions } from './playwright-cli-adapter.ts'
import { PlaywrightMcpAdapter, type PlaywrightMcpAdapterOptions } from './playwright-mcp-adapter.ts'

export interface CreateBrowserSessionOptions {
  /** Repository used as the browser tools' working directory. */
  repositoryRoot: string
  /** Working directory for browser sessions and CLI snapshot/log artifacts. */
  workingDirectory?: string
  /** Optional overrides for the primary Playwright CLI backend. */
  cli?: Omit<PlaywrightCliAdapterOptions, 'cwd'>
  /** Configure MCP fallback explicitly; it is not launched unless the primary needs fallback. */
  mcp?: Omit<PlaywrightMcpAdapterOptions, 'cwd'>
}

/** Construct the normal CLI-primary browser session with an optional MCP fallback. */
export function createBrowserSession(options: CreateBrowserSessionOptions): BrowserSession {
  const cwd = options.workingDirectory ?? options.repositoryRoot
  const primary = new PlaywrightCliAdapter({ ...options.cli, cwd })
  const fallback = options.mcp?.command
    ? new PlaywrightMcpAdapter({ ...options.mcp, cwd })
    : undefined
  return new BrowserSession({ primary, fallback })
}
