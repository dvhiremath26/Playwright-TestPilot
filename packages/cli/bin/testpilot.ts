#!/usr/bin/env node
/**
 * TCOE TestPilot CLI.
 *
 * Commands:
 *   testpilot analyze [options]        Analyze the framework and print the discovery report.
 *   testpilot plan [options]          Normalize a test case, analyze, and produce a plan. Writes nothing to the framework.
 *   testpilot apply <taskId>          Write a previously approved plan's changes.
 *   testpilot validate <taskId>        Run validation checks for a task.
 *   testpilot report <taskId>          Print the final report for a task.
 *   testpilot config                  Show the resolved provider config with secrets masked.
 *   testpilot baseline                Snapshot repository fingerprints for the unrelated-files check.
 *
 * Run with: npm run cli -- <command> [options]
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { runAgent, generateChanges, generateRepairChanges, InputValidationError } from '../src/runner.ts'
import { applyChanges, loadTask, saveTask, snapshotRepository, verifyRepositorySnapshot, recordStage } from '../src/apply.ts'
import { validate } from '../src/validate.ts'
import { analyzeFramework, summariseAnalysis, Workspace, fingerprint } from '@tcoe/repo-intelligence'
import { detect, workbookToCsv, workbookColumnHeaders, ambiguousExcelColumns } from '@tcoe/adapters'
import type { ExcelColumnField, ExcelColumnMapping } from '@tcoe/adapters'
import { buildConfig, safeConfigDump, validateConfig } from '@tcoe/provider-abstraction'
import type { ProviderConfig } from '@tcoe/provider-abstraction'
import { renderReport } from '../src/report.ts'
import { createBrowserSession } from '@tcoe/browser-tools'

const DEFAULT_STATE_DIR_NAME = '.tcoe-testpilot'

interface Args {
  command: string
  positional: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!
    if (token.startsWith('--')) {
      const name = token.slice(2)
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next
        i++
      } else {
        flags[name] = true
      }
    } else {
      positional.push(token)
    }
  }

  return { command, positional, flags }
}

function resolveRepoRoot(flags: Args['flags']): string {
  const root = typeof flags['repo'] === 'string' ? flags['repo'] : process.cwd()
  return resolve(isAbsolute(root) ? root : join(process.cwd(), root))
}

/**
 * Build a provider config override from CLI flags.
 *
 * Only the environment variable *name* is ever read here; the key value stays
 * in the environment and is resolved at request time by the provider.
 */
function providerOverridesFromFlags(flags: Args['flags']): Partial<ProviderConfig> {
  const out: Partial<ProviderConfig> = {}
  const provider = typeof flags['provider'] === 'string' ? flags['provider'] : undefined
  if (provider === 'mock' || provider === 'vscode-lm' || provider === 'openai-compatible') {
    out.provider = provider
  } else if (provider !== undefined) {
    throw new Error(`Unknown --provider "${provider}". Expected "mock", "vscode-lm", or "openai-compatible".`)
  }
  if (typeof flags['model'] === 'string') out.model = flags['model']
  if (typeof flags['base-url'] === 'string') out.baseUrl = flags['base-url']
  if (typeof flags['api-key-env'] === 'string') out.apiKeyEnvVar = flags['api-key-env']
  return out
}

function resolveStateDir(flags: Args['flags'], repositoryRoot: string): string {
  if (typeof flags['state-dir'] === 'string') {
    return resolve(isAbsolute(flags['state-dir']) ? flags['state-dir'] : join(process.cwd(), flags['state-dir']))
  }
  return join(repositoryRoot, DEFAULT_STATE_DIR_NAME)
}

