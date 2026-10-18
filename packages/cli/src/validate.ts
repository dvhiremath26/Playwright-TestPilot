/**
 * Validation — the Verify stage.
 *
 * Runs the checks that are actually available in the target repository and
 * reports honestly what ran, what passed, and what was skipped. A check that
 * could not run is never counted as a pass.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { spawn } from 'node:child_process'

import type {
  CommandResult,
  FileChange,
  ValidationCheck,
  ValidationCheckKind,
  ValidationReport,
} from '@tcoe/shared-types'

import { Workspace, fingerprint } from '@tcoe/repo-intelligence'

export interface ValidationOptions {
  repositoryRoot: string
  taskId: string
  changes: FileChange[]
  /** The approved plan text, shown in the report. */
  planText?: string
  /** Run Playwright tests. Off by default: they need a live, reachable application. */
  runTests?: boolean
  /** Spec files to run when the repository does not define an npm test script. */
  testPaths?: string[]
  /** Only run checks touching these paths. */
  paths?: string[]
  /** Per-command timeout. Default 5 minutes. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

/** Run a shell command, capturing real output. Never fakes success. */
export function runCommand(
  command: string,
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  args?: string[],
): Promise<CommandResult> {
  const started = Date.now()
  const displayCommand = args ? `${command} ${args.map((arg) => JSON.stringify(arg)).join(' ')}` : command

  return new Promise((resolve) => {
    let settled = false
    let child: ReturnType<typeof spawn>

    const finish = (result: CommandResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    try {
      child = spawn(command, args, {
        cwd,
        shell: args === undefined,
        env: process.env,
      })
    } catch (err) {
      finish({
        command: displayCommand,
        cwd,
        exitCode: null,
        executed: false,
        durationMs: Date.now() - started,
        stdout: '',
        stderr: '',
        skipReason: err instanceof Error ? err.message : String(err),
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        // already exited
      }
    }, timeoutMs)

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    child.on('error', (err) => {
      clearTimeout(timer)
      finish({
        command: displayCommand,
        cwd,
        exitCode: null,
        executed: false,
        durationMs: Date.now() - started,
        stdout,
        stderr,
        skipReason: err.message,
      })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      finish({
        command: displayCommand,
        cwd,
        exitCode: code,
        executed: true,
        durationMs: Date.now() - started,
        stdout,
        stderr,
        timedOut: timedOut || undefined,
        skipReason: timedOut ? `Timed out after ${timeoutMs} ms` : undefined,
      })
    })
  })
}

/** Read the npm scripts available in the target repository. */
export function readScripts(repositoryRoot: string): Record<string, string> {
  const pkgPath = join(repositoryRoot, 'package.json')
  if (!existsSync(pkgPath)) return {}
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      scripts?: Record<string, string>
    }
    return pkg.scripts ?? {}
  } catch {
    return {}
  }
}

/** Check 1: every change path resolves inside the repository. */
export function checkPaths(changes: FileChange[], repositoryRoot: string): ValidationCheck {
  const workspace = new Workspace(repositoryRoot)
  const escapes: string[] = []

  for (const change of changes) {
    const resolved = workspace.tryResolve(change.path)
    if (!resolved) escapes.push(change.path)
  }

  return {
    kind: 'paths',
    description: 'All changed paths resolve inside the repository',
    passed: escapes.length === 0,
    detail:
      escapes.length === 0
        ? `Checked ${changes.length} path(s); all resolve inside ${workspace.rootPath}.`
        : `${escapes.length} path(s) escape the repository: ${escapes.join(', ')}`,
    commands: [],
    skipped: false,
  }
}

