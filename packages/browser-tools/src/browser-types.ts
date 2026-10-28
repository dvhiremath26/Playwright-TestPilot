/**
 * Provider-neutral browser tool contract.
 *
 * Two backends implement this:
 * - Playwright CLI  (primary) — drives a real browser via the `playwright-cli` binary
 * - Playwright MCP  (fallback) — speaks the MCP tool protocol (`browser_*` tools)
 *
 * The contract is defined by the *capabilities we actually verified on the installed toolchain*,
 * not by what we assume the tools can do. Commands were enumerated from `cli-client/help.json`
 * on @playwright/cli 0.1.19 in the target framework repo.
 *
 * Nothing here invents command names, MCP tool names, or snapshot formats. If a capability is
 * not present in both backends, it is marked optional and callers must handle absence.
 */

/** Stable identity of a browser backend, for provenance and diagnostics. */
export interface BrowserToolInfo {
  /** Short backend id: 'playwright-cli' or 'playwright-mcp'. */
  readonly id: 'playwright-cli' | 'playwright-mcp'
  /** Human-readable label for reports. */
  readonly label: string
  /** Backend version string, or undefined when the backend could not report it. */
  readonly version?: string
  /** Why this backend is unavailable, if it is. */
  readonly unavailableReason?: string
}

/**
 * Result of a browser interaction.
 *
 * `ok` is true only when the tool reported success. `error` is never thrown across the
 * provider boundary for expected failures — callers branch on `ok`.
 */
export interface BrowserActionResult {
  ok: boolean
  /** Backend-reported output, e.g. a snapshot or the value a locator evaluated to. */
  output?: string
  /** Structured detail when the backend provides it (eval results, network, etc.). */
  data?: unknown
  error?: string
}

/** Page state reference produced by a snapshot — the anchor for subsequent interactions. */
export interface BrowserSnapshot {
  /** Raw accessibility snapshot text. */
  raw: string
  /** Element references found, when the backend exposes them. */
  elements: BrowserElementRef[]
  /** Whether this snapshot is fresh enough to interact against. */
  capturedAt: string
}

/** A single referenceable element from a snapshot. */
export interface BrowserElementRef {
  /** Backend-specific reference key, e.g. a CLI `-s`/ref id or an MCP element uid. */
  ref: string
  /** Element role as reported by the backend. */
  role?: string
  /** Accessible name / visible text. */
  name?: string
  /** Whether the element is actionable at snapshot time. */
  actionable?: boolean
}

/** Options for snapshot/search calls that may need a time budget. */
export interface BrowserCallOptions {
  /** Abort an in-flight browser call. */
  signal?: AbortSignal
  /** Per-call timeout in ms. Backend-specific; ignored when unsupported. */
  timeoutMs?: number
}

/**
 * The neutral interface. Both backends must implement it, or leave a method returning
 * `{ ok: false, error: 'not supported by this backend' }`.
 *
 * Returning a failure result rather than throwing keeps a partial backend usable: a backend that
 * can snapshot but cannot evaluate is still worth falling back to for evidence gathering.
 */
export interface BrowserTool {
  readonly info: BrowserToolInfo

  /** Is this backend actually usable right now? Cheap; must not launch a browser. */
  readonly available: boolean

  /** Open a browser session at an initial URL. Implicitly creates a new session. */
  goto(url: string, options?: BrowserCallOptions): Promise<BrowserActionResult>

  /** Navigate within an existing session. */
  navigate(url: string, options?: BrowserCallOptions): Promise<BrowserActionResult>

  /** Capture the current page snapshot — the primary evidence source. */
  snapshot(target?: string, options?: BrowserCallOptions): Promise<BrowserActionResult>

  /** Parse a snapshot result into a normalized form. Pure; no browser I/O. */
  parseSnapshot(raw: string): BrowserSnapshot

  /** Search the current page for text. CLI: `find`. MCP: snapshot + client-side search. */
  find(text: string, options?: BrowserCallOptions): Promise<BrowserActionResult>

  /** Click an element target. */
  click(target: string, options?: BrowserCallOptions): Promise<BrowserActionResult>

  /** Type into an editable element without clearing it. */
  type(target: string, text: string, options?: BrowserCallOptions): Promise<BrowserActionResult>

  /** Fill an editable element, replacing its contents. */
  fill(target: string, text: string, options?: BrowserCallOptions): Promise<BrowserActionResult>

  /** Check a checkbox or radio using the backend's idempotent check operation. */
  check?(target: string, options?: BrowserCallOptions): Promise<BrowserActionResult>

  /** Uncheck a checkbox using the backend's idempotent uncheck operation. */
  uncheck?(target: string, options?: BrowserCallOptions): Promise<BrowserActionResult>

  /** Evaluate a JavaScript expression on the page or an element. Evidence-gathering only. */
  eval(expression: string, target?: string, options?: BrowserCallOptions): Promise<BrowserActionResult>

  /**
   * Resolve an element reference into a Playwright locator expression.
   *
   * This is how locators become observed rather than invented: the browser backend
   * decides which locator is correct for the element it actually saw. Callers must not
   * hand-derive a selector instead of asking.
   *
   * CLI: `generate-locator <target>` (verified on the installed CLI).
   * MCP: derives a role/name locator from the latest snapshot only when that pair is unique.
   */
  generateLocator(target: string, options?: BrowserCallOptions): Promise<BrowserActionResult>

  /** Screenshot for attachment to a plan or report. */
  screenshot(target?: string, options?: BrowserCallOptions): Promise<BrowserActionResult>

  /** Close the browser session. Idempotent. */
  close(options?: BrowserCallOptions): Promise<BrowserActionResult>
}

/**
 * Capability flags describing what a backend can actually do.
 *
 * Used so a caller can decide whether browser evidence is even worth requesting, instead of
 * discovering mid-flow that the primary backend cannot do the one thing it needed.
 */
export interface BrowserToolCapabilities {
  canSnapshot: boolean
  canNavigate: boolean
  canInteract: boolean
  canEvaluate: boolean
  canScreenshot: boolean
  /**
   * Can resolve a snapshot ref into a Playwright locator. False when the backend
   * cannot, so a caller knows to fall back rather than invent a selector.
   */
  canGenerateLocator: boolean
}