async function readInput(flags: Args['flags']): Promise<string> {
  if (typeof flags['file'] === 'string') {
    const path = resolve(isAbsolute(flags['file']) ? flags['file'] : join(process.cwd(), flags['file']))
    if (!existsSync(path)) throw new Error(`Input file not found: ${path}`)
    if (/\.xlsx$/i.test(path)) {
      const bytes = readFileSync(path)
      const worksheet = typeof flags['worksheet'] === 'string' ? flags['worksheet'] : undefined
      const headers = await workbookColumnHeaders(bytes, worksheet)
      const mapping: ExcelColumnMapping = {}
      const fields: ExcelColumnField[] = ['title', 'action', 'expected', 'precondition', 'application', 'stepIndex', 'status']
      for (const field of fields) {
        const selected = flags[`column-${field}`]
        if (typeof selected === 'string') {
          const index = Number(selected)
          if (!Number.isInteger(index) || index < 1 || index > headers.length) {
            throw new Error(`--column-${field} must be a 1-based column number from 1 to ${headers.length}.`)
          }
          mapping[field] = index
        } else if (ambiguousExcelColumns(headers).includes(field)) {
          throw new Error(`Excel column "${field}" needs your selection. Headers: ${headers.map((header, index) => `${index + 1}=${header}`).join(', ')}. Pass --column-${field} <number>.`)
        }
      }
      return workbookToCsv(bytes, worksheet, mapping)
    }
    return readFileSync(path, 'utf-8')
  }
  if (flags['stdin'] === true) {
    try {
      return readFileSync(0, 'utf-8')
    } catch {
      throw new Error('Could not read from stdin. Pass --file <path> instead.')
    }
  }
  if (typeof flags['text'] === 'string') {
    return flags['text']
  }
  throw new Error(
    'No test case input provided. Use --file <path>, --text "<case>", or pipe content and pass --stdin.',
  )
}

function resolveTargetUrl(flags: Args['flags']): string | undefined {
  if (typeof flags['target-url'] !== 'string') return undefined
  let url: URL
  try {
    url = new URL(flags['target-url'])
  } catch {
    throw new Error('--target-url must be an absolute URL.')
  }
  if (url.username || url.password) {
    throw new Error('--target-url must not contain embedded credentials; use an authenticated browser state instead.')
  }
  return url.toString()
}

