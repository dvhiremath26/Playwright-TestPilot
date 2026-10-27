/**
 * VS Code extension activation.
 *
 * The only file VS Code loads, and the only module in the workspace that
 * imports the host API. Everything here is plumbing: resolve settings, call
 * the provider-neutral core, push results into views. The agent stages live in
 * `packages/*` and never touch `vscode`.
 *
 * `generate` creates a bounded proposal and stages it for sidebar review.
 */

import * as vscode from 'vscode'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'

import { createCopilotBridge } from './copilot-bridge.ts'
import { resolveRepoPath, resolveWorkspaceConfig } from './extension-config.ts'
import { getProvider, type ProviderConfig, type VscodeLmBridge } from '@tcoe/provider-abstraction'
import { generateChangesFromProvider, generateRepairChanges, gatherEvidenceForTestCase, runAgent } from '@tcoe/cli/runner'
import { applyChanges, loadTask, recordStage, saveTask, snapshotRepository, verifyRepositorySnapshot } from '@tcoe/cli/apply'
import { validate } from '@tcoe/cli/validate'
import { BrowserSession, createBrowserSession, PlaywrightMcpAdapter } from '@tcoe/browser-tools'
import { workbookToCsv, workbookWorksheetNames, workbookColumnHeaders, ambiguousExcelColumns } from '@tcoe/adapters'
import type { ExcelColumnField, ExcelColumnMapping } from '@tcoe/adapters'
import { renderReport } from '@tcoe/cli/report'
import { analyzeFramework, summariseAnalysis } from '@tcoe/repo-intelligence'

const CONFIG_SECTION = 'tcoeTestPilot'

