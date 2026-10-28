/**
 * Primary/fallback orchestration for browser evidence.
 *
 * Strategy, per requirement:
 *   1. Playwright CLI  — primary. Drives a real browser, fastest to get evidence with.
 *   2. Playwright MCP  — fallback. Used when the CLI is unavailable or cannot produce
 *      the structured evidence the task needs.
 *
 * This orchestrator is invoked ONLY when browser evidence has been explicitly requested.
 * Nothing in the analysis or planning path launches a browser on its own. That matters:
 * a browser launch is a real side effect against a real application, possibly requiring
 * credentials, and it must never be triggered as an incidental consequence of reading
 * a test case.
 *
 * Evidence gathering is the point of this layer, not test authoring. It returns what was
 * observed — snapshots, element refs, evaluated values — so a plan can cite real locators
 * instead of guessing them.
 */

import type {
  BrowserActionResult,
  BrowserCallOptions,
  BrowserSnapshot,
  BrowserTool,
  BrowserToolCapabilities,
} from './browser-types.ts'

/** Which backend handled a request, and whether a fallback occurred. */
export interface BackendProvenance {
  backendId: 'playwright-cli' | 'playwright-mcp'
  backendLabel: string
  fellBack: boolean
  /** Why the primary did not handle the call, when a fallback occurred. */
  fallbackReason?: string
}

/** A single observed fact, ready to be cited as evidence in a plan. */
export interface BrowserEvidence {
  kind: 'snapshot' | 'eval' | 'find' | 'navigation' | 'interaction' | 'screenshot'
  detail: string
  source: BackendProvenance
}

export interface BrowserSessionOptions {
  /** Primary backend. */
  primary: BrowserTool
  /** Fallback backend. May be undefined when no fallback is configured. */
  fallback?: BrowserTool
  /** Session-wide default timeout. */
  timeoutMs?: number
}

/**
 * A browser session that transparently falls back from primary to secondary.
 *
 * Once a fallback backend has been engaged, it remains the active backend for the
 * session's remainder. Re-switching back and forth would lose browser state, and an
 * interaction stream that alternates backends is not reproducible — which is exactly
 * what we need evidence to be.
 */
export class BrowserSession {
  private readonly primary: BrowserTool
  private readonly fallback?: BrowserTool
  private readonly timeoutMs?: number
  private activeBackendId: 'playwright-cli' | 'playwright-mcp' | undefined
  private fallbackReason: string | undefined

  constructor(opts: BrowserSessionOptions) {
    this.primary = opts.primary
    this.fallback = opts.fallback
    this.timeoutMs = opts.timeoutMs
  }

  /** The backend currently serving requests, if any. */
  get activeBackend(): BrowserTool | undefined {
    return this.activeBackendId === 'playwright-mcp'
      ? this.fallback
      : this.primary
  }

  /** True once the session has engaged the fallback backend. */
  get usedFallback(): boolean {
    return this.activeBackendId === 'playwright-mcp'
  }

  /** Which backend would serve this call. */
  get provenance(): BackendProvenance | undefined {
    const active = this.activeBackend
    if (!active) return undefined
    return {
      backendId: active.info.id,
      backendLabel: active.info.label,
      fellBack: this.usedFallback,
      fallbackReason: this.fallbackReason,
    }
  }

  /** Report capabilities of the currently active backend. */
  get capabilities(): BrowserToolCapabilities | undefined {
    const active = this.activeBackend as
      | (BrowserTool & { capabilities?: BrowserToolCapabilities })
      | undefined
    return active?.capabilities
  }

  /** Switch deliberately to MCP when the primary snapshot cannot support a step match. */
  activateFallback(reason: string): boolean {
    if (!this.fallback?.available || this.usedFallback) return false
    this.fallbackReason = reason
    this.activeBackendId = 'playwright-mcp'
    return true
  }

  /**
   * Run a browser call with fallback.
   *
   * Fallback is attempted only when the primary is structurally unavailable or returns a
   * failure that plausibly means "cannot do this" — not when the call failed because of
   * genuinely wrong input. Re-issuing the same bad input to another backend would just
   * produce a second failure with no new information.
   */
  async execute(
    operation: BrowserOperation,
    options?: BrowserCallOptions,
  ): Promise<BrowserActionResult & { provenance: BackendProvenance }> {
    const opts = this.withDefaults(options)

    const primaryActive = !this.usedFallback
    if (primaryActive) {
      const primary = this.primary
      if (primary && primary.available) {
        const result = await this.invoke(primary, operation, opts)
        if (result.ok) {
          return { ...result, provenance: this.makeProvenance(primary.info.id, false) }
        }
        // Decide whether the fallback is worth engaging.
        if (this.shouldFallBack(result.error)) {
          this.fallbackReason = result.error
        } else {
          return { ...result, provenance: this.makeProvenance(primary.info.id, false) }
        }
      }
    }

    const fallback = this.fallback
    if (fallback) {
      this.activeBackendId = 'playwright-mcp'
      if (!fallback.available) {
        return {
          ok: false,
          error: `Fallback backend "${fallback.info.label}" is unavailable.`,
          provenance: this.makeProvenance('playwright-mcp', true),
        }
      }
      const result = await this.invoke(fallback, operation, opts)
      return { ...result, provenance: this.makeProvenance('playwright-mcp', true) }
    }

    return {
      ok: false,
      error:
        this.fallbackReason ??
        'Primary backend is unavailable and no fallback is configured.',
      provenance: this.makeProvenance('playwright-cli', false),
    }
  }

