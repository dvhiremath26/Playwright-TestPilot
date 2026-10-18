/**
 * Browser tools package — Playwright CLI primary, Playwright MCP fallback.
 *
 * The CLI drives a real browser; MCP is the fallback when the CLI is unavailable or
 * cannot produce the structured evidence a task needs. Both backends are lazy — neither
 * is invoked as a side effect of analysis or planning.
 */

export type {
  BrowserActionResult,
  BrowserCallOptions,
  BrowserElementRef,
  BrowserSnapshot,
  BrowserTool,
  BrowserToolCapabilities,
  BrowserToolInfo,
} from './browser-types.ts'

export { PlaywrightCliAdapter } from './playwright-cli-adapter.ts'
export type { PlaywrightCliAdapterOptions } from './playwright-cli-adapter.ts'

export { PlaywrightMcpAdapter } from './playwright-mcp-adapter.ts'
export type { PlaywrightMcpAdapterOptions } from './playwright-mcp-adapter.ts'

export { BrowserSession } from './browser-orchestrator.ts'
export { createBrowserSession } from './browser-session-factory.ts'
export type { CreateBrowserSessionOptions } from './browser-session-factory.ts'
export type {
  BackendProvenance,
  BrowserEvidence,
  BrowserOperation,
  BrowserSessionOptions,
} from './browser-orchestrator.ts'

export { redact, spawnErrorCode, spawnErrorMessage } from './redaction-helpers.ts'

export {
  emitFrameworkStandard,
  emitLocators,
  emitPage,
  emitSpec,
  emitTestData,
  locatorToName,
  stepToMethodName,
  stepToVerb,
  validateEmittedCalls,
} from './framework-standard-emitter.ts'
export type {
  EmissionOptions,
  EmittedFile,
  LocatorEvidence,
  LocatorProvenance,
  ResolvedStep,
} from './framework-standard-emitter.ts'

export { buildEmissionOptions, unconfirmedVerbs } from './plan-emission.ts'
export type { EmissionBuild, EmissionInput, StepEmission } from './plan-emission.ts'
