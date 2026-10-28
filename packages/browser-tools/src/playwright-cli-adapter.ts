/**
 * Primary browser backend: the Playwright CLI.
 *
 * Invokes the `playwright-cli` binary from @playwright/cli and passes commands as
 * top-level arguments — `playwright-cli snapshot`, not `playwright cli snapshot`.
 * That was confirmed against the installed toolchain (@playwright/cli 0.1.19 in
 * TCOE-Playwright-Framework/node_modules): the entry point reads the command from the
 * first positional arg, so there is no `cli` subcommand.
 *
 * Commands verified present in `cli-client/help.json` for 0.1.19:
 *   open, attach, detach, close, goto, resume, snapshot, find, generate-locator, eval,
 *   click, dblclick, fill, type, press, select, check, uncheck, hover, dialog-accept,
 *   dialog-dismiss, screenshot, state-save, state-load, list, close-all, kill-all,
 *   delete-data, install
 *
 * Global flags: --raw, --json, -s=<session>.
 *
 * Element refs are the `e15`-style identifiers the CLI snapshot emits.
 *
 * This backend spawns a real browser. It is NEVER launched automatically as part of
 * analysis or planning — only when browser evidence has been explicitly requested.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

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

/** Default per-command timeout. The CLI's own session idle timeout is separate. */
const DEFAULT_TIMEOUT_MS = 30_000

/** How many parent directories to search upward for a local binary. */
const MAX_PARENT_SEARCH = 5

export interface PlaywrightCliAdapterOptions {
  /** Command to invoke. Defaults to resolving `playwright-cli` from PATH or local installs. */
  command?: string
  /**
   * Extra args prepended to every invocation.
   * Defaults to none: the `playwright-cli` binary takes commands as top-level args
   * (verified against @playwright/cli 0.1.19 — `playwright-cli open <url>`).
   */
  baseArgs?: string[]
  /** Named session. Omit for the CLI's implicit default session. */
  session?: string
  /** Additional env vars passed to the child. */
  env?: Record<string, string>
  /** Working directory for the child process. */
  cwd?: string
  /** Browser channel: chrome, firefox, webkit, msedge. */
  browser?: string
  /** Run headed. Defaults to headless. */
  headed?: boolean
  /** Max output bytes to retain per call. Prevents memory growth on chatty pages. */
  maxOutputBytes?: number
}

/**
 * Resolve the CLI entry point.
 *
 * Preference order, matching the official README:
 *   1. An explicitly configured command.
 *   2. The installed binary `playwright-cli` on PATH (from `@playwright/cli`).
 *   3. A project-local `node_modules/.bin/playwright-cli`.
 *
 * Returns undefined when nothing resolves, so the adapter reports unavailable rather
 * than spawning a command that does not exist.
 */
interface CommandInvocation {
  command: string
  prefixArgs: string[]
}

function resolveCommand(opts: PlaywrightCliAdapterOptions): CommandInvocation | undefined {
  if (opts.command) return { command: opts.command, prefixArgs: [] }
  for (const dir of searchDirs(opts)) {
    // npm's Windows .bin directory contains a POSIX shell shim named
    // `playwright-cli` as well as a Windows `.cmd` wrapper. `spawn(...,
    // { shell: false })` cannot execute the POSIX shim on Windows, and invoking
    // the .cmd wrapper would require passing arguments through a shell. Resolve
    // the package entry point and pass it to Node instead; this is safe on every
    // platform and preserves argv boundaries for URLs and locator expressions.
    const entryPoint = join(dir, '..', '@playwright', 'cli', 'playwright-cli.js')
    try {
      if (existsSync(entryPoint)) {
        const node = resolveNodeExecutable()
        if (node) return { command: node, prefixArgs: [entryPoint] }
        return undefined
      }
    } catch {
      // Keep searching if this package location is unreadable.
    }

    const candidate = join(dir, 'playwright-cli')
    try {
      if (existsSync(candidate)) return { command: candidate, prefixArgs: [] }
    } catch {
      // Unreadable directory: keep searching rather than failing the whole probe.
    }
  }
  const command = whichSync('playwright-cli')
  if (!command) return undefined
  // Windows PATH discovery typically returns a .CMD shim, which cannot be
  // spawned with shell:false. Do not silently select it; local package lookup
  // above handles the normal npm install case without shell interpolation.
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) return undefined
  return { command, prefixArgs: [] }
}

