/**
 * Fallback browser backend: the Playwright MCP server.
 *
 * `playwright mcp` runs an MCP (Model Context Protocol) server over stdio. This adapter
 * speaks the MCP protocol directly — initialize handshake, then tools/call — so no MCP
 * client library is required.
 *
 * Transport: newline-delimited JSON-RPC 2.0, as required by the MCP stdio transport.
 *
 * Tool names are the ones actually exported by the installed toolchain (verified by
 * enumerating `browser_*` symbols in playwright-core):
 *   browser_navigate, browser_snapshot, browser_find, browser_click, browser_type,
 *   browser_evaluate, browser_take_screenshot, browser_close
 *
 * MCP is the SECONDARY backend. It is used only when the primary (Playwright CLI) is
 * unavailable or cannot supply the evidence needed — for example when structured browser
 * inspection is required and the CLI's snapshot is not sufficient.
 */

import { spawn } from 'node:child_process'
import { redact, spawnErrorMessage } from './redaction-helpers.ts'

import type {
  BrowserActionResult,
  BrowserCallOptions,
  BrowserElementRef,
  BrowserSnapshot,
  BrowserTool,
  BrowserToolCapabilities,
  BrowserToolInfo,
} from './browser-types.ts'

const DEFAULT_TIMEOUT_MS = 30_000
/** MCP servers can be slow to first respond; allow a bit more on initialize. */
const INIT_TIMEOUT_MS = 15_000

/** Cap on how much we read from the server — screenshot payloads can be large. */
const MAX_STDOUT_BYTES = 256 * 1024

export interface PlaywrightMcpAdapterOptions {
  /** Command that launches the MCP server, e.g. 'playwright'. */
  command?: string
  /** Args that start the server, e.g. ['mcp']. Defaults to ['mcp']. */
  serverArgs?: string[]
  /** Extra args forwarded to the server, e.g. ['--codegen', 'typescript']. */
  extraServerArgs?: string[]
  /** Browser channel for the server. */
  browser?: string
  /** Allow the server to bind a non-localhost host. */
  allowedHosts?: string[]
  /** Working directory. */
  cwd?: string
  env?: Record<string, string>
}

interface RpcMessage {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/**
 * The Playwright MCP backend.
 *
 * A single server process is shared across calls and closed explicitly. The first call
 * performs the MCP initialize handshake; subsequent calls are plain tools/call.
 */
export class PlaywrightMcpAdapter implements BrowserTool {
  private readonly opts: PlaywrightMcpAdapterOptions
  private proc: ReturnType<typeof spawn> | null = null
  private nextId = 1
  private initialized = false
  private pending = new Map<number, { resolve: (m: RpcMessage) => void; reject: (e: Error) => void }>()
  private stderrBuf = ''
  private readonly elementDescriptions = new Map<string, string>()
  private readonly snapshotElements = new Map<string, { role?: string; name?: string }>()
  private readonly toolSchemas = new Map<string, Record<string, unknown>>()

  readonly info: BrowserToolInfo = {
    id: 'playwright-mcp',
    label: 'Playwright MCP',
  }

  constructor(opts: PlaywrightMcpAdapterOptions = {}) {
    this.opts = opts
  }

  /**
   * Availability is structural: the server command must be configured.
   * We deliberately do NOT probe by launching the server here — that is a real side
   * effect, and probing during capability checks would launch browsers in a loop.
   */
  get available(): boolean {
    return this.opts.command !== undefined
  }

  get capabilities(): BrowserToolCapabilities {
    return {
      canSnapshot: true,
      canNavigate: true,
      canInteract: true,
      canEvaluate: true,
      canScreenshot: true,
      // Derive a candidate only if the observed role/name pair is unique in the snapshot.
      canGenerateLocator: true,
    }
  }

  async goto(url: string, options?: BrowserCallOptions): Promise<BrowserActionResult> {
    return this.call('browser_navigate', { url }, options)
  }

  async navigate(url: string, options?: BrowserCallOptions): Promise<BrowserActionResult> {
    return this.call('browser_navigate', { url }, options)
  }

  async snapshot(target?: string, options?: BrowserCallOptions): Promise<BrowserActionResult> {
    return this.call('browser_snapshot', target ? { target } : {}, options)
  }

  async find(text: string, options?: BrowserCallOptions): Promise<BrowserActionResult> {
    return this.call('browser_find', { text }, options)
  }

  async click(target: string, options?: BrowserCallOptions): Promise<BrowserActionResult> {
    return this.call('browser_click', { target }, options)
  }

  async type(target: string, text: string, options?: BrowserCallOptions): Promise<BrowserActionResult> {
    return this.call('browser_type', { target, text, submit: false }, options)
  }

  /**
   * MCP does not expose a one-element fill primitive. Focus the observed target, select
   * its current contents, then type the replacement value using MCP's documented tools.
   */
  async fill(target: string, text: string, options?: BrowserCallOptions): Promise<BrowserActionResult> {
    const clicked = await this.call('browser_click', { target }, options)
    if (!clicked.ok) return clicked
    const selected = await this.call('browser_press_key', { key: 'Control+A' }, options)
    if (!selected.ok) return selected
    return this.call('browser_type', { target, text, submit: false }, options)
  }