  /** Navigate, capturing navigation evidence. */
  async navigate(url: string, options?: BrowserCallOptions): Promise<BrowserEvidence> {
    const r = await this.execute((t) => t.goto(url, options), options)
    return {
      kind: 'navigation',
      detail: r.ok ? `Navigated to ${url}` : `Navigation failed: ${r.error}`,
      source: r.provenance,
    }
  }

  /** Wait for load + network idle on the currently active backend. */
  async waitForPageReady(options?: BrowserCallOptions): Promise<BrowserActionResult & { provenance: BackendProvenance }> {
    return this.execute(
      (tool, callOptions) => tool.waitForPageReady
        ? tool.waitForPageReady(callOptions)
        : Promise.resolve({ ok: true, output: 'Backend does not expose an explicit page readiness wait.' }),
      options,
    )
  }

  /**
   * Capture a snapshot and normalize it.
   *
   * This is the primary evidence primitive: everything else in the browser layer exists
   * to help produce or interpret a snapshot.
   */
  async capture(target?: string, options?: BrowserCallOptions): Promise<BrowserSnapshot | undefined> {
    const r = await this.execute((t) => t.snapshot(target, options), options)
    if (!r.ok) return undefined
    return this.activeBackend?.parseSnapshot(r.output ?? '')
  }

  /** Ask the active browser backend to derive a locator from an observed snapshot ref. */
  async generateLocator(target: string, options?: BrowserCallOptions): Promise<BrowserActionResult & { provenance: BackendProvenance }> {
    return this.execute((tool, callOptions) => tool.generateLocator(target, callOptions), options)
  }

  /** Evaluate an expression for evidence, never to assert. */
  async evaluate(expression: string, target?: string, options?: BrowserCallOptions): Promise<BrowserEvidence> {
    const r = await this.execute((t) => t.eval(expression, target, options), options)
    return {
      kind: 'eval',
      detail: r.ok ? String(r.output ?? r.data ?? '').slice(0, 400) : `eval failed: ${r.error}`,
      source: r.provenance,
    }
  }

  /**
   * Teardown. The active backend is closed; the other is closed too if it was ever engaged,
   * since a half-open browser process left behind is exactly the kind of leak that makes
   * repeated runs unreliable.
   */
  async close(options?: BrowserCallOptions): Promise<void> {
    const opts = this.withDefaults(options)
    const toClose: BrowserTool[] = []
    if (this.primary) toClose.push(this.primary)
    if (this.fallback && this.usedFallback) toClose.push(this.fallback)

    for (const tool of toClose) {
      try {
        await tool.close(opts)
      } catch {
        // Closing must never throw out of teardown; a hung close is reported as a warning
        // upstream, not as an exception that masks the real result.
      }
    }
  }

  /** Decide whether a primary failure justifies engaging the fallback. */
  private shouldFallBack(error: string | undefined): boolean {
    if (!error) return false
    const lower = error.toLowerCase()

    // Genuine input errors are checked FIRST. They are not worth retrying elsewhere —
    // the same bad input fails identically on the fallback, producing a second failure
    // with no new information. "target not found" must not be mistaken for the
    // unavailability pattern below, which also contains the words "not found".
    if (/target|selector|no element|cannot find|not visible|not interactive|stale/i.test(lower)) {
      return false
    }

    // Structural unavailability → worth trying the fallback.
    if (/not configured|command not found|unavailable|enoent/i.test(lower)) return true
    // A tool that doesn't exist on this backend version → the fallback may have it.
    if (/unknown command|unknown tool|not recognized|no such tool|is not a command/i.test(lower)) {
      return true
    }
    // Broken CLI daemon startup/argument parsing is a backend failure, not a bad locator.
    if (/daemon process exited|process exited with code|too many arguments|failed to launch|econnreset|epipe/i.test(lower)) {
      return true
    }

    return false
  }

  private async invoke(
    tool: BrowserTool,
    operation: BrowserOperation,
    options: BrowserCallOptions | undefined,
  ): Promise<BrowserActionResult> {
    try {
      return await operation(tool, options)
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }

  private withDefaults(options?: BrowserCallOptions): BrowserCallOptions {
    return { ...options, timeoutMs: options?.timeoutMs ?? this.timeoutMs }
  }

  private makeProvenance(
    id: 'playwright-cli' | 'playwright-mcp',
    fellBack: boolean,
  ): BackendProvenance {
    const tool = id === 'playwright-mcp' ? this.fallback : this.primary
    return {
      backendId: id,
      backendLabel: tool?.info.label ?? id,
      fellBack,
      fallbackReason: fellBack ? this.fallbackReason : undefined,
    }
  }
}

/** An operation to run against whichever backend is active. */
export type BrowserOperation = (tool: BrowserTool, options?: BrowserCallOptions) => Promise<BrowserActionResult>