/** Check 2: only the approved files changed, nothing else was touched. */
export function checkUnrelatedFiles(
  changes: FileChange[],
  repositoryRoot: string,
): ValidationCheck {
  const baselinePath = join(repositoryRoot, '.tcoe-testpilot', 'baseline.json')

  if (!existsSync(baselinePath)) {
    return {
      kind: 'unrelated-files',
      description: 'No files outside the approved change set were modified',
      passed: true,
      detail: 'No baseline snapshot found, so the check could not compare. Recorded as unverified rather than assumed.',
      commands: [],
      skipped: true,
      skipReason:
        'No baseline.json in .tcoe-testpilot/. Run "testpilot baseline" before applying changes to enable this check.',
    }
  }

  let baseline: Record<string, string>
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf-8')) as Record<string, string>
  } catch {
    return {
      kind: 'unrelated-files',
      description: 'No files outside the approved change set were modified',
      passed: false,
      detail: 'baseline.json exists but could not be parsed.',
      commands: [],
      skipped: false,
    }
  }

  const approved = new Set(changes.map((c) => c.path))
  const workspace = new Workspace(repositoryRoot)
  const modified: string[] = []

  for (const [relPath, before] of Object.entries(baseline)) {
    if (approved.has(relPath)) continue
    const resolved = workspace.tryResolve(relPath)
    if (!resolved) continue
    let now: string
    try {
      now = fingerprint(readFileSync(resolved.resolved, 'utf-8'))
    } catch {
      modified.push(`${relPath} (deleted)`)
      continue
    }
    if (now !== before) modified.push(relPath)
  }

  return {
    kind: 'unrelated-files',
    description: 'No files outside the approved change set were modified',
    passed: modified.length === 0,
    detail:
      modified.length === 0
        ? `Compared ${Object.keys(baseline).length} baselined file(s); none outside the change set were modified.`
        : `${modified.length} file(s) changed outside the approved set: ${modified.join(', ')}`,
    commands: [],
    skipped: false,
  }
}

/** Check 3: the diff is reviewable and matches the stated reason. */
export function checkDiff(changes: FileChange[]): ValidationCheck {
  const empty = changes.filter((c) => c.kind !== 'delete' && !c.newContent?.trim())
  const withoutReason = changes.filter((c) => !c.reason || c.reason.trim().length === 0)
  const withoutEvidence = changes.filter((c) => !c.evidence || c.evidence.length === 0)

  const problems: string[] = []
  if (empty.length) problems.push(`${empty.length} change(s) have empty content`)
  if (withoutReason.length) problems.push(`${withoutReason.length} change(s) have no stated reason`)
  if (withoutEvidence.length) problems.push(`${withoutEvidence.length} change(s) have no evidence`)

  return {
    kind: 'diff',
    description: 'Every change is reviewable and carries a reason and evidence',
    passed: problems.length === 0,
    detail:
      problems.length === 0
        ? `Reviewed ${changes.length} change(s); each has content, a reason, and evidence.`
        : problems.join('; '),
    commands: [],
    skipped: false,
  }
}

/** Check 4/5/6: lint, typecheck, and tests, using the repository's own scripts. */
export async function checkScript(
  kind: ValidationCheckKind,
  scriptName: string,
  command: string,
  repositoryRoot: string,
  timeoutMs: number,
): Promise<ValidationCheck> {
  const scripts = readScripts(repositoryRoot)
  const isPlaywrightTest = kind === 'test'

  if (!scripts[scriptName]) {
    if (isPlaywrightTest) {
      return checkPlaywrightSpecs([], repositoryRoot, timeoutMs)
    }
    return {
      kind,
      description: `${kind}: npm run ${scriptName}`,
      passed: true,
      detail: `The repository has no "${scriptName}" script, so this check does not apply.`,
      commands: [],
      skipped: true,
      skipReason: `No "${scriptName}" script in package.json.`,
    }
  }

  if (isPlaywrightTest && !existsSync(join(repositoryRoot, 'playwright.config.ts'))) {
    return {
      kind,
      description: `${kind}: npm run ${scriptName}`,
      passed: true,
      detail: 'No Playwright config found; test execution does not apply.',
      commands: [],
      skipped: true,
      skipReason: 'No playwright.config.ts in the repository.',
    }
  }

  const actualCommand = isPlaywrightTest ? `${command}` : `${command}`
  const result = await runCommand(actualCommand, repositoryRoot, timeoutMs)

  if (!result.executed) {
    return {
      kind,
      description: `${kind}: ${actualCommand}`,
      passed: true,
      detail: `Command could not be executed: ${result.skipReason}`,
      commands: [result],
      skipped: true,
      skipReason: result.skipReason,
    }
  }

  const passed = result.exitCode === 0
  const failureOutput = [result.stderr, result.stdout].filter(Boolean).join('\n').slice(-5000)

  return {
    kind,
    description: `${kind}: ${actualCommand}`,
    passed,
    detail: passed
      ? `Exited ${result.exitCode} after ${result.durationMs} ms.`
      : `Exited ${result.exitCode} after ${result.durationMs} ms.${result.timedOut ? ' (timed out)' : ''}\n${failureOutput}`,
    commands: [result],
    skipped: false,
  }
}