  async eval(expression: string, target?: string, options?: BrowserCallOptions): Promise<BrowserActionResult> {
    return this.call('browser_evaluate', { function: expression, target }, options)
  }

  async screenshot(target?: string, options?: BrowserCallOptions): Promise<BrowserActionResult> {
    return this.call('browser_take_screenshot', target ? { target } : {}, options)
  }

  /** Derive a locator from the last MCP accessibility snapshot, refusing ambiguous matches. */
  async generateLocator(target: string, _options?: BrowserCallOptions): Promise<BrowserActionResult> {
    const observed = this.snapshotElements.get(target)
    if (!observed || (!observed.role && !observed.name)) {
      return { ok: false, error: `MCP snapshot ref ${target} has no role or accessible name to ground a locator.` }
    }
    const matching = [...this.snapshotElements.values()].filter((element) =>
      element.role === observed.role && element.name === observed.name,
    )
    if (matching.length !== 1) {
      return { ok: false, error: `MCP snapshot role/name is ambiguous (${matching.length} matches); no locator was generated.` }
    }

    const expression = observed.role && observed.name
      ? `getByRole(${JSON.stringify(observed.role)}, { name: ${JSON.stringify(observed.name)}, exact: true })`
      : observed.role
        ? `getByRole(${JSON.stringify(observed.role)})`
        : `getByText(${JSON.stringify(observed.name)}, { exact: true })`
    return { ok: true, output: expression }
  }

  async close(options?: BrowserCallOptions): Promise<BrowserActionResult> {
    // Stop the server rather than just closing the browser — the process is ours to own.
    this.killServer()
    return { ok: true, output: 'MCP server stopped.' }
  }

  /**
   * Parse an MCP snapshot response into the neutral form.
   *
   * MCP snapshot content format differs from the CLI's, and formats evolve between
   * releases. This parser extracts what it recognizes and always keeps the raw text, so a
   * format change degrades to "raw evidence available, refs unparsed" instead of throwing.
   */
  parseSnapshot(raw: string): BrowserSnapshot {
    const elements: BrowserElementRef[] = []
    const seen = new Set<string>()
    this.elementDescriptions.clear()
    this.snapshotElements.clear()

      // Accept the CLI/MCP snapshot ref format or a bare quoted uid.
    const refRe = /\[ref=([A-Za-z0-9_-]+)\]|\["(e[A-Za-z0-9_-]+)"\]/
    const roleRe = /^\s*[-*]?\s*([a-z][a-z0-9-]*)\s+/i

    for (const line of raw.split(/\r?\n/)) {
      const m = refRe.exec(line)
      if (!m) continue
      const ref = m[1] ?? m[2]
      if (!ref || seen.has(ref)) continue
      seen.add(ref)

      const roleMatch = roleRe.exec(line)
      const nameMatch = /"([^"]+)"/.exec(line)
      elements.push({
        ref,
        role: roleMatch?.[1] ?? undefined,
        name: nameMatch?.[1] ?? undefined,
        actionable: true,
      })
      const description = [roleMatch?.[1], nameMatch?.[1]].filter(Boolean).join(' ')
      if (description) this.elementDescriptions.set(ref, description)
      this.snapshotElements.set(ref, { role: roleMatch?.[1], name: nameMatch?.[1] })
    }