/**
 * VS Code runs extensions inside Electron, where `process.execPath` can point at
 * Code.exe rather than node.exe. Playwright CLI starts its daemon with
 * `process.execPath`; launching the CLI through Electron makes that daemon parse
 * its own script filename as an extra positional argument. Prefer the system Node
 * executable so both the CLI and its child daemon run as ordinary Node processes.
 */
function resolveNodeExecutable(): string | undefined {
  const node = whichSync('node')
  if (node) return node
  return process.versions['electron'] ? undefined : process.execPath
}

/** Directories to search for a project-local binary, nearest first. */
function searchDirs(opts: PlaywrightCliAdapterOptions): string[] {
  const roots = [opts.cwd ?? process.cwd(), process.cwd()]
  const dirs: string[] = []
  for (const root of roots) {
    let dir = root
    // Walk up so the binary is found from any nested package.
    for (let i = 0; i < MAX_PARENT_SEARCH; i++) {
      dirs.push(join(dir, 'node_modules', '.bin'))
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return [...new Set(dirs)]
}

/**
 * Look up a bare command on PATH.
 *
 * Deliberately does not spawn a probe process: `available` is called during capability
 * checks, and launching a process there would be a side effect.
 */
function whichSync(command: string): string | undefined {
  const pathVar = process.env['PATH']
  if (!pathVar) return undefined
  const isWindows = process.platform === 'win32'
  const exts = isWindows ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of pathVar.split(isWindows ? ';' : ':')) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, command + ext)
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        // Ignore unreadable PATH entries.
      }
    }
  }
  return undefined
}

