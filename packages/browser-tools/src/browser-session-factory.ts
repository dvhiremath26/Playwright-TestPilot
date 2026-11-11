import { BrowserSession } from './browser-orchestrator.ts'
import { PlaywrightCliAdapter, type PlaywrightCliAdapterOptions } from './playwright-cli-adapter.ts'
import { PlaywrightMcpAdapter, type PlaywrightMcpAdapterOptions } from './playwright-mcp-adapter.ts'
import { IsolatedCdpBrowser } from './isolated-cdp-browser.ts'

export interface CreateBrowserSessionOptions {
  /** Repository used as the browser tools' working directory. */
  repositoryRoot: string
  /** Working directory for browser sessions and CLI snapshot/log artifacts. */
  workingDirectory?: string
  /** Optional overrides for the primary Playwright CLI backend. */
  cli?: Omit<PlaywrightCliAdapterOptions, 'cwd'>
  /** Configure MCP fallback explicitly; it is not launched unless the primary needs fallback. */
  mcp?: Omit<PlaywrightMcpAdapterOptions, 'cwd'>
  /** Shared browser endpoint. Both backends attach to the same live page and authentication state. */
  cdpEndpoint?: string
}

/** Construct the normal CLI-primary browser session with an optional MCP fallback. */
export function createBrowserSession(options: CreateBrowserSessionOptions): BrowserSession {
  const cwd = options.workingDirectory ?? options.repositoryRoot
  const primary = new PlaywrightCliAdapter({ ...options.cli, cdpEndpoint: options.cdpEndpoint ?? options.cli?.cdpEndpoint, cwd })
  const mcp = options.cdpEndpoint
    ? {
        ...options.mcp,
        extraServerArgs: [...(options.mcp?.extraServerArgs ?? []), `--cdp-endpoint=${options.cdpEndpoint}`],
      }
    : options.mcp
  const fallback = mcp?.command
    ? new PlaywrightMcpAdapter({ ...mcp, cwd })
    : undefined
  return new BrowserSession({ primary, fallback })
}