    return { raw, elements, capturedAt: new Date().toISOString() }
  }

  /** Perform the MCP initialize handshake, once. */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return

    const res = await this.send(
      'initialize',
      {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'tcoe-testpilot', version: '0.1.0' },
      },
      INIT_TIMEOUT_MS,
    )

    if (res.error) throw new Error(`MCP initialize failed: ${res.error.message}`)
    void this.notify('notifications/initialized')
    const tools = await this.send('tools/list', {}, INIT_TIMEOUT_MS)
    if (tools.error) throw new Error(`MCP tools/list failed: ${tools.error.message}`)
    const result = tools.result as { tools?: Array<{ name?: string; inputSchema?: Record<string, unknown> }> } | undefined
    for (const tool of result?.tools ?? []) {
      if (tool.name && tool.inputSchema) this.toolSchemas.set(tool.name, tool.inputSchema)
    }
    this.initialized = true
  }

  /** Invoke an MCP tool. */
  private async call(
    tool: string,
    args: Record<string, unknown>,
    options?: BrowserCallOptions,
  ): Promise<BrowserActionResult> {
    if (!this.opts.command) {
      return {
        ok: false,
        error: 'Playwright MCP is not configured. Set command to npx and serverArgs to ["-y", "@playwright/mcp@latest"].',
      }
    }
    if (options?.signal?.aborted) return { ok: false, error: 'Aborted before starting.' }

    try {
      await this.ensureInitialized()
      const res = await this.send('tools/call', { name: tool, arguments: this.adaptArguments(tool, args) }, options?.timeoutMs)
      if (res.error) {
        return { ok: false, error: redact(`MCP ${tool}: ${res.error.message}`).slice(0, 600) }
      }
      return this.resultToAction(tool, res.result)
    } catch (err) {
      return { ok: false, error: redact(String(err)).slice(0, 600) }
    }
  }

  /** Bridge the neutral target API to the parameter names required by the MCP server version. */
  private adaptArguments(tool: string, args: Record<string, unknown>): Record<string, unknown> {
    const schema = this.toolSchemas.get(tool)
    const properties = (schema?.properties ?? {}) as Record<string, unknown>
    const required = Array.isArray(schema?.required) ? schema.required as string[] : []
    const adapted = { ...args }
    const target = typeof args.target === 'string' ? args.target : undefined
    if (target && !('target' in properties) && 'ref' in properties) {
      delete adapted.target
      adapted.ref = target
    }
    if (target && required.includes('element') && !('element' in adapted)) {
      adapted.element = this.elementDescriptions.get(target) ?? target
    }
    if (tool === 'browser_type' && 'submit' in properties && !('submit' in adapted)) {
      adapted.submit = false
    }
    if (Object.keys(properties).length > 0) {
      for (const key of Object.keys(adapted)) {
        if (!(key in properties)) delete adapted[key]
      }
    }
    return adapted
  }

  /** Translate an MCP tool result into the neutral action result. */
  private resultToAction(tool: string, result: unknown): BrowserActionResult {
    // MCP tool results are typically { content: [{ type: 'text', text: '...' }], isError?: boolean }
    const r = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> } | undefined
    if (!r || typeof r !== 'object') {
      return { ok: true, output: result === undefined ? undefined : String(result), data: result }
    }
    if (r.isError) {
      const text = (r.content ?? []).map((c) => c.text ?? '').join('\n')
      return { ok: false, error: redact(text || `MCP ${tool} reported an error`).slice(0, 600) }
    }
    const text = (r.content ?? []).map((c) => c.text ?? '').join('\n')
    return { ok: true, output: text, data: r.content }
  }

  /** Send a JSON-RPC request with a per-call timeout. */
  private send(method: string, params: unknown, timeoutMs?: number): Promise<RpcMessage> {
    return this.spawnIfAbsent().then(() => this.request(method, params, timeoutMs))
  }

  /** Fire a notification (no response expected). */
  private notify(method: string): void {
    if (!this.proc) return
    this.proc.stdin?.write(this.frame({ jsonrpc: '2.0', method }))
  }

  private request(method: string, params: unknown, timeoutMs?: number): Promise<RpcMessage> {
    const id = this.nextId++
    return new Promise<RpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`))
      }, timeoutMs ?? DEFAULT_TIMEOUT_MS)

      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.proc?.stdin?.write(this.frame({ jsonrpc: '2.0', id, method, params }))
    })
  }

  private spawnIfAbsent(): Promise<void> {
    if (this.proc) return Promise.resolve()
    if (!this.opts.command) {
      return Promise.reject(new Error('MCP command not configured'))
    }

    const command = this.opts.command
    return new Promise<void>((resolve, reject) => {
      const args = [
        ...(this.opts.serverArgs ?? ['mcp']),
        ...(this.opts.extraServerArgs ?? []),
        ...(this.opts.browser ? ['--browser', this.opts.browser] : []),
        ...(this.opts.allowedHosts?.length ? ['--allowed-hosts', this.opts.allowedHosts.join(',')] : []),
      ]

      const child = spawn(command, args, {
        cwd: this.opts.cwd,
        env: { ...process.env, ...(this.opts.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      })

      this.proc = child
      this.stderrBuf = ''

      child.on('error', (err) => {
        const message = spawnErrorMessage(err, command)
        this.pending.forEach((p) => p.reject(new Error(message)))
        this.pending.clear()
        this.proc = null
        if (!this.initialized) reject(new Error(message))
      })

      child.on('close', () => {
        this.proc = null
        this.pending.forEach((p) => p.reject(new Error('MCP server exited')))
        this.pending.clear()
      })

      // MCP stdio uses one JSON-RPC message per line. Ignore non-JSON startup chatter,
      // which some package launchers can emit, but never confuse it with a response.
      let buf = ''
      child.stdout.on('data', (chunk: Buffer) => {
        if (buf.length > MAX_STDOUT_BYTES) {
          buf = ''
          return
        }
        buf += chunk.toString('utf-8')
        for (;;) {
          const newline = buf.indexOf('\n')
          if (newline < 0) break
          const line = buf.slice(0, newline).trim()
          buf = buf.slice(newline + 1)
          if (line) this.dispatch(line)
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (this.stderrBuf.length < MAX_STDOUT_BYTES) this.stderrBuf += chunk.toString('utf-8')
      })

      resolve()
    })
  }

  private dispatch(body: string): void {
    let msg: RpcMessage
    try {
      msg = JSON.parse(body) as RpcMessage
    } catch {
      return
    }
    if (msg.id === undefined) return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    p.resolve(msg)
  }

  private frame(msg: RpcMessage): string {
    return `${JSON.stringify(msg)}\n`
  }

  private killServer(): void {
    if (!this.proc) return
    this.proc.kill('SIGTERM')
    this.proc = null
  }
}