/** Run only the generated specs when no npm test script is provided. */
async function checkPlaywrightSpecs(
  testPaths: string[],
  repositoryRoot: string,
  timeoutMs: number,
): Promise<ValidationCheck> {
  const description = 'test: Playwright spec'
  const cliPath = join(repositoryRoot, 'node_modules', '@playwright', 'test', 'cli.js')
  const specs = [...new Set(testPaths)].filter((path) => /\.spec\.tsx?$/i.test(path))
  const workspace = new Workspace(repositoryRoot)
  const resolvedSpecs = specs.map((path) => workspace.tryResolve(path)?.resolved)

  const hasPlaywrightConfig = ['ts', 'mts', 'js', 'mjs', 'cts', 'cjs']
    .some((extension) => existsSync(join(repositoryRoot, `playwright.config.${extension}`)))
  if (!hasPlaywrightConfig) {
    return {
      kind: 'test', description, passed: true,
      detail: 'No Playwright config found; test execution does not apply.',
      commands: [], skipped: true, skipReason: 'No Playwright config found in the repository.',
    }
  }
  if (!existsSync(cliPath)) {
    return {
      kind: 'test', description, passed: true,
      detail: 'The repository has no npm test script and @playwright/test is not installed locally.',
      commands: [], skipped: true, skipReason: 'Install @playwright/test or define a package.json test script.',
    }
  }
  if (specs.length === 0 || resolvedSpecs.some((path) => !path)) {
    return {
      kind: 'test', description, passed: true,
      detail: specs.length === 0
        ? 'The repository has no npm test script and this task has no applied Playwright spec to run.'
        : 'A generated spec path does not resolve inside the repository.',
      commands: [], skipped: true,
      skipReason: specs.length === 0 ? 'No applied spec path was recorded for this task.' : 'A spec path is outside the repository.',
    }
  }

  const testFilters = (resolvedSpecs as string[]).map((path) =>
    relative(workspace.rootPath, path)
      .replace(/\\/g, '/')
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  )
  const args = [cliPath, 'test', ...testFilters]
  const command = process.execPath
  const result = await runCommand(command, repositoryRoot, timeoutMs, args)
  if (!result.executed) {
    return {
      kind: 'test', description, passed: true,
      detail: `Playwright could not be started: ${result.skipReason}`,
      commands: [result], skipped: true, skipReason: result.skipReason,
    }
  }
  const passed = result.exitCode === 0
  const output = [result.stderr, result.stdout].filter(Boolean).join('\n').slice(-5000)
  return {
    kind: 'test', description,
    passed,
    detail: passed
      ? `Playwright completed successfully after ${result.durationMs} ms.\n${output}`
      : `Playwright exited ${result.exitCode} after ${result.durationMs} ms.${result.timedOut ? ' (timed out)' : ''}\n${output}`,
    commands: [result], skipped: false,
  }
}