/** Extract the first absolute URL from manual steps for optional live inspection. */
function extractFirstUrl(raw: string): string | undefined {
  const candidate = raw.match(/https?:\/\/[^\s<>"')\]]+/i)?.[0]?.replace(/[.,;]+$/, '')
  if (!candidate) return undefined
  try {
    const parsed = new URL(candidate)
    if (parsed.username || parsed.password) return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const bridge: VscodeLmBridge = createCopilotBridge()
  const panel = new WebviewViewProvider()
  context.subscriptions.push(new WorkspaceService(bridge, panel))
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('tcoeTestPilot.side', panel),
  )
}

export function deactivate(): void {
  // No long-lived processes to tear down: the CLI does not keep a browser open.
}

class WorkspaceService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = []
  private pendingReviewTaskId?: string
  private activeValidationTaskId?: string

  constructor(private readonly bridge: VscodeLmBridge, private readonly panel: WebviewViewProvider) {
    this.disposables.push(
      vscode.commands.registerCommand('tcoeTestPilot.open', () => this.open()),
      vscode.commands.registerCommand('tcoeTestPilot.plan', (raw?: string) => this.plan(raw)),
      vscode.commands.registerCommand('tcoeTestPilot.generate', (raw?: string) => this.plan(raw)),
      vscode.commands.registerCommand('tcoeTestPilot.selectFile', () => this.selectTestCaseFile()),
      vscode.commands.registerCommand('tcoeTestPilot.useSelection', () => this.useEditorSelection()),
      vscode.commands.registerCommand('tcoeTestPilot.apply', () => this.apply()),
      vscode.commands.registerCommand('tcoeTestPilot.acceptProposal', () => this.acceptProposal()),
      vscode.commands.registerCommand('tcoeTestPilot.rejectProposal', () => this.rejectProposal()),
      vscode.commands.registerCommand('tcoeTestPilot.runValidation', () => this.runValidation()),
      vscode.commands.registerCommand('tcoeTestPilot.validateActive', () => this.activeValidationTaskId
        ? this.runValidation(this.activeValidationTaskId, true)
        : this.panel.postStatus('Accept a generated proposal before validating it.')),
      vscode.commands.registerCommand('tcoeTestPilot.repair', () => this.repair()),
      vscode.commands.registerCommand('tcoeTestPilot.setTarget', () => this.setTarget()),
      vscode.commands.registerCommand('tcoeTestPilot.history', () => this.history()),
      vscode.commands.registerCommand('tcoeTestPilot.clearHistory', () => this.clearHistory()),
      vscode.commands.registerCommand('tcoeTestPilot.rebuildIndex', () => this.rebuildIndex()),
    )
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose()
  }

  /** Open the resolved repository in the explorer. */
  private async open(): Promise<void> {
    const cfg = this.config()
    if (!cfg) return
    const root = cfg.frameworkRepo
    await vscode.window.showInformationMessage(`TestPilot workspace: ${root}`)
    void vscode.commands.executeCommand('workbench.action.showAllFiles')
  }

  /** Plan from the manual case, inspect relevant pages, generate code, and stage it for review. */
  private async plan(rawInput?: string): Promise<void> {
    const cfg = this.config()
    if (!cfg) return

    const input = rawInput?.trim() || await vscode.window.showInputBox({
      title: 'Manual test case',
      prompt: 'Paste the steps, or a path ending in .txt/.md/.csv/.xlsx',
      placeHolder: '1. Open the login page\n2. Enter the username\n3. Submit',
      ignoreFocusOut: true,
    })
    if (!input) return

    let raw: string
    try {
      raw = await this.readInput(input)
    } catch (err) {
      await vscode.window.showErrorMessage(`Could not read the test case: ${this.message(err)}`)
      return
    }
    if (!raw) {
      await vscode.window.showErrorMessage('TestPilot could not read that input.')
      return
    }

    const selectedModel = await this.chooseCopilotModel()
    if (!selectedModel) return
    const modelConfig = this.providerConfig(selectedModel)

    // Fail on an unusable model before spending a run on it.
    const provider = getProvider(modelConfig, { vscodeLmBridge: this.bridge })
    const info = await provider.check()
    if (!info.available) {
      await vscode.window.showErrorMessage(`Model unavailable: ${info.unavailableReason ?? 'unknown reason'}`)
      return
    }

    try {
      const targetUrl = cfg.targetUrl || extractFirstUrl(raw)
      let browser: BrowserSession | undefined
      let browseMode: 'start-page' | 'follow-steps' | undefined
      if (targetUrl) {
        const browserWorkingDirectory = join(cfg.stateDir, 'browser-cli')
        mkdirSync(browserWorkingDirectory, { recursive: true })
        browser = createBrowserSession({
          repositoryRoot: cfg.frameworkRepo,
          workingDirectory: browserWorkingDirectory,
          mcp: {
            // Spawn only after the CLI primary fails. Use cmd.exe explicitly on Windows
            // because npm exposes npx as a .cmd shim that spawn(shell:false) cannot run.
            command: process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npx',
            serverArgs: process.platform === 'win32'
              ? ['/d', '/s', '/c', 'npx -y @playwright/mcp@latest']
              : ['-y', '@playwright/mcp@latest'],
          },
        })
        // The manual case is the instruction to inspect every screen it reaches.
        // The browser runner only performs the navigation/actions it can resolve.
        browseMode = 'follow-steps'
        this.panel.postStatus(`Inspecting ${targetUrl} and following the manual steps automatically.`)
      }

      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'TestPilot: planning', cancellable: true },
        async (progress, token) => {
          const controller = new AbortController()
          const subscription = token.onCancellationRequested(() => controller.abort())
          try {
            return await runAgent({
              rawTestCase: raw,
              repositoryRoot: cfg.frameworkRepo,
              stateDir: cfg.stateDir,
              config: modelConfig,
              vscodeLmBridge: this.bridge,
              browser,
              targetUrl: browser ? targetUrl : undefined,
              browseMode,
              appName: cfg.appName,
              signal: controller.signal,
              onStage: (stage, status, summary) => {
                progress.report({ message: `${stage}: ${summary ?? status}` })
                this.panel.postStatus(`${stage}: ${summary ?? status}`)
              },
            })
          } finally {
            subscription.dispose()
          }
        },
      )

      const task = result.task
      const drift = verifyRepositorySnapshot(cfg.frameworkRepo, task.repositorySnapshot)
      if (drift.length > 0) throw new Error(`Repository changed during planning:\n${drift.map((reason) => `• ${reason}`).join('\n')}`)
      saveTask(cfg.stateDir, task)
      this.panel.postStatus(`Plan ready for ${task.title}. Opening plan review.`)
      this.panel.postStatus(`Plan ready for ${task.title}. Review task ${task.taskId} in the editor.`)
      const planDocument = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content:
          `# ${task.title || 'TestPilot plan'}\n\nTask: ${task.taskId}\n\n## Plan\n\n${result.planText}\n` +
          `\n## Framework mapping\n\n${(task.plan ?? [])
            .map((step) =>
              `- **Step ${step.stepOrder}:** ${step.stepAction} — ${step.resolution}` +
              (step.targetSymbol ? ` (${step.targetSymbol})` : '') +
              (step.unresolvedReason ? `; ${step.unresolvedReason}` : ''),
            )
            .join('\n')}\n` +
          (result.evidence.length > 0
            ? `\n## Browser observations by screen and step\n\n` +
              result.evidence.map((item) => `### ${item.kind} via ${item.source.backendLabel}\n\n${item.detail}`).join('\n\n')
            : '') +
          (result.browserLocatorCandidates.length > 0
            ? `\n\n## Browser locator candidates\n\n` +
              result.browserLocatorCandidates.map((item) => `- ${item.ref}: ${item.role ?? 'element'} ${item.name ?? ''} → \`${item.expression}\` (${item.backend})`).join('\n')
            : ''),
      })
      await vscode.window.showTextDocument(planDocument, { preview: false })

      saveTask(cfg.stateDir, task)

      const changes = await generateChangesFromProvider({
        task,
        analysis: result.analysis,
        plan: task.plan ?? [],
        repositoryRoot: cfg.frameworkRepo,
        config: { ...modelConfig, approvalMode: 'auto' },
        vscodeLmBridge: this.bridge,
      })
      task.proposedChanges = changes
      if (changes.length === 0) {
        saveTask(cfg.stateDir, task)
        await vscode.window.showWarningMessage(
          `No proposal could be generated for task ${task.taskId}. The plan remains saved for review.`,
        )
        return
      }

      const applicableChanges = changes.filter((change) => change.kind !== 'delete')
      const refusedDeletes = changes.filter((change) => change.kind === 'delete').map((change) => change.path)
      const preview = applyChanges({
        repositoryRoot: cfg.frameworkRepo,
        stateDir: cfg.stateDir,
        task,
        changes: applicableChanges,
        dryRun: true,
      })
      const diffDocument = await vscode.workspace.openTextDocument({
        language: 'diff',
        content:
          preview.diffs.map((item) => item.diff).join('\n\n') +
          (preview.skipped.length > 0
            ? `\n\n# Refused during preview\n${preview.skipped
                .map((item) => `# ${item.path}: ${item.reason}`)
                .join('\n')}`
            : '') +
          (refusedDeletes.length > 0
            ? `\n\n# Refused: file deletion is not allowed\n${refusedDeletes.map((path) => `# ${path}`).join('\n')}`
            : ''),
      })
      await vscode.window.showTextDocument(diffDocument, { preview: false })
      if (preview.diffs.length === 0) {
        saveTask(cfg.stateDir, task)
        this.panel.clearReview('No safe file changes are available to review.')
        this.panel.postStatus('No safe changes are available. Review the refusal details in the diff tab.')
        await vscode.window.showWarningMessage(
          'No safe file changes are available to apply. Review the proposal and preview refusal details.',
        )
        return
      }

      const driftBeforeApply = verifyRepositorySnapshot(cfg.frameworkRepo, task.repositorySnapshot)
      if (driftBeforeApply.length > 0) {
        throw new Error(`Repository changed before generated code could be applied:\n${driftBeforeApply.map((reason) => `• ${reason}`).join('\n')}`)
      }
      task.status = 'AwaitingApproval'
      task.updatedAt = new Date().toISOString()
      saveTask(cfg.stateDir, task)
      this.pendingReviewTaskId = task.taskId
      this.panel.setReviewReady(task.taskId, task.title, preview.diffs.length)
      this.panel.postStatus(`Generated ${preview.diffs.length} file change(s) for ${task.title}. Review the diff, then accept or reject.`)
      await vscode.window.showInformationMessage(`TestPilot prepared ${preview.diffs.length} file change(s). Review them in the diff tab and choose Accept or Reject in the sidebar.`)
    } catch (err) {
      this.panel.postStatus(`Planning stopped: ${this.message(err)}`)
      await vscode.window.showErrorMessage(this.message(err))
    }
  }

  /** Pick a supported manual test case document. */
  private async selectTestCaseFile(): Promise<void> {
    const files = await vscode.window.showOpenDialog({
      title: 'Select manual test case file',
      canSelectMany: false,
      openLabel: 'Select test file',
      filters: { 'Manual test case files': ['txt', 'md', 'csv', 'xlsx'] },
    })
    const file = files?.[0]
    if (!file) return
    this.panel.setSelectedFile(file.fsPath, basename(file.fsPath))
    this.panel.postStatus(`Selected manual test case file: ${basename(file.fsPath)}. Click Generate when ready.`)
  }

  /** Load the current editor selection into the manual case editor. */
  private async useEditorSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor
    const selection = editor?.document.getText(editor.selection).trim()
    if (!selection) {
      await vscode.window.showInformationMessage('Select manual test steps in an editor first, then choose Use selection.')
      return
    }
    this.panel.setManualCase(selection)
    this.panel.postStatus('Loaded the selected editor text as the manual test case.')
  }

  /**
   * Apply an approved plan. Sidebar acceptance is explicit approval; the
   * standalone command keeps its modal confirmation.
   */
  private async apply(requestedTaskId?: string, acceptedInSidebar = false): Promise<void> {
    const cfg = this.config()
    if (!cfg) return

    const taskId = requestedTaskId?.trim() || await vscode.window.showInputBox({
      title: 'TestPilot: approve and apply',
      prompt: 'Task id to apply (shown in the saved-plan notification).',
      ignoreFocusOut: true,
    })
    if (!taskId) return

    const stateDir = resolveRepoPath(cfg.stateDir, cfg.frameworkRepo)
    const task = loadTask(stateDir, taskId.trim())
    if (!task) {
      await vscode.window.showWarningMessage(`No task "${taskId}" was found. Run "TestPilot: Plan Test" first.`)
      return
    }
    const isRepair = task.status === 'RepairProposed'
    if (task.status !== 'AwaitingApproval' && !isRepair) {
      await vscode.window.showWarningMessage(`Task ${taskId} is in status "${task.status}"; apply requires an awaiting plan or a proposed repair.`)
      return
    }
    const drift = isRepair ? [] : verifyRepositorySnapshot(cfg.frameworkRepo, task.repositorySnapshot)
    if (drift.length > 0) {
      await vscode.window.showWarningMessage(`This plan is stale. Re-plan before applying:\n${drift.join('\n')}`)
      return
    }
    if (task.proposedChanges.length === 0) {
      await vscode.window.showWarningMessage('That task has no proposed changes to apply.')
      return
    }

    if (!acceptedInSidebar) {
      const confirmed = await vscode.window.showWarningMessage(
        `${isRepair ? 'Write proposed repair' : 'Write approved plan'} (${task.proposedChanges.length} file(s)) to your framework repository?`,
        { modal: true },
        'Apply',
      )
      if (confirmed !== 'Apply') return
    }

    const changesToApply = acceptedInSidebar
      ? task.proposedChanges.filter((change) => change.kind !== 'delete')
      : task.proposedChanges
    if (changesToApply.length === 0) {
      await vscode.window.showWarningMessage('There are no safe file changes to apply. Generated file deletions are refused.')
      return
    }
    const applied = applyChanges({
      repositoryRoot: cfg.frameworkRepo,
      stateDir,
      task,
      changes: changesToApply,
    })

    if (applied.written.length > 0) {
      task.appliedChanges = [...new Set([...task.appliedChanges, ...applied.written])]
      task.appliedFileFingerprints = {
        ...task.appliedFileFingerprints,
        ...snapshotRepository(cfg.frameworkRepo, applied.written).fileFingerprints,
      }
      task.status = isRepair ? 'ApplyingChanges' : 'Applied'
      recordStage(task, 'Act', 'completed', `Applied ${applied.written.length} approved file change(s).`)
      task.updatedAt = new Date().toISOString()
      saveTask(stateDir, task)
      if (isRepair) {
        const report = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'TestPilot: revalidating repair' },
          () => validate({
            repositoryRoot: cfg.frameworkRepo,
            taskId: task.taskId,
            changes: task.proposedChanges,
            testPaths: task.appliedChanges.filter((path) => /\.spec\.tsx?$/i.test(path)),
            runTests: acceptedInSidebar || vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('runTestsDuringValidation'),
          }),
        )
        task.validation = report
        recordStage(task, 'Verify', report.passed ? 'completed' : 'failed', `${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped.`)
        task.status = report.passed ? 'Completed' : 'Failed'
        task.updatedAt = new Date().toISOString()
        if (report.passed) delete task.error
        else task.error = { message: report.failureAnalysis?.likelyCause ?? 'Repair validation failed.', stage: 'Verify' }
        saveTask(stateDir, task)
        await vscode.window.showInformationMessage(`Repair revalidation ${report.passed ? 'passed' : 'failed'}.`)
      } else {
        saveTask(stateDir, task)
      }
      if (task.taskId === this.pendingReviewTaskId) {
        this.pendingReviewTaskId = undefined
      }
      if (!isRepair || task.status === 'Completed' || task.status === 'Failed') {
        this.activeValidationTaskId = task.taskId
        this.panel.setApplied(task.taskId, applied.written.length)
      }
      this.panel.postStatus(`Approved task ${task.taskId}; applied ${applied.written.length} file(s).`)
      if (!isRepair) {
        await vscode.window.showInformationMessage(
          `Applied ${applied.written.length} file(s). Use Validate generated test when ready.`,
        )
      }
    } else {
      await vscode.window.showWarningMessage(
        `Nothing was written. ${applied.skipped.length} change(s) were refused — open a task file for details.`,
      )
    }
  }

  private async acceptProposal(): Promise<void> {
    const taskId = this.pendingReviewTaskId
    if (!taskId) {
      this.panel.postStatus('There is no generated proposal awaiting review.')
      return
    }
    await this.apply(taskId, true)
  }

  private async rejectProposal(): Promise<void> {
    const cfg = this.config()
    if (!cfg) return
    const taskId = this.pendingReviewTaskId
    if (!taskId) {
      this.panel.postStatus('There is no generated proposal awaiting review.')
      return
    }
    const stateDir = resolveRepoPath(cfg.stateDir, cfg.frameworkRepo)
    const task = loadTask(stateDir, taskId)
    if (!task || (task.status !== 'AwaitingApproval' && task.status !== 'RepairProposed')) {
      this.pendingReviewTaskId = undefined
      this.panel.clearReview('This proposal is no longer awaiting review.')
      this.panel.postStatus('The proposal could not be rejected because its status changed.')
      return
    }
    const rejectedRepair = task.status === 'RepairProposed'
    task.status = 'Cancelled'
    recordStage(task, 'Act', 'skipped', 'Proposal rejected in the TestPilot sidebar; no files were written.')
    saveTask(stateDir, task)
    this.pendingReviewTaskId = undefined
    this.panel.clearReview('Proposal rejected. No files were written.')
    if (rejectedRepair) {
      this.activeValidationTaskId = task.taskId
      this.panel.setValidationReady(task.taskId)
    }
    this.panel.postStatus(`Rejected the proposal for ${task.title}. No files were written.`)
  }

  /** Run framework checks; the sidebar action always executes tests for the active task. */
  private async runValidation(requestedTaskId?: string, repairLocatorFailures = false): Promise<void> {
    const cfg = this.config()
    if (!cfg) return

    const taskId = requestedTaskId || await vscode.window.showInputBox({ title: 'TestPilot: validate', prompt: 'Task id to validate' })
    if (!taskId) return

    const stateDir = resolveRepoPath(cfg.stateDir, cfg.frameworkRepo)
    const task = loadTask(stateDir, taskId.trim())
    if (!task) {
      await vscode.window.showWarningMessage(`No task "${taskId}" was found.`)
      return
    }

    try {
      this.panel.postStatus(`Running validation for ${task.title}…`)
      task.status = 'Validating'
      task.updatedAt = new Date().toISOString()
      saveTask(stateDir, task)
      const report = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'TestPilot: validating' },
        async () =>
          validate({
            repositoryRoot: cfg.frameworkRepo,
            taskId: task.taskId,
            changes: task.proposedChanges,
            testPaths: task.appliedChanges.filter((path) => /\.spec\.tsx?$/i.test(path)),
            runTests: true,
          }),
      )

      const failed = report.checks.filter((c) => !c.passed).length
      task.validation = report
      recordStage(task, 'Verify', report.passed ? 'completed' : 'failed', `${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped.`)
      task.status = report.passed ? 'Completed' : 'Failed'
      task.updatedAt = new Date().toISOString()
      if (report.passed) {
        delete task.error
      } else {
        task.error = {
          message: report.failureAnalysis?.likelyCause ?? `${failed} validation check(s) failed.`,
          stage: 'Verify',
        }
      }
      saveTask(stateDir, task)
      this.activeValidationTaskId = task.taskId
      const testCheck = report.checks.find((check) => check.kind === 'test')
      if (failed === 0) {
        await vscode.window.showInformationMessage(testCheck?.skipped
          ? `Validation completed, but test execution was skipped: ${testCheck.skipReason ?? testCheck.detail}`
          : `Validation passed (${report.summary.passed} passed, ${report.summary.skipped} skipped).`)
      } else {
        const failedChecks = report.checks.filter((check) => !check.passed)
        const failureSummary = failedChecks
          .map((check) => `${check.kind}: ${check.detail.slice(0, 1400)}`)
          .join('\n\n')
        const action = await vscode.window.showErrorMessage(
          `${failed} validation check(s) failed.\n\n${failureSummary}`,
          'Open validation report',
        )
        if (action === 'Open validation report') {
          const document = await vscode.workspace.openTextDocument({
            language: 'markdown',
            content: `# Validation report — ${task.title}\n\n${renderReport(task, undefined, false)}`,
          })
          await vscode.window.showTextDocument(document, { preview: false })
        }
      }
      if (report.passed) {
        this.panel.setValidationReady(task.taskId)
        this.panel.postStatus(testCheck?.skipped
          ? `Framework checks completed for ${task.title}; test execution was skipped.`
          : `Validation passed for ${task.title}.`)
      } else {
        const testFailure = testCheck && !testCheck.passed ? testCheck : undefined
        if (repairLocatorFailures && testFailure && this.isLocatorFailure(testFailure.detail)) {
          await this.proposeMcpLocatorRepair(task, cfg.frameworkRepo, stateDir, cfg.targetUrl)
        } else {
          this.panel.setValidationReady(task.taskId)
          const failedKinds = report.checks.filter((check) => !check.passed).map((check) => check.kind).join(', ')
          this.panel.postStatus(`Validation failed (${failedKinds}) for ${task.title}. Open the validation report for details.`)
        }
      }
    } catch (err) {
      task.status = 'Failed'
      task.error = { message: this.message(err), stage: 'Verify' }
      task.updatedAt = new Date().toISOString()
      saveTask(stateDir, task)
      this.panel.setValidationReady(task.taskId)
      this.panel.postStatus(`Validation stopped: ${this.message(err)}`)
      await vscode.window.showErrorMessage(this.message(err))
    }
  }

  private isLocatorFailure(detail: string): boolean {
    return /locator|selector|strict mode|waiting for|getBy(?:Role|Text|Label|Placeholder|TestId)|element.*not found|no element|not visible/i.test(detail)
  }

  /** Replay the normalized case through MCP and stage a repair grounded in fresh snapshots. */
  private async proposeMcpLocatorRepair(
    task: import('@tcoe/shared-types').TaskRecord,
    repositoryRoot: string,
    stateDir: string,
    fallbackTargetUrl?: string,
  ): Promise<void> {
    if ((task.repairAttempts ?? 0) >= 2) {
      this.panel.setValidationReady(task.taskId)
      this.panel.postStatus('Validation found a locator failure, but the two repair attempts for this task have been used.')
      return
    }
    if (task.appliedChanges.length === 0) {
      this.panel.setValidationReady(task.taskId)
      this.panel.postStatus('Validation found a locator failure, but no TestPilot-applied files are available for a safe repair.')
      return
    }

    const cases = task.testCases?.length ? task.testCases : task.testCase ? [task.testCase] : []
    if (cases.length === 0) {
      this.panel.setValidationReady(task.taskId)
      this.panel.postStatus('Validation found a locator failure, but the saved task has no normalized steps to inspect.')
      return
    }

    const evidence: string[] = []
    const candidates: import('@tcoe/shared-types').VerifiedLocator[] = []
    const workingDirectory = join(stateDir, 'browser-mcp-repair')
    mkdirSync(workingDirectory, { recursive: true })
    const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npx'
    const serverArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npx -y @playwright/mcp@latest']
      : ['-y', '@playwright/mcp@latest']

    this.panel.postStatus('Replaying the manual steps with Playwright MCP to capture fresh locator evidence…')
    try {
      for (const testCase of cases) {
        const testCaseText = [testCase.description, ...testCase.preconditions, ...testCase.steps.map((step) => step.action)]
          .filter(Boolean).join('\n')
        const targetUrl = extractFirstUrl(testCaseText)
          ?? fallbackTargetUrl
        if (!targetUrl) continue

        const browser = new BrowserSession({
          primary: new PlaywrightMcpAdapter({ command, serverArgs, cwd: workingDirectory }),
        })
        try {
          const observed = await gatherEvidenceForTestCase(browser, {
            targetUrl,
            steps: testCase.steps,
            mode: 'follow-steps',
          })
          const locatorEvidence = observed.locatorCandidates.map((candidate) =>
            `Step ${candidate.stepOrder ?? 'unknown'} on ${candidate.pageUrl ?? 'unknown page'}: ${candidate.expression} (observed name=${candidate.name ?? 'none'}, role=${candidate.role ?? 'none'}, backend=${candidate.backend}, ref=${candidate.ref})`,
          )
          evidence.push(`Test case: ${testCase.title}\n${observed.evidence.map((item) => `${item.kind} via ${item.source.backendLabel}: ${item.detail}`).join('\n\n')}\n\nVerified locator candidates:\n${locatorEvidence.join('\n')}`)
          candidates.push(...observed.locatorCandidates)
        } finally {
          await browser.close()
        }
      }
      if (evidence.length === 0) {
        this.panel.setValidationReady(task.taskId)
        this.panel.postStatus('Playwright MCP could not inspect a target page. Set a target URL or include one in the manual steps.')
        return
      }
      if (candidates.length === 0) {
        this.panel.setValidationReady(task.taskId)
        this.panel.postStatus('Playwright MCP captured screens but could not verify a unique locator candidate. No repair was proposed.')
        return
      }

      task.browserLocatorCandidates = candidates
      const model = [...task.modelCalls].reverse().find((call) => call.purpose === 'generate')?.model
        ?? await this.chooseCopilotModel()
      if (!model) {
        this.panel.setValidationReady(task.taskId)
        this.panel.postStatus('No Copilot model was selected, so the MCP evidence was saved without proposing a repair.')
        return
      }
      const changes = await generateRepairChanges({
        task,
        repositoryRoot,
        config: this.providerConfig(model),
        vscodeLmBridge: this.bridge,
        browserEvidence: evidence,
      })
      if (changes.length === 0) {
        this.panel.setValidationReady(task.taskId)
        this.panel.postStatus('Playwright MCP evidence did not support a safe repair. No files were changed.')
        return
      }

      task.proposedChanges = changes
      task.repairAttempts = (task.repairAttempts ?? 0) + 1
      task.status = 'RepairProposed'
      recordStage(task, 'Recover', 'completed', `Locator repair proposal ${task.repairAttempts}/2 grounded in fresh Playwright MCP snapshots.`)
      task.updatedAt = new Date().toISOString()
      saveTask(stateDir, task)
      const preview = applyChanges({ repositoryRoot, stateDir, task, changes, dryRun: true })
      if (preview.diffs.length === 0) {
        this.panel.setValidationReady(task.taskId)
        this.panel.postStatus('The repair proposal contained no safe file changes. No files were written.')
        return
      }
      const diff = await vscode.workspace.openTextDocument({
        language: 'diff',
        content: preview.diffs.map((item) => item.diff).join('\n\n'),
      })
      await vscode.window.showTextDocument(diff, { preview: false })
      this.pendingReviewTaskId = task.taskId
      this.panel.setReviewReady(task.taskId, `MCP repair · ${task.title}`, preview.diffs.length)
      this.panel.postStatus('Playwright MCP grounded a repair proposal. Review the diff and Accept or Reject it.')
      await vscode.window.showInformationMessage('A locator repair proposal is ready. Review the diff and choose Accept or Reject in the sidebar.')
    } catch (err) {
      this.panel.setValidationReady(task.taskId)
      this.panel.postStatus(`MCP locator repair could not be prepared: ${this.message(err)}`)
      await vscode.window.showWarningMessage(`Validation failed. MCP-based repair was not prepared: ${this.message(err)}`)
    }
  }

  /** Produce a bounded evidence-based repair, gate it with a diff and approval, then revalidate. */
  private async repair(): Promise<void> {
    const cfg = this.config()
    if (!cfg) return
    const taskId = await vscode.window.showInputBox({ title: 'TestPilot: propose repair', prompt: 'Task id with failed validation' })
    if (!taskId) return
    const task = loadTask(cfg.stateDir, taskId.trim())
    if (!task || task.status !== 'Failed') {
      await vscode.window.showWarningMessage(`Task ${taskId} must exist and have a failed validation report.`)
      return
    }
    const selectedModel = await this.chooseCopilotModel()
    if (!selectedModel) return
    try {
      const changes = await generateRepairChanges({
        task,
        repositoryRoot: cfg.frameworkRepo,
        config: this.providerConfig(selectedModel),
        vscodeLmBridge: this.bridge,
      })
      if (changes.length === 0) {
        await vscode.window.showWarningMessage('No evidence-supported repair was returned. No files were changed.')
        return
      }
      task.proposedChanges = changes
      task.repairAttempts = (task.repairAttempts ?? 0) + 1
      task.status = 'RepairProposed'
      recordStage(task, 'Recover', 'completed', `Repair proposal ${task.repairAttempts}/2 generated for review.`)
      task.updatedAt = new Date().toISOString()
      saveTask(cfg.stateDir, task)
      const preview = applyChanges({ repositoryRoot: cfg.frameworkRepo, stateDir: cfg.stateDir, task, changes, dryRun: true })
      const diff = await vscode.workspace.openTextDocument({
        language: 'diff',
        content: preview.diffs.map((item) => item.diff).join('\n\n'),
      })
      await vscode.window.showTextDocument(diff, { preview: false })
      if (preview.diffs.length === 0) return
      const approved = await vscode.window.showWarningMessage(
        `Repair proposal ${task.repairAttempts}/2. Apply these reviewed changes?`,
        { modal: true },
        'Apply Repair',
      )
      if (approved !== 'Apply Repair') return

      const applied = applyChanges({ repositoryRoot: cfg.frameworkRepo, stateDir: cfg.stateDir, task, changes })
      if (applied.written.length === 0) {
        await vscode.window.showWarningMessage(`Repair was not applied. ${applied.skipped.map((item) => item.reason).join('; ')}`)
        return
      }
      task.appliedChanges = [...new Set([...task.appliedChanges, ...applied.written])]
      task.appliedFileFingerprints = {
        ...task.appliedFileFingerprints,
        ...snapshotRepository(cfg.frameworkRepo, applied.written).fileFingerprints,
      }
      task.status = 'ApplyingChanges'
      recordStage(task, 'Act', 'completed', `Applied ${applied.written.length} approved repair change(s).`)
      saveTask(cfg.stateDir, task)
      const report = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'TestPilot: revalidating repair' },
        () => validate({
          repositoryRoot: cfg.frameworkRepo,
          taskId: task.taskId,
          changes,
          testPaths: task.appliedChanges.filter((path) => /\.spec\.tsx?$/i.test(path)),
          runTests: vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('runTestsDuringValidation'),
        }),
      )
      task.validation = report
      recordStage(task, 'Verify', report.passed ? 'completed' : 'failed', `${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped.`)
      task.status = report.passed ? 'Completed' : 'Failed'
      task.updatedAt = new Date().toISOString()
      if (report.passed) delete task.error
      else task.error = {
        message: report.failureAnalysis?.likelyCause ?? `${report.summary.failed} validation check(s) failed after repair.`,
        stage: 'Verify',
      }
      saveTask(cfg.stateDir, task)
      await vscode.window.showInformationMessage(report.passed
        ? `Repair applied and revalidation passed. ${task.repairAttempts}/2 proposals used.`
        : `Repair applied, but validation still failed. ${task.repairAttempts}/2 proposals used.`)
    } catch (err) {
      await vscode.window.showErrorMessage(`Repair failed: ${this.message(err)}`)
    }
  }

  private async history(): Promise<void> {
    const cfg = this.config()
    if (!cfg) return
    let tasks: import('@tcoe/shared-types').TaskRecord[] = []
    try {
      tasks = readdirSync(cfg.stateDir)
        .filter((name) => name.endsWith('.task.json'))
        .map((name) => loadTask(cfg.stateDir, name.slice(0, -'.task.json'.length)))
        .filter((task): task is import('@tcoe/shared-types').TaskRecord => task !== null)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    } catch { /* Empty state directory is a valid history. */ }
    if (tasks.length === 0) {
      await vscode.window.showInformationMessage('No saved TestPilot tasks were found.')
      return
    }
    const selected = await vscode.window.showQuickPick(tasks.map((task) => ({
      label: `${task.title || '(untitled)'}  ·  ${task.status}`,
      description: `${task.taskId} · ${new Date(task.updatedAt).toLocaleString()}`,
      task,
    })), { title: 'TestPilot task history', placeHolder: 'Select a task to review its report' })
    if (!selected) return
    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: `# ${selected.task.title || 'TestPilot task'}\n\n${renderReport(selected.task, undefined, false)}`,
    })
    await vscode.window.showTextDocument(document, { preview: false })
  }

  private async clearHistory(): Promise<void> {
    const cfg = this.config()
    if (!cfg) return
    const answer = await vscode.window.showWarningMessage(
      'Delete saved TestPilot task records and checkpoints? The framework index will be kept.',
      { modal: true },
      'Delete Task History',
    )
    if (answer !== 'Delete Task History') return
    let deleted = 0
    try {
      for (const name of readdirSync(cfg.stateDir)) {
        if (!/\.(task|checkpoint)\.json$/.test(name)) continue
        unlinkSync(join(cfg.stateDir, name))
        deleted++
      }
    } catch { /* No saved state is equivalent to clearing an empty history. */ }
    await vscode.window.showInformationMessage(`Deleted ${deleted} saved task record(s). The framework index was retained.`)
  }

  private async rebuildIndex(): Promise<void> {
    const cfg = this.config()
    if (!cfg) return
    try {
      const result = analyzeFramework({ repositoryRoot: cfg.frameworkRepo, indexDir: join(cfg.stateDir, 'index') })
      const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: summariseAnalysis(result) })
      await vscode.window.showTextDocument(document, { preview: false })
      await vscode.window.showInformationMessage(`Framework index refreshed (${result.scan.files.length} source files).`)
    } catch (err) {
      await vscode.window.showErrorMessage(`Index refresh failed: ${this.message(err)}`)
    }
  }

  /** Open the target URL setting, refusing to bless a URL that carries credentials. */
  private async setTarget(): Promise<void> {
    const current = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('targetUrl') ?? ''
    if (/\/\/[^/@]+:[^@]+@/.test(current)) {
      await vscode.window.showErrorMessage(
        'The current target URL contains embedded credentials. Remove them before continuing — TestPilot refuses to store them.',
      )
      return
    }
    await vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG_SECTION}.targetUrl`)
  }

  /** Treat the input as inline steps, or read it as a local file if it looks like a path. */
  private async readInput(input: string): Promise<string> {
    const trimmed = input.trim()
    if (!/\.+(txt|md|csv|xlsx)$/i.test(trimmed)) return trimmed

    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(trimmed))
      if (/\.xlsx$/i.test(trimmed)) {
        const sheets = await workbookWorksheetNames(bytes)
        if (sheets.length === 0) return ''
        const selected = sheets.length === 1
          ? sheets[0]
          : await vscode.window.showQuickPick(sheets, { title: 'Select worksheet for this test case' })
        if (!selected) return ''
        const headers = await workbookColumnHeaders(bytes, selected)
        const mapping: ExcelColumnMapping = {}
        const labels: Record<ExcelColumnField, string> = {
          title: 'test title', action: 'step action', expected: 'expected result', precondition: 'precondition',
          application: 'application/module', stepIndex: 'step number', status: 'status',
        }
        for (const field of ambiguousExcelColumns(headers)) {
          const usedColumns = new Set(Object.values(mapping))
          const choices = [
            ...(field !== 'action' ? [{ label: 'Skip this column', index: undefined as number | undefined }] : []),
            ...headers.map((header, index) => ({ label: `${index + 1}. ${header || '(blank header)'}`, index: index + 1 }))
              .filter((choice) => !usedColumns.has(choice.index)),
          ]
          const choice = await vscode.window.showQuickPick(choices, {
            title: `Select the ${labels[field]} column`,
            placeHolder: 'Choose the matching spreadsheet column; TestPilot will not guess.',
          })
          if (!choice) return ''
          if (choice.index) mapping[field] = choice.index
        }
        return workbookToCsv(bytes, selected, mapping)
      }
      return Buffer.from(bytes).toString('utf8')
    } catch {
      return ''
    }
  }

  private message(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  private async chooseCopilotModel(): Promise<string | undefined> {
    const discovery = await this.bridge.discover()
    if (!discovery.available || discovery.models.length === 0) {
      await vscode.window.showErrorMessage(
        `No GitHub Copilot model is available: ${discovery.reason ?? 'sign in to Copilot Chat and try again.'}`,
      )
      return undefined
    }
    const selected = await vscode.window.showQuickPick(
      discovery.models.map((model) => ({
        label: model.displayName,
        description: `${model.family ?? 'Copilot'} · ${model.id}`,
        id: model.id,
      })),
      {
        title: 'Choose a GitHub Copilot model for TestPilot',
        placeHolder: 'Select the model to use for this task',
        ignoreFocusOut: true,
      },
    )
    return selected?.id
  }

  private providerConfig(model: string): ProviderConfig {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION)
    return {
      provider: 'vscode-lm',
      model,
      approvalMode: 'manual',
    }
  }

  /**
   * Resolve the framework repository and state dir, failing loudly.
   * Returns undefined rather than throwing so command handlers stay safe.
   */
  private config(): { frameworkRepo: string; stateDir: string; appName?: string; targetUrl?: string } | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!root) {
      void vscode.window.showErrorMessage('TestPilot needs a workspace folder to be open.')
      return undefined
    }

    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION)
    const rawState = cfg.get<string>('stateDir') || ''
    try {
      const resolved = resolveWorkspaceConfig(
        {
          frameworkRepo: cfg.get<string>('frameworkRepo') || '',
          appName: cfg.get<string>('appName') || '',
          targetUrl: cfg.get<string>('targetUrl') || '',
          stateDir: rawState,
        },
        root,
      )
      return {
        frameworkRepo: resolved.frameworkRepo,
        stateDir: resolveRepoPath(resolved.stateDir, resolved.frameworkRepo),
        appName: resolved.appName,
        targetUrl: resolved.targetUrl,
      }
    } catch (err) {
      void vscode.window.showErrorMessage(this.message(err))
      return undefined
    }
  }
}

/**
 * Side panel: status and entry points only. It never writes files — writes go
 * through the commands above, which carry the same approval gates as the CLI.
 */
class WebviewViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView

  resolveWebviewView(webview: vscode.WebviewView): void {
    this.view = webview
    webview.webview.options = { enableScripts: true, localResourceRoots: [] }
    webview.webview.html = this.html(webview.webview)
    webview.webview.onDidReceiveMessage((msg: { command?: string; text?: string }) => {
      const command = msg.command ? `tcoeTestPilot.${msg.command}` : undefined
      if (command) void vscode.commands.executeCommand(command, msg.text)
    })
  }

  postStatus(text: string): void {
    void this.view?.webview.postMessage({ kind: 'status', text })
  }

  setReviewReady(taskId: string, title: string, count: number): void {
    void this.view?.webview.postMessage({ kind: 'review-ready', taskId, title, count })
  }

  setValidationReady(taskId: string): void {
    void this.view?.webview.postMessage({ kind: 'validation-ready', taskId })
  }

  setApplied(taskId: string, count: number): void {
    void this.view?.webview.postMessage({ kind: 'applied', taskId, count })
  }

  clearReview(text: string): void {
    void this.view?.webview.postMessage({ kind: 'review-clear', text })
  }

  setSelectedFile(path: string, name: string): void {
    void this.view?.webview.postMessage({ kind: 'file-selected', path, name })
  }

  setManualCase(text: string, name?: string): void {
    void this.view?.webview.postMessage({ kind: 'manual-case', text, name })
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64')
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; worker-src ${webview.cspSource} blob;">
<style>
  :root { color-scheme: dark; }
  body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground);
         padding: 14px; display: flex; flex-direction: column; gap: 11px;
         background: var(--vscode-sideBar-background); }
  .brand { display: flex; align-items: center; gap: 10px; margin: 1px 0 3px; padding-bottom: 3px; }
  .brand-icon { width: 30px; height: 30px; flex: 0 0 30px; color: var(--vscode-textLink-foreground); }
  .brand-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  h1 { font-size: 16px; margin: 0; font-weight: 650; letter-spacing: .1px; color: var(--vscode-foreground); }
  .manual-case-label { display: block; margin: 0 0 7px; color: var(--vscode-descriptionForeground);
                       font-size: 11px; font-weight: 600; }
  p { margin: 0; color: var(--vscode-descriptionForeground); line-height: 1.45; }
  .input-card { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 10px;
                background: var(--vscode-editor-background); }
  .input-frame { border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
                 border-radius: 9px; padding: 4px; background: var(--vscode-input-background); }
  .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .section-heading { font-size: 12px; letter-spacing: .6px; margin: 3px 0 0; color: var(--vscode-descriptionForeground); }
  .divider { border: 0; border-top: 1px solid var(--vscode-panel-border); margin: 6px 0; }
  .status-card { border: 1px solid var(--vscode-panel-border); border-radius: 9px; padding: 12px;
                 background: var(--vscode-editor-background); display: grid; gap: 9px; }
  .status-line { display: flex; align-items: center; gap: 9px; color: var(--vscode-foreground); }
  .status-line p { color: var(--vscode-foreground); }
  .status-dot { width: 10px; height: 10px; flex: 0 0 10px; border-radius: 50%; background: var(--vscode-testing-iconPassed, #73c991); }
  .status-dot.busy { background: var(--vscode-editorWarning-foreground, #cca700); }
  .status-dot.error { background: var(--vscode-errorForeground, #f14c4c); }
  .status-detail { padding-left: 19px; }
  .review-copy { margin: 2px 0 9px; line-height: 1.5; }
  details { border-top: 1px solid var(--vscode-panel-border); padding-top: 9px; }
  summary { cursor: pointer; color: var(--vscode-foreground); font-weight: 600; padding: 5px 0; }
  .tool-list { display: flex; flex-direction: column; gap: 7px; padding-top: 8px; }
  #selectedFile { color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
  textarea { width: 100%; min-height: 135px; resize: vertical; box-sizing: border-box; padding: 12px;
             color: var(--vscode-input-foreground); background: var(--vscode-input-background);
             border: 1px solid transparent; border-radius: 7px; font: inherit; line-height: 1.5; }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  button { width: 100%; text-align: center; padding: 9px 12px; border-radius: 6px;
           border: none; background: var(--vscode-button-background);
           color: var(--vscode-button-foreground); cursor: pointer; margin: 0;
           transition: background-color .12s ease, border-color .12s ease, color .12s ease; }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  button:not(:disabled):hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  button:disabled { opacity: .55; cursor: default; }
  button.secondary { background: var(--vscode-button-secondaryBackground, var(--vscode-button-background)); }
  .input-actions button { min-height: 30px; padding: 5px 8px; font-size: 11px; }
  #generate, #acceptProposal, #rejectProposal { min-height: 32px; padding: 6px 8px; font-size: 12px; }
  button.outline { background: transparent; border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
                   color: var(--vscode-foreground); }
  button.outline:not(:disabled):hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-button-secondaryBackground)); }
  .validate-action { margin-top: 9px; }
  .validate-outline { margin: -5px 0 0; font-size: 10px; line-height: 1.45; }
  .note { margin-top: auto; padding-top: 8px; border-top: 1px solid var(--vscode-panel-border);
          color: var(--vscode-descriptionForeground); font-size: 11px; }
  @media (max-width: 300px) { .actions { grid-template-columns: 1fr; } }
</style></head>
<body>
  <header class="brand">
    <svg class="brand-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M8 8V5m0 0 3 2M8 5 5 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="3.5" y="8" width="16" height="13.5" rx="4" stroke="currentColor" stroke-width="1.8"/>
      <path d="M3.5 12h-2v5h2m16-5h2v5h-2M8 13.5h.1m6.4 0h.1M7 23.5c1.7-1.6 3.5-2.3 5.8-2.3s4.2.7 5.7 2.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M25 5v5l-5.2 12.1a3.2 3.2 0 0 0 3 4.4h5a3.2 3.2 0 0 0 3-4.4L25.5 10V5m-2.7 12h5.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M25 2.2v.1m3 3.1h.1" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
    </svg>
    <div class="brand-copy">
      <h1>TCOE-TestPilot</h1>
    </div>
  </header>
  <section class="input-card" aria-label="Manual test case input">
    <label class="manual-case-label" for="manualCase">Choose Manual Test Case</label>
    <div class="input-frame">
      <textarea id="manualCase" aria-label="Enter manual test steps" placeholder="Enter or paste your manual test steps here…\n\n1. Open the login page\n2. Enter the username\n3. Click Login"></textarea>
    </div>
  </section>
  <div class="actions input-actions">
    <button id="selectFile" class="outline">Select test file</button>
    <button id="useSelection" class="outline">Use selection</button>
  </div>
  <div id="selectedFile" aria-live="polite">No document selected</div>
  <button id="generate">Generate</button>
  <hr class="divider">
  <h2 class="section-heading">STATUS</h2>
  <div class="status-card" role="status" aria-live="polite">
    <div class="status-line"><span id="statusDot" class="status-dot"></span><p id="statusText">Ready for code generation.</p></div>
    <p id="statusDetail" class="status-detail">Analyze the framework before generating for best results.</p>
  </div>
  <hr class="divider">
  <h2 class="section-heading">REVIEW</h2>
  <p id="reviewSummary" class="review-copy">No generated changes awaiting review.</p>
  <div class="actions">
    <button id="acceptProposal" disabled>Accept</button>
    <button id="rejectProposal" class="outline" disabled>Reject</button>
  </div>
  <button id="validateActive" class="outline validate-action" title="Run the generated Playwright test and available framework checks. Locator failures can trigger a snapshot-backed repair proposal." disabled>Validate generated test</button>
  <p class="validate-outline">Runs the generated Playwright test and framework checks. Locator failures can trigger a repair proposal based on fresh browser evidence.</p>
  <details>
    <summary>Workspace tools</summary>
    <div class="tool-list">
      <button id="history" class="secondary">Task history — view saved plans and results</button>
      <button id="open" class="secondary">Show workspace — reveal the configured framework folder</button>
      <button id="setTarget" class="secondary">Set target URL — configure the application address</button>
      <button id="runValidation" class="secondary">Run validation — check a generated task</button>
      <button id="repair" class="secondary">Propose repair from failed validation</button>
      <button id="rebuildIndex" class="secondary">Refresh framework index</button>
      <button id="clearHistory" class="secondary">Clear task history</button>
    </div>
  </details>
  <div class="note">Generate prepares a diff for review. Accept applies it. Validate runs the framework checks and tests; locator failures can produce a Playwright MCP based repair for review. Credentials are never stored.</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const message = document.getElementById('manualCase');
  const selectedFile = document.getElementById('selectedFile');
  const statusText = document.getElementById('statusText');
  const statusDetail = document.getElementById('statusDetail');
  const statusDot = document.getElementById('statusDot');
  const reviewSummary = document.getElementById('reviewSummary');
  const acceptButton = document.getElementById('acceptProposal');
  const rejectButton = document.getElementById('rejectProposal');
  const validateButton = document.getElementById('validateActive');
  let selectedFilePath = '';
  function setStatus(text) {
    statusText.textContent = text || 'Ready for code generation.';
    statusDot.classList.toggle('busy', /inspect|plan|generat|validat|repair|refresh/i.test(text));
    statusDot.classList.toggle('error', /fail|error|stopped|reject/i.test(text));
    statusDetail.textContent = /ready for code generation/i.test(text)
      ? 'Analyze the framework before generating for best results.'
      : 'Status updates appear here while TestPilot works.';
  }
  function send() {
    const text = selectedFilePath || message.value.trim(); if (!text) { setStatus('Enter test steps or select a document first.'); return; }
    setStatus('Choose a GitHub Copilot model to begin generation.');
    reviewSummary.textContent = 'Generation in progress.';
    acceptButton.disabled = true; rejectButton.disabled = true;
    validateButton.disabled = true;
    vscode.postMessage({ command: 'generate', text });
  }
  document.getElementById('generate').onclick = send;
  message.addEventListener('input', () => {
    if (selectedFilePath) { selectedFilePath = ''; selectedFile.textContent = 'No document selected'; }
    else if (message.value.trim()) selectedFile.textContent = 'Manual test steps entered';
    else selectedFile.textContent = 'No document selected';
  });
  for (const id of ['selectFile', 'useSelection', 'history', 'open', 'setTarget', 'runValidation', 'repair', 'clearHistory', 'rebuildIndex']) {
    document.getElementById(id).onclick = () => vscode.postMessage({ command: id });
  }
  acceptButton.onclick = () => vscode.postMessage({ command: 'acceptProposal' });
  rejectButton.onclick = () => vscode.postMessage({ command: 'rejectProposal' });
  validateButton.onclick = () => {
    validateButton.disabled = true;
    setStatus('Running the generated test suite…');
    vscode.postMessage({ command: 'validateActive' });
  };
  window.addEventListener('message', event => {
    const data = event.data;
    if (data?.kind === 'status') setStatus(data.text || '');
    if (data?.kind === 'review-ready') {
      reviewSummary.textContent = (data.count || 0) + ' file change(s) ready for ' + (data.title || 'review') + '. Check the open diff before deciding.';
      acceptButton.disabled = false; rejectButton.disabled = false;
      validateButton.disabled = true;
    }
    if (data?.kind === 'review-clear') {
      reviewSummary.textContent = data.text || 'No generated changes awaiting review.';
      acceptButton.disabled = true; rejectButton.disabled = true;
      validateButton.disabled = true;
    }
    if (data?.kind === 'validation-ready') {
      reviewSummary.textContent = 'Changes are applied. Run validation to execute the generated test and check the framework.';
      validateButton.disabled = false;
    }
    if (data?.kind === 'applied') {
      reviewSummary.textContent = (data.count || 0) + ' file(s) applied. Run validation to execute the generated test and check the framework.';
      acceptButton.disabled = true; rejectButton.disabled = true; validateButton.disabled = false;
    }
    if (data?.kind === 'file-selected') {
      selectedFilePath = data.path || ''; selectedFile.textContent = selectedFilePath ? 'Selected: ' + data.name : 'No document selected';
      message.value = '';
    }
    if (data?.kind === 'manual-case') {
      selectedFilePath = ''; selectedFile.textContent = data.name ? 'Using open file: ' + data.name : 'Using selected editor text'; message.value = data.text || '';
    }
  });
</script>
</body>
</html>`
  }
}