function printHelp(): void {
  process.stdout.write(`
TCOE TestPilot — agentic test generation for Playwright TypeScript frameworks

Usage: npm run cli -- <command> [options]

Commands
  analyze                    Analyze the framework and print the discovery report
  plan                       Normalize a test case, analyze the framework, produce a plan
  generate <taskId>          Generate framework-conformant proposal files from an approved plan
  apply <taskId>             Write an approved plan's changes to the framework
  validate <taskId>          Run validation checks against applied changes
  report <taskId>            Print the final report for a task
  resume <taskId>            Resume a saved task after checking source and Git state
  map-locator <taskId>       Map an observed browser ref to one unresolved plan step
  repair <taskId>            Propose a bounded repair from failed validation output
  config                     Show resolved provider config (secrets masked)
  baseline                   Snapshot file fingerprints for the unrelated-files check

Common options
  --repo <path>              Framework repository root (default: current directory)
  --state-dir <path>         Where task state is written (default: <repo>/.tcoe-testpilot)
  --file <path>              Read the manual test case from a file
  --worksheet <name>         Worksheet to read from an .xlsx file (default: first worksheet)
  --column-<field> <number>  Select a 1-based Excel column for title/action/expected/precondition/application/stepIndex/status when ambiguous
  --text <string>            Inline manual test case text
  --stdin                    Read the manual test case from stdin
  --provider <id>            mock | openai-compatible  (overrides config)
  --model <id>               Model id to request
  --base-url <url>           OpenAI-compatible base URL
  --api-key-env <name>       Environment variable holding the API key
  --read-only                Do not write the framework index
  --browse                   Explicitly open the target URL and collect a page snapshot during planning
  --target-url <url>         Required with --browse; must not contain embedded credentials
  --browser-mcp-command <cmd> Optional MCP fallback executable
  --browser-mcp-args <args>  Optional space-separated MCP server arguments (default: mcp)
  --dry-run                  Preview without writing
  --run-tests                Also run the framework's test command (needs a live system)

Examples
  npm run cli -- analyze --repo ../TCOE-Playwright-Framework
  npm run cli -- plan --repo ../TCOE-Playwright-Framework --file ./case.md
  npm run cli -- generate <taskId> --repo ../TCOE-Playwright-Framework
  npm run cli -- apply <taskId> --repo ../TCOE-Playwright-Framework --dry-run
  npm run cli -- validate <taskId> --repo ../TCOE-Playwright-Framework
  npm run cli -- resume <taskId> --repo ../TCOE-Playwright-Framework
  npm run cli -- map-locator <taskId> --step 2 --ref e15 --repo ../TCOE-Playwright-Framework
  npm run cli -- repair <taskId> --repo ../TCOE-Playwright-Framework
`)
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const { command, positional, flags } = args

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      printHelp()
      return 0

    case 'config': {
      const cfg = buildConfig(
        {
          provider: typeof flags['provider'] === 'string' ? (flags['provider'] as never) : undefined,
          model: typeof flags['model'] === 'string' ? flags['model'] : undefined,
          baseUrl: typeof flags['base-url'] === 'string' ? flags['base-url'] : undefined,
          apiKeyEnvVar: typeof flags['api-key-env'] === 'string' ? flags['api-key-env'] : undefined,
        } as never,
        resolveRepoRoot(flags),
      )
      const problems = validateConfig(cfg)
      process.stdout.write(JSON.stringify(safeConfigDump(cfg), null, 2) + '\n')
      if (problems.length > 0) {
        process.stdout.write('\nConfiguration problems:\n')
        for (const p of problems) process.stdout.write(`  - ${p}\n`)
      }
      return problems.length > 0 ? 1 : 0
    }

    case 'analyze': {
      const repositoryRoot = resolveRepoRoot(flags)
      const stateDir = resolveStateDir(flags, repositoryRoot)
      const result = analyzeFramework({
        repositoryRoot,
        indexDir: flags['read-only'] === true ? undefined : join(stateDir, 'index'),
        persistIndex: flags['read-only'] !== true,
      })
      process.stdout.write(summariseAnalysis(result) + '\n')
      if (typeof flags['json'] === 'string' || flags['json'] === true) {
        const outPath = typeof flags['json'] === 'string' ? flags['json'] : join(process.cwd(), 'framework-report.json')
        writeFileSync(outPath, JSON.stringify(result.report, null, 2), 'utf-8')
        process.stdout.write(`\nReport written to ${outPath}\n`)
      }
      return 0
    }

    case 'plan': {
      const repositoryRoot = resolveRepoRoot(flags)
      const stateDir = resolveStateDir(flags, repositoryRoot)
      const raw = await readInput(flags)

      const browse = flags['browse'] === true
      const targetUrl = resolveTargetUrl(flags)
      if (browse && !targetUrl) throw new Error('--browse requires --target-url <url>.')
      const mcpCommand = typeof flags['browser-mcp-command'] === 'string'
        ? flags['browser-mcp-command']
        : undefined
      const mcpArgs = typeof flags['browser-mcp-args'] === 'string'
        ? flags['browser-mcp-args'].split(/\s+/).filter(Boolean)
        : ['mcp']
      const browser = browse
        ? createBrowserSession({
            repositoryRoot,
            mcp: mcpCommand ? { command: mcpCommand, serverArgs: mcpArgs } : undefined,
          })
        : undefined

      const result = await runAgent({
        repositoryRoot,
        rawTestCase: raw,
        stateDir,
        readOnly: flags['read-only'] === true,
        config: providerOverridesFromFlags(flags),
        browser,
        targetUrl,
      })

      const taskPath = saveTask(stateDir, result.task)

      process.stdout.write('\n')
      process.stdout.write(renderReport(result.task, result.planText, result.usedMockProvider))
      if (result.evidence.length > 0) {
        process.stdout.write('\nBrowser evidence (page-level; not yet mapped to individual test steps):\n')
        for (const item of result.evidence) {
          process.stdout.write(`  ${item.kind} via ${item.source.backendLabel}:\n`)
          for (const line of item.detail.split('\n')) process.stdout.write(`    ${line}\n`)
        }
      }
      if (result.browserLocatorCandidates.length > 0) {
        process.stdout.write('\nObserved locator candidates (choose explicitly with map-locator):\n')
        for (const item of result.browserLocatorCandidates) {
          process.stdout.write(`  ${item.ref}: ${item.role ?? 'element'} ${item.name ?? ''} → ${item.expression}\n`)
        }
      }
      process.stdout.write('\n')
      process.stdout.write(`\nTask state saved to ${taskPath}\n`)
      process.stdout.write(result.browserLocatorCandidates.length > 0
        ? `Next: review the plan, optionally map an observed element with "npm run cli -- map-locator ${result.task.taskId} --step <number> --ref <ref>", then generate.\n`
        : `Next: review the plan, then run "npm run cli -- generate ${result.task.taskId}" to produce file content.\n`)

      if (result.usedMockProvider) {
        process.stdout.write(
          '\nNOTE: the mock provider produced this plan. It is deterministic and offline; it has\n' +
            '      not been verified against a real model. Set a provider and API key for real generation.\n',
        )
      }
      return 0
    }

    case 'generate': {
      const taskId = positional[0]
      if (!taskId) {
        process.stderr.write('Usage: testpilot generate <taskId>\n')
        return 1
      }
      const repositoryRoot = resolveRepoRoot(flags)
      const stateDir = resolveStateDir(flags, repositoryRoot)
      const task = loadTask(stateDir, taskId)
      if (!task) {
        process.stderr.write(`Task not found: ${taskId}\nLooked in ${stateDir}\n`)
        return 1
      }
      if (task.status !== 'AwaitingApproval') {
        process.stderr.write(
          `Task ${taskId} is in status "${task.status}". Generation only runs from AwaitingApproval, ` +
            'which is the point where a human has reviewed the plan.\n',
        )
        return 1
      }
      if (!task.plan || task.plan.length === 0) {
        process.stderr.write(`Task ${taskId} has no plan to generate from.\n`)
        return 1
      }
      const drift = verifyRepositorySnapshot(repositoryRoot, task.repositorySnapshot)
      if (drift.length > 0) {
        process.stderr.write(`Task ${taskId} is stale; refusing to generate from changed source:\n${drift.map((reason) => `  - ${reason}`).join('\n')}\nRe-run plan to refresh the task.\n`)
        return 1
      }

      // Re-analyze so the generator sees the current repository, not a stale one.
      const analysis = analyzeFramework({ repositoryRoot })

      const changes = await generateChanges({
        task,
        analysis,
        plan: task.plan,
        repositoryRoot,
      })

      task.proposedChanges = changes
      saveTask(stateDir, task)

      process.stdout.write(`\nGenerated ${changes.length} proposed file change(s):\n`)
      for (const c of changes) {
        process.stdout.write(`  ${c.kind.padEnd(6)} ${c.path}\n`)
      }
      if (changes.length === 0) {
        process.stdout.write(
          '\nNo file content was produced. The provider response could not be parsed as file blocks.\n',
        )
      }
      process.stdout.write(
        `\nNothing was written. Next: review, then run "npm run cli -- apply ${taskId} --dry-run".\n`,
      )
      return changes.length > 0 ? 0 : 1
    }

    case 'apply': {
      const taskId = positional[0]
      if (!taskId) {
        process.stderr.write('Usage: testpilot apply <taskId>\n')
        return 1
      }
      const repositoryRoot = resolveRepoRoot(flags)
      const stateDir = resolveStateDir(flags, repositoryRoot)
      const task = loadTask(stateDir, taskId)
      if (!task) {
        process.stderr.write(`Task not found: ${taskId}\nLooked in ${stateDir}\n`)
        return 1
      }
      const repairProposal = task.status === 'RepairProposed'
      if (task.status !== 'AwaitingApproval' && !repairProposal) {
        process.stderr.write(`Task ${taskId} is in status "${task.status}"; apply requires an approved plan or a reviewed repair proposal.\n`)
        return 1
      }
      if (task.proposedChanges.length === 0) {
        process.stderr.write(
          `Task ${taskId} has no proposed changes. Run "npm run cli -- generate ${taskId}" first.\n`,
        )
        return 1
      }
      const drift = repairProposal ? [] : verifyRepositorySnapshot(repositoryRoot, task.repositorySnapshot)
      if (drift.length > 0) {
        process.stderr.write(`Task ${taskId} is stale; refusing to apply against changed source:\n${drift.map((reason) => `  - ${reason}`).join('\n')}\nCreate and review a fresh plan.\n`)
        return 1
      }

      const dryRun = flags['dry-run'] === true
      const applied = applyChanges({
        repositoryRoot,
        stateDir,
        task,
        changes: task.proposedChanges,
        dryRun,
      })

      process.stdout.write('\n')
      for (const d of applied.diffs) {
        process.stdout.write(`${d.diff}\n\n`)
      }

      if (dryRun) {
        process.stdout.write(`Would write ${applied.wouldWrite.length} file(s):\n`)
        for (const p of applied.wouldWrite) process.stdout.write(`  + ${p}\n`)
      } else {
        process.stdout.write(`Wrote ${applied.written.length} file(s):\n`)
        for (const p of applied.written) process.stdout.write(`  + ${p}\n`)
      }

      if (applied.skipped.length > 0) {
        process.stdout.write(`\nSkipped ${applied.skipped.length} file(s):\n`)
        for (const s of applied.skipped) process.stdout.write(`  ! ${s.path}: ${s.reason}\n`)
      }

      if (!dryRun && applied.written.length > 0) {
        task.appliedChanges = [...new Set([...task.appliedChanges, ...applied.written])]
        task.appliedFileFingerprints = {
          ...task.appliedFileFingerprints,
          ...snapshotRepository(repositoryRoot, applied.written).fileFingerprints,
        }
        task.status = 'ApplyingChanges'
        task.validation = undefined
        recordStage(task, 'Act', 'completed', `${repairProposal ? 'Applied approved repair to' : 'Applied approved changes to'} ${applied.written.length} file(s).`)
        saveTask(stateDir, task)
        if (repairProposal) {
          const report = await validate({ repositoryRoot, taskId, changes: task.proposedChanges, runTests: flags['run-tests'] === true })
          task.validation = report
          recordStage(task, 'Verify', report.passed ? 'completed' : 'failed', `Repair revalidation ${report.passed ? 'passed' : 'failed'}: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped.`)
          task.status = report.passed ? 'Completed' : 'Failed'
          task.updatedAt = new Date().toISOString()
          if (report.passed) delete task.error
          else task.error = {
            message: report.failureAnalysis?.likelyCause ?? `${report.summary.failed} validation check(s) failed after repair.`,
            stage: 'Verify',
          }
          saveTask(stateDir, task)
          process.stdout.write(`\nRepair revalidation: ${report.passed ? 'PASSED' : 'FAILED'} (${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped).\n`)
        } else {
          process.stdout.write(`\nNext: run "npm run cli -- validate ${taskId}" to check the change.\n`)
        }
      }
      return 0
    }

    case 'validate': {
      const taskId = positional[0]
      if (!taskId) {
        process.stderr.write('Usage: testpilot validate <taskId>\n')
        return 1
      }
      const repositoryRoot = resolveRepoRoot(flags)
      const stateDir = resolveStateDir(flags, repositoryRoot)
      const task = loadTask(stateDir, taskId)
      if (!task) {
        process.stderr.write(`Task not found: ${taskId}\n`)
        return 1
      }

      const report = await validate({
        repositoryRoot,
        taskId,
        changes: task.proposedChanges,
        runTests: flags['run-tests'] === true,
        timeoutMs: typeof flags['timeout'] === 'string' ? Number(flags['timeout']) : undefined,
      })

      task.validation = report
      recordStage(task, 'Verify', report.passed ? 'completed' : 'failed', `Validation ${report.passed ? 'passed' : 'failed'}: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped.`)
      task.status = report.passed ? 'Completed' : 'Failed'
      task.updatedAt = new Date().toISOString()
      if (report.passed) {
        delete task.error
      } else {
        task.error = {
          message: report.failureAnalysis?.likelyCause ?? `${report.summary.failed} validation check(s) failed.`,
          stage: 'Verify',
        }
      }
      saveTask(stateDir, task)

      process.stdout.write('\n')
      for (const check of report.checks) {
        const mark = check.skipped ? 'SKIP' : check.passed ? 'PASS' : 'FAIL'
        process.stdout.write(`[${mark}] ${check.description}\n`)
        process.stdout.write(`       ${check.detail.split('\n').join('\n       ')}\n`)
      }
      process.stdout.write(
        `\nResult: ${report.passed ? 'PASSED' : 'FAILED'} — ${report.summary.passed} passed, ` +
          `${report.summary.failed} failed, ${report.summary.skipped} skipped\n`,
      )
      if (report.failureAnalysis) {
        process.stdout.write(`\nLikely cause: ${report.failureAnalysis.likelyCause}\n`)
        for (const e of report.failureAnalysis.evidence) process.stdout.write(`  - ${e}\n`)
      }
      return report.passed ? 0 : 1
    }

    case 'report': {
      const taskId = positional[0]
      if (!taskId) {
        process.stderr.write('Usage: testpilot report <taskId>\n')
        return 1
      }
      const repositoryRoot = resolveRepoRoot(flags)
      const stateDir = resolveStateDir(flags, repositoryRoot)
      const task = loadTask(stateDir, taskId)
      if (!task) {
        process.stderr.write(`Task not found: ${taskId}\n`)
        return 1
      }
      process.stdout.write('\n' + renderReport(task, undefined, false) + '\n')
      return 0
    }

    case 'resume': {
      const taskId = positional[0]
      if (!taskId) {
        process.stderr.write('Usage: testpilot resume <taskId>\n')
        return 1
      }
      const repositoryRoot = resolveRepoRoot(flags)
      const stateDir = resolveStateDir(flags, repositoryRoot)
      const task = loadTask(stateDir, taskId)
      if (!task) {
        process.stderr.write(`Task not found: ${taskId}\nLooked in ${stateDir}\n`)
        return 1
      }
      if (resolve(task.repositoryRoot) !== resolve(repositoryRoot)) {
        process.stderr.write(`Task ${taskId} belongs to ${task.repositoryRoot}, not ${repositoryRoot}.\n`)
        return 1
      }
      if (!['Completed', 'Failed', 'Cancelled'].includes(task.status)) {
        const drift = verifyRepositorySnapshot(repositoryRoot, task.repositorySnapshot)
        if (drift.length > 0) {
          process.stderr.write(`Task ${taskId} cannot resume because its source changed:\n${drift.map((reason) => `  - ${reason}`).join('\n')}\nRe-plan the test case to continue safely.\n`)
          return 1
        }
      }
      process.stdout.write(`Resumed task ${taskId}: ${task.title} [${task.status}]\n`)
      const next = task.status === 'AwaitingApproval'
        ? `npm run cli -- generate ${taskId} --repo "${repositoryRoot}"`
        : task.status === 'RepairProposed'
          ? `npm run cli -- apply ${taskId} --repo "${repositoryRoot}"`
        : task.status === 'Failed' && task.validation && (task.repairAttempts ?? 0) < 2
          ? `npm run cli -- repair ${taskId} --repo "${repositoryRoot}"`
        : task.status === 'ApplyingChanges' || task.status === 'Applied'
          ? `npm run cli -- validate ${taskId} --repo "${repositoryRoot}"`
          : task.status === 'Completed' || task.status === 'Failed'
            ? `npm run cli -- report ${taskId} --repo "${repositoryRoot}"`
            : 'No automated continuation is available for this task status.'
      process.stdout.write(`Next step: ${next}\n`)
      process.stdout.write(renderReport(task, undefined, false) + '\n')
      return 0
    }

    case 'map-locator': {
      const taskId = positional[0]
      const stepOrder = typeof flags.step === 'string' ? Number(flags.step) : NaN
      const ref = typeof flags.ref === 'string' ? flags.ref : ''
      if (!taskId || !Number.isInteger(stepOrder) || stepOrder < 1 || !ref) {
        process.stderr.write('Usage: testpilot map-locator <taskId> --step <number> --ref <browser-ref>\n')
        return 1
      }
      const repositoryRoot = resolveRepoRoot(flags)
      const stateDir = resolveStateDir(flags, repositoryRoot)
      const task = loadTask(stateDir, taskId)
      if (!task) {
        process.stderr.write(`Task not found: ${taskId}\n`)
        return 1
      }
      if (task.status !== 'AwaitingApproval') {
        process.stderr.write(`Task ${taskId} is in status "${task.status}"; locator mapping is only allowed while reviewing its plan.\n`)
        return 1
      }
      const entry = task.plan?.find((candidate) => candidate.stepOrder === stepOrder)
      const locator = task.browserLocatorCandidates?.find((candidate) => candidate.ref === ref)
      if (!entry || !locator || !['new-locator', 'unresolved'].includes(entry.resolution)) {
        process.stderr.write(`Step ${stepOrder} must be unresolved and ref ${ref} must be an observed locator candidate in this task.\n`)
        return 1
      }
      entry.verifiedLocator = locator
      entry.resolution = 'new-locator'
      delete entry.unresolvedReason
      task.updatedAt = new Date().toISOString()
      saveTask(stateDir, task)
      process.stdout.write(`Mapped browser ref ${ref} (${locator.expression}) to step ${stepOrder}. Review the plan and diff before applying.\n`)
      return 0
    }

    case 'repair': {
      const taskId = positional[0]
      if (!taskId) {
        process.stderr.write('Usage: testpilot repair <taskId>\n')
        return 1
      }
      const repositoryRoot = resolveRepoRoot(flags)
      const stateDir = resolveStateDir(flags, repositoryRoot)
      const task = loadTask(stateDir, taskId)
      if (!task) {
        process.stderr.write(`Task not found: ${taskId}\n`)
        return 1
      }
      if (task.status !== 'Failed') {
        process.stderr.write(`Task ${taskId} has status "${task.status}"; repair requires failed validation.\n`)
        return 1
      }
      try {
        const changes = await generateRepairChanges({ task, repositoryRoot, config: providerOverridesFromFlags(flags) })
        if (changes.length === 0) {
          process.stderr.write('The provider did not return a safe repair for the failed evidence. No files were changed.\n')
          return 1
        }
        task.proposedChanges = changes
        task.repairAttempts = (task.repairAttempts ?? 0) + 1
        task.status = 'RepairProposed'
        recordStage(task, 'Recover', 'completed', `Proposed evidence-based repair ${task.repairAttempts}/2; awaiting explicit human apply approval.`)
        task.updatedAt = new Date().toISOString()
        saveTask(stateDir, task)
        const preview = applyChanges({ repositoryRoot, stateDir, task, changes, dryRun: true })
        for (const item of preview.diffs) process.stdout.write(`${item.diff}\n\n`)
        process.stdout.write(`Repair proposal ${task.repairAttempts}/2 saved. Nothing was written. Review the diff, then explicitly run "npm run cli -- apply ${taskId}" to approve it.\n`)
        return 0
      } catch (err) {
        process.stderr.write(`Repair proposal failed: ${err instanceof Error ? err.message : String(err)}\n`)
        return 1
      }
    }

    case 'baseline': {
      const repositoryRoot = resolveRepoRoot(flags)
      const stateDir = resolveStateDir(flags, repositoryRoot)
      const workspace = new Workspace(repositoryRoot)
      const { RepositoryScanner } = await import('@tcoe/repo-intelligence')
      const scanner = new RepositoryScanner(workspace)
      const scan = scanner.scan()

      const baseline: Record<string, string> = {}
      for (const file of scan.files) {
        baseline[file.relativePath] = fingerprint(file.content)
      }

      mkdirSync(stateDir, { recursive: true })
      const outPath = join(stateDir, 'baseline.json')
      writeFileSync(outPath, JSON.stringify(baseline, null, 2), 'utf-8')
      process.stdout.write(`Baseline snapshot of ${Object.keys(baseline).length} file(s) written to ${outPath}\n`)
      return 0
    }

    default:
      process.stderr.write(`Unknown command: ${command}\n\n`)
      printHelp()
      return 1
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    if (err instanceof InputValidationError) {
      process.stderr.write(`\n${err.message}\n\n`)
    } else {
      process.stderr.write(`\nError: ${err instanceof Error ? err.message : String(err)}\n\n`)
    }
    process.exitCode = 1
  })