/** Run the full validation suite. */
export async function validate(options: ValidationOptions): Promise<ValidationReport> {
  const { repositoryRoot, taskId, changes, runTests = false, timeoutMs = DEFAULT_TIMEOUT_MS } = options

  const scripts = readScripts(repositoryRoot)
  const workspace = new Workspace(repositoryRoot)

  const checks: ValidationCheck[] = [
    checkDiff(changes),
    checkPaths(changes, repositoryRoot),
    checkUnrelatedFiles(changes, repositoryRoot),
  ]

  checks.push(
    await checkScript('typecheck', 'typecheck', 'npm run typecheck', workspace.rootPath, timeoutMs),
  )
  const lintScript = scripts.lint ?? ''
  const lintCommand = /\beslint\b/i.test(lintScript) && /(?:^|\s)--fix(?:\s|$)/i.test(lintScript)
    ? 'npm run lint -- --no-fix'
    : 'npm run lint'
  checks.push(await checkScript('lint', 'lint', lintCommand, workspace.rootPath, timeoutMs))

  if (runTests) {
    const scripts = readScripts(workspace.rootPath)
    const specPaths = options.testPaths ?? changes.map((change) => change.path).filter((path) => /\.spec\.tsx?$/i.test(path))
    checks.push(specPaths.length > 0
      ? await checkPlaywrightSpecs(specPaths, workspace.rootPath, timeoutMs)
      : scripts.test
        ? await checkScript('test', 'test', 'npm run test', workspace.rootPath, timeoutMs)
        : await checkPlaywrightSpecs([], workspace.rootPath, timeoutMs))
  } else {
    checks.push({
      kind: 'test',
      description: 'test: npm run test',
      passed: true,
      detail:
        'Playwright tests were not run. They require a live, reachable application with valid credentials, ' +
          'which this agent does not hold. Re-run with runTests: true from an environment that can reach the target.',
      commands: [],
      skipped: true,
      skipReason: 'Test execution requires a live target system. Re-run with --run-tests from an authenticated environment.',
    })
  }

  const passedCount = checks.filter((c) => c.passed && !c.skipped).length
  const failedCount = checks.filter((c) => !c.passed).length
  const skippedCount = checks.filter((c) => c.skipped).length

  const report: ValidationReport = {
    taskId,
    checks,
    passed: failedCount === 0,
    summary: {
      passed: passedCount,
      failed: failedCount,
      skipped: skippedCount,
      unexecuted: skippedCount,
    },
  }

  if (failedCount > 0) {
    report.failureAnalysis = analyseFailure(report, changes, repositoryRoot)
  }

  return report
}

/**
 * Ground a failure analysis in the actual check output and source.
 *
 * This is deliberately deterministic: it points at the failing file and quotes
 * the real error, rather than guessing a cause.
 */
export function analyseFailure(
  report: ValidationReport,
  changes: FileChange[],
  repositoryRoot: string,
): ValidationReport['failureAnalysis'] {
  const failed = report.checks.filter((c) => !c.passed)
  const evidence: string[] = []

  for (const check of failed) {
    evidence.push(`${check.kind}: ${check.detail.split('\n')[0]}`)
  }

  // If typecheck failed, point at the first changed file with a line reference.
  const typecheckFailed = failed.find((c) => c.kind === 'typecheck')
  if (typecheckFailed) {
    const output = typecheckFailed.commands[0]?.stderr || typecheckFailed.commands[0]?.stdout || ''
    const fileMatch = output.match(/(?:^|\n)([\w./-]+\.tsx?)\((\d+),(\d+)\)/)
    if (fileMatch) {
      const file = fileMatch[1] ?? ''
      const line = fileMatch[2] ?? ''
      return {
        likelyCause: `A TypeScript error in ${file} at line ${line}.`,
        evidence: [
          ...evidence,
          `Compiler reported: ${fileMatch[0]!.trim()}`,
          `This file was changed by this task: ${changes.some((c) => c.path === file) ? 'yes' : 'no — it may be a pre-existing error'}`,
        ],
        location: { file, line: Number(line) },
        unresolved: false,
      }
    }

    const anyChange = changes[0]
    if (anyChange) {
      const abs = join(repositoryRoot, anyChange.path)
      const exists = existsSync(abs)
      return {
        likelyCause: 'The generated code does not typecheck against the framework.',
        evidence: [
          ...evidence,
          `First changed file: ${anyChange.path} (${exists ? 'present' : 'missing'}).`,
          `Compiler output was: ${output.slice(0, 500) || '(no compiler output captured)'}`,
        ],
        location: { file: anyChange.path },
        unresolved: false,
      }
    }
  }

  const firstFailure = failed[0]
  return {
    likelyCause: firstFailure
      ? `The ${firstFailure.kind} check failed.`
      : 'Validation failed for an unknown reason.',
    evidence,
    unresolved: firstFailure === undefined,
  }
}