/** Quote a single argument for display/logging purposes only — never for execution. */
function quoteForLog(arg: string): string {
  return /[\s"'\\]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg
}

/**
 * The Playwright CLI backend.
 *
 * Instantiating this is cheap and safe. `available` is lazily evaluated on first
 * interaction; it does not spawn a browser during construction.
 */
export class PlaywrightCliAdapter implements BrowserTool {
  private readonly opts: PlaywrightCliAdapterOptions
  private sessionCreated = false

  readonly info: BrowserToolInfo = {
    id: 'playwright-cli',
    label: 'Playwright CLI',
  }

  constructor(opts: PlaywrightCliAdapterOptions = {}) {
    this.opts = opts
  }

  /**
   * Cheap availability check. Verifies the binary resolves without launching a browser.
   * Does NOT open a session — that would be a side effect during capability probing.
   */
  get available(): boolean {
    return resolveCommand(this.opts) !== undefined
  }

  get capabilities(): BrowserToolCapabilities {
    return {
      canSnapshot: true,
      canNavigate: true,
      canInteract: true,
      canEvaluate: true,
      canScreenshot: true,
      canGenerateLocator: true,
    }
  }

  async goto(url: string, options?: BrowserCallOptions): Promise<BrowserActionResult> {
    // `open` both launches the session and navigates, so a single call establishes state.
    const browserArgs = this.openArgs()
    const result = await this.run(['open', url, ...browserArgs], options)
    this.sessionCreated = result.ok || this.sessionCreated
    return result
  }

  async navigate(url: string, options?: BrowserCallOptions): Promise<BrowserActionResult> {
    return this.run(['goto', url], options)
  }

  async snapshot(target?: string, options?: BrowserCallOptions): Promise<BrowserActionResult> {
    const args = target === undefined ? ['snapshot'] : ['snapshot', target]
    return this.run(args, options)
  }

  async find(text: string, options?: BrowserCallOptions): Promise<BrowserActionResult> {
    return this.run(['find', text], options)
  }

  async click(target: string, options?: BrowserCallOptions): Promise<BrowserActionResult> {
    return this.run(['click', target], options)
  }

  async type(target: string, text: string, options?: BrowserCallOptions): Promise<BrowserActionResult> {
    return this.run(['type', target, text], options)
  }

  async fill(target: string, text: string, options?: BrowserCallOptions): Promise<BrowserActionResult> {
    return this.run(['fill', target, text], options)
  }

  async check(target: string, options?: BrowserCallOptions): Promise<BrowserActionResult> {
    return this.run(['check', target], options)
  }

  async uncheck(target: string, options?: BrowserCallOptions): Promise<BrowserActionResult> {
    return this.run(['uncheck', target], options)
  }

  async eval(expression: string, target?: string, options?: BrowserCallOptions): Promise<BrowserActionResult> {
    // `eval <func> [target]` — target is optional and positional, per the CLI help.
    return this.run(['eval', expression, ...(target === undefined ? [] : [target])], options)
  }

  async screenshot(target?: string, options?: BrowserCallOptions): Promise<BrowserActionResult> {
    // Screenshot returns binary-ish output; cap it and surface a note rather than dumping bytes.
    const args = target === undefined ? ['screenshot'] : ['screenshot', target]
    return this.run(args, options, { binary: true })
  }

  /**
   * Resolve a snapshot ref into a Playwright locator.
   *
   * `--raw` is a verified global flag (@playwright/cli 0.1.19) and returns the bare
   * expression, e.g. `getByRole('button', { name: 'Submit' })`, without the surrounding
   * report. A ref that no longer resolves comes back as a failure, which is the correct
   * signal: the element moved or the snapshot is stale.
   */
  async generateLocator(target: string, options?: BrowserCallOptions): Promise<BrowserActionResult> {
    return this.run(['--raw', 'generate-locator', target], options)
  }

  /**
   * Close the session.
   *
   * The CLI's `close` reports failure when there is nothing open. We treat that as success
   * here: a close that has already happened is idempotent by intent, and callers should not
   * be made to guess whether a session existed before asking for it to go away.
   */
  async close(options?: BrowserCallOptions): Promise<BrowserActionResult> {
    const result = await this.run(['close'], options)
    if (!result.ok && /no.*session|not.*open|already.*closed/i.test(result.error ?? '')) {
      return { ok: true, output: 'No open session.' }
    }
    return result
  }

  /**
   * Parse CLI snapshot text into a normalized form.
   *
   * The CLI emits accessibility-tree lines carrying element refs such as `e15`.
   * This parser is deliberately tolerant: it extracts whatever refs and roles it can see
   * and never fails the call over a format it doesn't recognize. A snapshot is evidence;
   * partial parsing is still useful, so we keep the raw text regardless.
   */
  parseSnapshot(raw: string): BrowserSnapshot {
    const elements: BrowserElementRef[] = []
    const seen = new Set<string>()

    // Match referenced accessibility-tree lines like `text "Sign in" [ref=e15]`,
    // plus text-only nodes like `paragraph [ref=e16]: Result text`.
    const lineRe = /^\s*[-*]?\s*([a-z][a-z0-9-]*)\s+(.*)$/i
    const refRe = /\[ref=([A-Za-z0-9_-]+)\]/

    for (const line of raw.split(/\r?\n/)) {
      const refMatch = refRe.exec(line)
      if (!refMatch) continue
      const ref = refMatch[1]
      if (!ref || seen.has(ref)) continue
      seen.add(ref)

      const structural = lineRe.exec(line.replace(refRe, '').trim())
      elements.push({
        ref,
        role: structural?.[1] ?? undefined,
        name: extractSnapshotName(line),
        actionable: true,
      })
    }

    return { raw, elements, capturedAt: new Date().toISOString() }
  }

  /** Build the args that make `open` start a named/headed session. */
  private openArgs(): string[] {
    const args: string[] = []
    if (this.opts.browser) args.push('--browser', this.opts.browser)
    if (this.opts.headed) args.push('--headed')
    return args
  }

  /**
   * Execute one CLI command.
   *
   * Never interpolates user input into a shell string — args are passed as an array,
   * so the CLI receives them verbatim. This matters because targets and expressions come
   * from parsed test-case text, which may contain shell metacharacters.
   */
  private async run(
    args: string[],
    options?: BrowserCallOptions,
    flags: { binary?: boolean } = {},
  ): Promise<BrowserActionResult> {
    const invocation = resolveCommand(this.opts)
    if (!invocation) {
      return {
        ok: false,
        error: 'Playwright CLI is not configured. Set command (e.g. "playwright") or install @playwright/cli.',
      }
    }

    if (options?.signal?.aborted) {
      return { ok: false, error: 'Aborted before starting.' }
    }

    const baseArgs = this.opts.baseArgs ?? []
    const allArgs = [...baseArgs, ...(this.opts.session ? [`-s=${this.opts.session}`] : []), ...args]
    const timeout = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS

    try {
      const out = await runChild(invocation.command, [...invocation.prefixArgs, ...allArgs], {
        cwd: this.opts.cwd,
        env: this.opts.env,
        timeoutMs: timeout,
        signal: options?.signal,
        maxBytes: this.opts.maxOutputBytes,
        binary: flags.binary,
      })

      return out.ok
        ? { ok: true, output: out.stdout, data: out.data }
        : { ok: false, error: formatError(args, out) }
    } catch (err) {
      return {
        ok: false,
        error: formatError(args, { exitCode: -1, stderr: String(err) }),
      }
    }
  }
}

/** Extract the first quoted string from a snapshot line as the element name. */
function extractQuotedText(line: string): string | undefined {
  const m = /"([^"]+)"/.exec(line)
  return m?.[1]
}

/** Extract visible text from both quoted accessible names and unquoted paragraph/text nodes. */
function extractSnapshotName(line: string): string | undefined {
  const quoted = extractQuotedText(line)
  if (quoted) return quoted
  const value = /\[ref=[A-Za-z0-9_-]+\]\s*:\s*(\S.*)$/.exec(line)?.[1]?.trim()
  return value || undefined
}

/** Format a failure without leaking the target's raw text into logs. */
function formatError(args: string[], out: { exitCode: number; stdout?: string; stderr: string }): string {
  const shown = args.slice(0, 2).map(quoteForLog).join(' ')
  const output = [out.stderr, out.stdout].filter((part) => part?.trim()).join('\n')
  const detail = redact(output.slice(-1000)).trim()
  return `Playwright CLI "${shown}" failed (exit ${out.exitCode}): ${detail || 'no diagnostic output'}`
}

interface RunChildResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number
  data?: unknown
}

interface RunChildOpts {
  cwd?: string
  env?: Record<string, string>
  timeoutMs: number
  signal?: AbortSignal
  maxBytes?: number
  binary?: boolean
}

/**
 * Spawn a child process with a hard timeout and abort support.
 *
 * Truncates rather than retaining unbounded output: a chatty page can emit megabytes,
 * and there is no reason to keep more than the caller needs.
 */
function runChild(command: string, args: string[], opts: RunChildOpts): Promise<RunChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })

    let stdout = ''
    let stderr = ''
    let killed = false
    let settled = false
    const cap = opts.maxBytes ?? 256 * 1024

    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGTERM')
    }, opts.timeoutMs)

    const onAbort = () => {
      if (!settled) {
        killed = true
        child.kill('SIGTERM')
      }
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < cap) stdout += chunk.toString('utf-8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < cap) stderr += chunk.toString('utf-8')
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      reject(new Error(spawnErrorMessage(err, command)))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        exitCode: code ?? -1,
      })
    })
  })
}

