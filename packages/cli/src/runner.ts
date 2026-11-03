/**
 * Orchestration: the task state machine that drives the ten agent stages.
 *
 * This is the deterministic spine of TCOE TestPilot. Entered stages record what
 * they concluded; front ends persist the completed task for review and resumption.
 *
 * The runner never writes to the target repository. It produces proposed
 * changes only; applying them requires explicit approval (see apply.ts).
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'

import type {
  AgentStage,
  ChatMessage,
  FileChange,
  PlanEntry,
  ReuseReport,
  StageRecord,
  TaskRecord,
  TestCase,
  TestCaseNormalizationResult,
  VerifiedLocator,
} from '@tcoe/shared-types'

import { detect } from '@tcoe/adapters'
import { analyzeFramework, summariseAnalysis, Workspace } from '@tcoe/repo-intelligence'
import type { FrameworkAnalysisResult } from '@tcoe/repo-intelligence'
import { fingerprint } from '@tcoe/repo-intelligence'
import { snapshotRepository } from './apply.ts'
import { getProvider, buildConfig } from '@tcoe/provider-abstraction'
import type { ProviderConfig, VscodeLmBridge } from '@tcoe/provider-abstraction'
import { buildEmissionOptions, emitFrameworkStandard } from '@tcoe/browser-tools'
import type { BrowserEvidence, BrowserElementRef, BrowserSession, BrowserSnapshot } from '@tcoe/browser-tools'
import type { EmissionOptions } from '@tcoe/browser-tools'

export interface RunOptions {
  /** The framework repository to analyze and change. */
  repositoryRoot: string
  /** Raw manual test case text. */
  rawTestCase: string
  /** Where task state is persisted. Must sit inside repositoryRoot. */
  stateDir: string
  /** Provider config override. */
  config?: Partial<ProviderConfig>
  /** VS Code host bridge required when config.provider is `vscode-lm`. */
  vscodeLmBridge?: VscodeLmBridge
  /** Skip writing the framework index (read-only run). */
  readOnly?: boolean
  /** Cancel the run, including any in-flight model request. */
  signal?: AbortSignal
  /**
   * Optional browser session for capturing page-level context.
   *
   * Passing nothing means no browser is launched — the Browse stage is then
   * recorded as skipped. Captured snapshots are returned separately from plan evidence.
   * Callers construct and own the session so they control the spawn.
   */
  browser?: BrowserSession
  /** Base URL to open when browsing. Without it, Browse is skipped. */
  targetUrl?: string
  /** Whether browsing should only inspect the starting page or replay manual steps. */
  browseMode?: 'start-page' | 'follow-steps'
  /** AppName key for navigation. Omitted emits a TODO rather than inventing one. */
  appName?: string
  /** Called as real stages start/finish so UI progress reflects actual work. */
  onStage?: (stage: AgentStage, status: StageRecord['status'], summary?: string) => void
  /** Status text for browser events that need the user's attention, such as MFA. */
  onStatus?: (message: string) => void
}

export interface RunResult {
  task: TaskRecord
  analysis: FrameworkAnalysisResult
  normalization: TestCaseNormalizationResult
  /** The plan text produced by the provider, awaiting approval. */
  planText: string
  /** True when the provider was the deterministic offline mock. */
  usedMockProvider: boolean
  /** Page-level browser observations; deliberately not attributed to individual steps. */
  evidence: BrowserEvidence[]
  /** Locators generated from snapshot refs that the selected model matched to manual steps. */
  browserLocatorCandidates: VerifiedLocator[]
}

class SnapshotTargetUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotTargetUnavailableError'
  }
}

/** The stages, in execution order; later stages are separate user-approved commands. */
const STAGE_SEQUENCE: AgentStage[] = [
  'Understand',
  'Observe',
  'Retrieve',
  'Decide',
  'Browse',
  'Plan',
  'Act',
  'Verify',
  'Recover',
  'Report',
]

function nowIso(): string {
  return new Date().toISOString()
}

class StageTracker {
  readonly records: StageRecord[] = []

  constructor(private readonly onUpdate?: RunOptions['onStage']) {}

  begin(stage: AgentStage): void {
    this.records.push({ stage, status: 'in-progress', startedAt: nowIso() })
    this.onUpdate?.(stage, 'in-progress')
  }

  complete(stage: AgentStage, summary: string): void {
    const record = this.records.find((r) => r.stage === stage && r.status === 'in-progress')
    if (!record) {
      this.records.push({ stage, status: 'completed', startedAt: nowIso(), completedAt: nowIso(), summary })
      return
    }
    record.status = 'completed'
    record.completedAt = nowIso()
    record.summary = summary
    this.onUpdate?.(stage, 'completed', summary)
  }

  skip(stage: AgentStage, summary: string): void {
    this.records.push({ stage, status: 'skipped', startedAt: nowIso(), completedAt: nowIso(), summary })
    this.onUpdate?.(stage, 'skipped', summary)
  }

  fail(stage: AgentStage, summary: string): void {
    const record = this.records.find((r) => r.stage === stage && r.status === 'in-progress')
    if (record) {
      record.status = 'failed'
      record.completedAt = nowIso()
      record.summary = summary
    } else {
      this.records.push({ stage, status: 'failed', startedAt: nowIso(), completedAt: nowIso(), summary })
    }
    this.onUpdate?.(stage, 'failed', summary)
  }
}

/**
 * Run Understand → Observe → Retrieve → Decide → optional Browse → Plan.
 *
 * Stops at `AwaitingApproval`: Act, Verify, Recover and Report only run after
 * a human approves the plan (handled by apply.ts and validate.ts).
 */
export async function runAgent(options: RunOptions): Promise<RunResult> {
  const taskId = randomUUID()
  const tracker = new StageTracker(options.onStage)
  const modelCalls: TaskRecord['modelCalls'] = []

  const task: TaskRecord = {
    taskId,
    title: '',
    status: 'Created',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    repositoryRoot: options.repositoryRoot,
    testCaseSource: 'manual input',
    stages: tracker.records,
    proposedChanges: [],
    appliedChanges: [],
    modelCalls,
  }

  // ── Understand: normalize the manual test case ─────────────────────────────
  tracker.begin('Understand')
  let testCase: TestCase | null = null
  let normalization: TestCaseNormalizationResult

  try {
    const batchInputs = splitTitledTestCases(options.rawTestCase)
    const detectedCases = await Promise.all(batchInputs.map((input) => detect(input)))
    const normalizedCases = detectedCases.map((detected) => detected.result.testCase)
    const errorsFromBatch = detectedCases.flatMap((detected) => detected.result.issues)
    normalization = batchInputs.length > 1
      ? { testCase: normalizedCases[0] ?? null, issues: errorsFromBatch }
      : detectedCases[0]!.result
    testCase = normalization.testCase

    const errors = normalization.issues.filter((i) => i.severity === 'error')
    const warnings = normalization.issues.filter((i) => i.severity === 'warning')

    if (!testCase || errors.length > 0) {
      task.status = 'Failed'
      tracker.fail('Understand', `Input validation failed: ${errors.map((e) => e.message).join('; ')}`)
      task.error = {
        message: errors.map((e) => e.message).join('; ') || 'Test case could not be parsed.',
        stage: 'Understand',
      }
      throw new InputValidationError(normalization)
    }

    task.title = testCase.title
    task.testCase = testCase
    task.testCases = normalizedCases.length > 1 && normalizedCases.every((item): item is TestCase => item !== null)
      ? normalizedCases as TestCase[]
      : [testCase]
    task.testCaseSource = `${testCase.source.kind}: ${testCase.source.reference}`
    task.status = 'InputValidated'

    tracker.complete(
      'Understand',
      `${task.testCases.length > 1 ? `Parsed ${task.testCases.length} titled cases; ` : `Parsed as ${testCase.source.kind}: `}${testCase.steps.length} step(s) in the first case, ` +
        `${testCase.preconditions.length} precondition(s). ` +
        `${warnings.length} warning(s). Adapter recorded ${testCase.source.assumptions.length} assumption(s).`,
    )
  } catch (err) {
    if (err instanceof InputValidationError) throw err
    task.status = 'Failed'
    tracker.fail('Understand', err instanceof Error ? err.message : String(err))
    throw err
  }

  // ── Observe: analyze the framework ────────────────────────────────────────
  tracker.begin('Observe')
  task.status = 'RepositoryAnalyzing'
  const analysis = analyzeFramework({
    repositoryRoot: options.repositoryRoot,
    testCase,
    indexDir: options.readOnly ? undefined : join(options.stateDir, 'index'),
    persistIndex: !options.readOnly,
  })
  task.repositorySnapshot = snapshotRepository(
    options.repositoryRoot,
    analysis.scan.files.map((file) => file.relativePath),
  )
  tracker.complete(
    'Observe',
    `Indexed ${analysis.scan.files.length} file(s); found ${analysis.facts.tests.length} test(s), ` +
      `${analysis.facts.actionMethods.length} action method(s), ${analysis.facts.locators.length} locator(s). ` +
      `Dominant locator strategy: ${analysis.report.locatorStrategy.preferredStrategy}.`,
  )

  // ── Retrieve: reuse analysis (already computed, deterministic) ───────────
  tracker.begin('Retrieve')
  const reuse: ReuseReport | undefined = analysis.reuse
  if (reuse) {
    task.reuseReport = reuse
    tracker.complete(
      'Retrieve',
      `Decision ${reuse.decision.decision}; ${reuse.duplicates.length} duplicate candidate(s); ` +
        `${reuse.helperMethods.length} helper method(s) above threshold; ` +
        `${reuse.missingFunctionality.length} step(s) need new framework code.`,
    )
  } else {
    tracker.skip('Retrieve', 'No test case supplied, so no reuse analysis was performed.')
  }

  // ── Decide: convert reuse into a step plan (deterministic) ───────────────
  tracker.begin('Decide')
  const plan = buildPlan(testCase!, reuse, analysis)
  task.decision = reuse?.decision
  task.plan = plan
  task.status = 'Planning'
  tracker.complete(
    'Decide',
    `Mapped ${plan.length} step(s) to framework symbols. ` +
      `${plan.filter((p) => p.resolution === 'unresolved').length} step(s) are unresolved.`,
  )

  const config = buildConfig(options.config ?? {}, options.repositoryRoot)
  const provider = getProvider(config, { vscodeLmBridge: options.vscodeLmBridge })
  const providerInfo = await provider.check()

  if (!providerInfo.available) {
    task.status = 'Failed'
    task.error = {
      message: `Model provider "${providerInfo.id}" is unavailable: ${providerInfo.unavailableReason ?? 'unknown reason'}`,
      stage: 'Plan',
    }
    tracker.fail('Plan', task.error.message)
    throw new Error(task.error.message)
  }

  const model = await provider.selectDefault()
  const modelId = options.config?.model ?? model?.id

  // ── Browse: capture page-level context without claiming step attribution ───
  // Opt-in only. A browser launch is a side effect against a real application,
  // so it never happens as a consequence of reading a test case.
  let evidence: BrowserEvidence[] = []
  let browserLocatorCandidates: VerifiedLocator[] = []
  if (options.browser && options.targetUrl) {
    tracker.begin('Browse')
    try {
      const casesToInspect = task.testCases?.length ? task.testCases : [testCase!]
      for (const testCaseToInspect of casesToInspect) {
        // Each manual case may start on a different URL and has its own ordered
        // navigation flow. Re-run from that case's first URL so later cases do
        // not inherit the last screen of the previous case.
        const caseTargetUrl = testCaseToInspect.steps
          .map((step) => extractStepUrl(step.action))
          .find((url): url is string => Boolean(url)) ?? options.targetUrl
        const observed = await gatherEvidenceForTestCase(options.browser, {
          targetUrl: caseTargetUrl,
          steps: testCaseToInspect.steps,
          mode: options.browseMode ?? 'start-page',
          onStatus: options.onStatus,
          selectSnapshotTarget: providerInfo.liveService
            ? async (stepAction, actionKind, candidates, signal) => {
                // Keep the LLM's choice grounded in the live snapshot, but send only
                // the highest-relevance named candidates instead of the full tree.
                const targetText = parseReplayAction(stepAction)?.target ?? stepAction
                const candidateShortlist = rankSnapshotElements(candidates, [targetText]).slice(0, 12)
                const messages: ChatMessage[] = [
                  {
                    role: 'system',
                    content: 'Select the snapshot element that best matches the manual browser step and requested action. Do not require an exact text match: account for similar wording, plurals, abbreviations, common synonyms, and the surrounding navigation context (for example, "Project List" may match "Project Listing"). Choose the closest plausible candidate when one is clear; abstain only when no candidate is plausibly related or multiple candidates are similarly likely. Choose only a ref from the supplied candidates. Never invent a ref or locator. Return only JSON: {"ref":"exact-ref","confidence":0.0,"reason":"short match rationale"} or {"ref":null,"confidence":0.0,"reason":"short reason"}.',
                  },
                  {
                    role: 'user',
                    content: JSON.stringify({
                      manualStep: stepAction,
                      requiredAction: actionKind,
                      observedSnapshotElements: candidateShortlist.map(({ ref, role, name, context, navigation }) => ({ ref, role, name, context, navigation })),
                    }),
                  },
                ]
                const selection = await provider.chat(messages, {
                  purpose: 'locator-selection',
                  modelId,
                  signal,
                  maxTokens: 120,
                })
                task.modelCalls.push({
                  provider: providerInfo.id,
                  model: selection.modelId,
                  at: nowIso(),
                  purpose: 'locator-selection',
                })
                const selected = parseSnapshotTargetSelection(selection.text)
                if (!selected.ref || (selected.confidence !== undefined && (selected.confidence < 0.65 || selected.confidence > 1))) {
                  const backend = options.browser?.provenance?.backendLabel ?? 'browser'
                  throw new SnapshotTargetUnavailableError(`Step "${stepAction}" has no confident match in the ${backend} snapshot.${selected.reason ? ` Model response: ${selected.reason}` : ''}`)
                }
                const match = candidateShortlist.filter((candidate) => candidate.ref === selected.ref)
                if (match.length !== 1) {
                  const backend = options.browser?.provenance?.backendLabel ?? 'browser'
                  throw new SnapshotTargetUnavailableError(`The selected model returned ref "${selected.ref}", which is not a unique element in the ${backend} snapshot.`)
                }
                const selectedElement = match[0]!
                const semanticScore = Math.max(
                  textMatchScore(normalizeWords(selectedElement.name ?? ''), normalizeWords(targetText)),
                  textMatchScore(normalizeWords(selectedElement.context ?? ''), normalizeWords(targetText)) * 0.85,
                )
                if (isSidebarNavigationStep(stepAction) && semanticScore < 0.35) {
                  const backend = options.browser?.provenance?.backendLabel ?? 'browser'
                  throw new SnapshotTargetUnavailableError(`The ${backend} model selected a generic navigation element without a label or context tying it to "${targetText}".`)
                }
                return selectedElement
              }
            : undefined,
          signal: options.signal,
        })
        evidence.push(...observed.evidence.map((item) => ({
          ...item,
          detail: `Test case: ${testCaseToInspect.title}\n${item.detail}`,
        })))
        browserLocatorCandidates.push(...observed.locatorCandidates)
      }
      task.browserLocatorCandidates = browserLocatorCandidates

      const backend = options.browser.provenance?.backendLabel ?? 'browser'
      tracker.complete(
        'Browse',
        `Captured ${evidence.filter((item) => item.kind === 'snapshot').length} screen snapshot(s) and ` +
          `${browserLocatorCandidates.length} step-scoped locator candidate(s) via ${backend}` +
          `${options.browser.usedFallback ? ' (fell back from the primary backend)' : ''}.`,
      )
    } catch (err) {
      tracker.fail('Browse', err instanceof Error ? err.message : String(err))
      throw new Error(
        `Browser evidence gathering failed and cannot be skipped once started: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      await options.browser.close().catch(() => undefined)
    }
  } else {
    tracker.skip(
      'Browse',
      options.browser
        ? 'No targetUrl configured, so there was nowhere to navigate.'
        : 'No browser session supplied, so no page snapshot was gathered.',
    )
  }

  // ── Plan: ask the provider for the plan narrative (no code yet) ───────────
  tracker.begin('Plan')

  const { buildSystemPrompt, buildPlanUserPrompt } = await import('@tcoe/provider-abstraction')

  const promptMessages: ChatMessage[] = [
    { role: 'system' as const, content: buildSystemPrompt() },
    {
      role: 'user' as const,
      content: buildPlanUserPrompt({
        testCaseTitle: testCase!.title,
        testCaseSteps: testCase!.steps
          .map((s) => `${s.order}. ${s.action}${s.expectedResult ? `\n   Expected: ${s.expectedResult}` : ''}`)
          .join('\n'),
        manualTestCases: task.testCases,
        reuseCoverage: renderReuseCoverage(plan),
        duplicateFindings: renderDuplicateFindings(reuse),
        conventions: analysis.report.conventions.confirmed.join('\n'),
        actionMethodsSummary: renderActionMethodSummary(analysis.facts.actionMethods, reuse),
        pageObjectNames: renderRelevantPageObjects(analysis),
        locatorExamples: renderRelevantLocatorExamples(analysis),
        fixtures: analysis.facts.fixtures.map((f) => f.name),
        testDataModules: analysis.facts.testDataModules,
        taskId,
        approvalMode: config.approvalMode,
        plan,
      }),
    },
  ]

  let planText: string
  try {
    const response = await provider.chat(promptMessages, {
      purpose: 'plan',
      modelId,
      signal: options.signal,
    })
    planText = response.text
    modelCalls.push({
      provider: providerInfo.id,
      model: response.modelId,
      at: nowIso(),
      purpose: 'plan',
    })
  } catch (err) {
    task.status = 'Failed'
    task.error = {
      message: err instanceof Error ? err.message : String(err),
      stage: 'Plan',
    }
    tracker.fail('Plan', task.error.message)
    throw err
  }

  task.status = 'AwaitingApproval'
  tracker.complete(
    'Plan',
    `Provider "${providerInfo.id}" produced a plan. No code has been generated; awaiting human approval.`,
  )

  task.updatedAt = nowIso()

  return {
    task,
    analysis,
    normalization,
    planText,
    usedMockProvider: providerInfo.id === 'mock',
    evidence,
    browserLocatorCandidates,
  }
}

/** Observe the starting page, or replay the user's steps and capture each resulting screen. */
export async function gatherEvidenceForTestCase(
  browser: BrowserSession,
  options: {
    targetUrl: string
    steps: TestCase['steps']
    mode: 'start-page' | 'follow-steps'
    selectSnapshotTarget?: (
      stepAction: string,
      actionKind: SnapshotSelectionAction,
      candidates: BrowserElementRef[],
      signal?: AbortSignal,
    ) => Promise<BrowserElementRef>
    /** Internal guard so a failed MCP retry cannot recursively restart forever. */
    fallbackRetry?: boolean
    signal?: AbortSignal
    onStatus?: (message: string) => void
  },
): Promise<{ evidence: BrowserEvidence[]; locatorCandidates: VerifiedLocator[] }> {
  const evidence: BrowserEvidence[] = []
  const locatorCandidates: VerifiedLocator[] = []
  const navigation = await browser.navigate(options.targetUrl, { signal: options.signal })
  if (navigation.detail.startsWith('Navigation failed:')) {
    throw new Error(navigation.detail)
  }
  evidence.push(navigation)
  await waitForPageReady('Initial navigation')

  let currentUrl = options.targetUrl
  let snapshot = await captureScreen('Starting page', currentUrl)
  const locatorActionSteps = options.steps.filter((step) => isLocatorAction(step.action))

  if (options.mode === 'start-page') {
    // A single page observation must never be offered as a verified locator for
    // controls that are only present on later screens.
    const firstAction = locatorActionSteps[0]
    if (firstAction) {
      locatorCandidates.push(...await candidatesForStep(snapshot, firstAction.order, firstAction.action, currentUrl))
    }
    return { evidence, locatorCandidates }
  }

  try {
  for (const [stepIndex, step] of options.steps.entries()) {
    if (options.signal?.aborted) throw new Error('Browser step replay was cancelled.')

    if (isManualWaitStep(step.action)) {
      const awaitedStep = options.steps.slice(stepIndex + 1).find((candidate) => isLocatorAction(candidate.action))
      const awaitedAction = awaitedStep ? parseReplayAction(awaitedStep.action) : undefined
      const targetDescription = awaitedAction?.target ?? manualWaitTarget(step.action)
      const deadline = Date.now() + 60_000
      let matched: BrowserElementRef | undefined
      let polls = 0
      let openedCollapsedSearch = false
      let mfaNoticeSent = false
      let lastObservedControls: string[] = []
      let lastObservedPage = ''
      while (Date.now() < deadline) {
        if (options.signal?.aborted) throw new Error('Browser step replay was cancelled.')
        const refreshed = await browser.capture(undefined, { signal: options.signal })
        if (refreshed) {
          snapshot = refreshed
          const pageUrl = refreshed.raw.match(/(?:Page URL|URL):\s*(https?:\/\/[^\s]+)/i)?.[1]
          if (pageUrl) {
            try {
              const safeUrl = new URL(pageUrl)
              lastObservedPage = `${safeUrl.origin}${safeUrl.pathname}`
            } catch { /* Ignore malformed or non-URL snapshot metadata. */ }
          }
          if (!mfaNoticeSent && isMfaChallenge(snapshot)) {
            mfaNoticeSent = true
            options.onStatus?.('PingID or another MFA prompt detected. Approve the sign-in on your registered device; TestPilot will wait up to 60 seconds for the next page control.')
          }
          let ranked = targetDescription
            ? findActionTargets(snapshot, targetDescription, awaitedAction?.kind ?? 'click', false, isSearchTarget(targetDescription))
            : []
          // SAP/Fiori controls can be visible in the live DOM while their
          // accessibility snapshot name is empty or generic. Inspect visible
          // inputs on a slower cadence and merge only DOM-observed controls.
          let domTargets: BrowserElementRef[] = []
          if (targetDescription && (polls === 0 || polls % 3 === 0)) {
            domTargets = await inspectVisibleDomTargets(browser, targetDescription, options.signal)
            // run-code/eval may refresh the CLI's ephemeral aria refs. Re-snapshot
            // before selecting or acting on a ref from the current screen.
            const afterInspection = await browser.capture(undefined, { signal: options.signal })
            if (afterInspection) {
              snapshot = afterInspection
              ranked = findActionTargets(snapshot, targetDescription, awaitedAction?.kind ?? 'click', false, isSearchTarget(targetDescription))
            }
            if (domTargets.length > 0) {
              const existingRefs = new Set(snapshot.elements.map((element) => element.ref))
              const newTargets = domTargets.filter((element) => !existingRefs.has(element.ref))
              if (newTargets.length > 0) {
                snapshot = { ...snapshot, elements: [...snapshot.elements, ...newTargets] }
                ranked = findActionTargets(snapshot, targetDescription, awaitedAction?.kind ?? 'click', false, isSearchTarget(targetDescription))
              }
            }
          }
          lastObservedControls = [...snapshot.elements, ...domTargets]
            .filter((element) => element.name || (isSearchTarget(targetDescription ?? '') && element.role === 'searchbox'))
            .map((element) => element.name
              ? `${element.role ?? 'element'} "${element.name}"`
              : `${element.role ?? 'element'} (unnamed, visible)`)
            .filter((entry, index, all) => all.indexOf(entry) === index)
            .slice(0, 8)

          // In SAP Fiori the global search can start collapsed behind a Search
          // shell-bar button. If the manual case says to wait for the search
          // field and the next step fills it, open only a uniquely observed
          // Search button, then keep waiting for the actual editable field.
          if (!matched && !openedCollapsedSearch && awaitedAction?.kind === 'fill' &&
              /\bsearch\b/i.test(targetDescription ?? '')) {
            const searchButtons = findActionTargets(snapshot, 'Search', 'click')
              .filter(({ element, score }) =>
                /^(?:button|search|generic)$/i.test(element.role ?? '') &&
                /^search(?:\s+(?:apps|applications|all))?$/i.test((element.name ?? '').trim()) &&
                score >= 0.9,
              )
            if (searchButtons.length === 1) {
              openedCollapsedSearch = true
              const opened = await browser.execute(
                (tool, callOptions) => tool.click(searchButtons[0]!.element.ref, callOptions),
                { signal: options.signal },
              )
              if (!opened.ok) {
                throw new Error(`Step ${step.order} found the SAP Search button but could not open its search field: ${opened.error ?? 'click failed'}.`)
              }
              evidence.push({
                kind: 'interaction',
                detail: `Step ${step.order}: opened the uniquely observed Search shell-bar button to reveal the Search field required by the next manual step.`,
                source: opened.provenance ?? browser.provenance ?? navigation.source,
              })
            }
          }
          if (ranked[0] && ranked[0].score >= 0.55 &&
              (!ranked[1] || ranked[0].score - ranked[1].score >= 0.05)) {
            matched = ranked[0].element
            break
          }
        }
        polls++
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      if (!matched) {
        if (!mfaNoticeSent && !options.fallbackRetry &&
            browser.activateFallback(`Playwright CLI exposed no matching control for explicit wait target "${targetDescription ?? ''}"`)) {
          options.onStatus?.(`Playwright CLI could not expose the awaited ${targetDescription ?? 'page'} control. Restarting the manual flow with Playwright MCP to inspect it.`)
          return gatherEvidenceForTestCase(browser, { ...options, fallbackRetry: true })
        }
        const observed = lastObservedControls.length > 0 ? ` Latest visible controls: ${lastObservedControls.join('; ')}.` : ' No named visible controls were exposed.'
        const pageContext = lastObservedPage ? ` Last observed page: ${lastObservedPage}.` : ''
        const authenticationContext = mfaNoticeSent
          ? ' An MFA prompt was detected; approve the request and complete any number challenge in the headed browser before retrying.'
          : ''
        throw new Error(`Step ${step.order} timed out waiting for ${targetDescription ? `the next step target "${targetDescription}"` : `"${manualWaitTarget(step.action) ?? 'the requested page element'}"`} in fresh accessibility snapshots and visible DOM controls.${observed}${pageContext}${authenticationContext} No later screen evidence was collected.`)
      }
      evidence.push({
        kind: 'snapshot',
        detail: `Step ${step.order} explicit wait completed: observed ${matched.role ?? 'element'} "${matched.name || targetDescription}" in a fresh browser snapshot before continuing.`,
        source: browser.provenance ?? navigation.source,
      })
      snapshot = await captureScreen(`After wait step ${step.order}`, currentUrl)
      continue
    }

    const explicitUrl = extractStepUrl(step.action)
    if (explicitUrl) {
      if (normalizeUrl(explicitUrl) !== normalizeUrl(currentUrl)) {
        const result = await browser.navigate(explicitUrl, { signal: options.signal })
        if (result.detail.startsWith('Navigation failed:')) {
          evidence.push({
            ...result,
            detail: `Step ${step.order} navigation failed: ${result.detail}`,
          })
          continue
        }
        evidence.push({ ...result, detail: `Step ${step.order}: ${result.detail}` })
        currentUrl = explicitUrl
        await waitForPageReady(`Step ${step.order} navigation`)
        snapshot = await captureScreen(`After step ${step.order}: ${step.action}`, currentUrl)
      }
      continue
    }

    const action = parseReplayAction(step.action)
    if (!action && isLocatorAssertionStep(step.action)) {
      const terms = assertionTextTerms(step.action)
      const matchedElements = options.selectSnapshotTarget
        ? await options.selectSnapshotTarget(
            step.action,
            'assert-visible',
            rankSnapshotElements(snapshot.elements, terms),
            options.signal,
          ).then((selected) => [selected])
        : snapshot.elements.filter((element) => {
            const name = normalizeWords(element.name ?? '')
            return name.length > 0 && terms.some((term) => name.includes(normalizeWords(term)))
          })
      const observed = await candidatesForStep(snapshot, step.order, step.action, currentUrl, matchedElements)
      locatorCandidates.push(...observed)
      evidence.push({
        kind: 'interaction',
        detail: observed.length > 0
          ? `Step ${step.order} assertion locator candidates were generated from matching visible text in the post-action snapshot.`
          : `Step ${step.order} assertion has no matching visible text/ref in the current snapshot; no locator was inferred.`,
        source: browser.provenance ?? navigation.source,
      })
    } else if (!action && isLocatorAction(step.action)) {
      throw new Error(`Step ${step.order} could not be replayed safely: unsupported browser action "${step.action}". No later screen evidence was collected.`)
    }
    let sidebarTrialForStep: Awaited<ReturnType<typeof retrySidebarNavigationCandidates>> | undefined
    if (action) {
      let compatibleTargets = findActionTargets(
        snapshot,
        action.target,
        action.kind,
        action.kind === 'click' && Boolean(action.intent),
        isSearchTarget(action.target),
      )
        .map((candidate) => candidate.element)
      // Accessibility snapshots can identify a control without preserving its
      // owning iframe in the generated locator. Inspect live DOM targets on every
      // action so iframe-scoped evidence (including unique data-help-id selectors)
      // supplements the snapshot even when its accessible name already matched.
      const bestSnapshotScore = findActionTargets(
        snapshot,
        action.target,
        action.kind,
        action.kind === 'click' && Boolean(action.intent),
        isSearchTarget(action.target),
      )[0]?.score ?? 0
      const domElements = await inspectVisibleDomTargets(
        browser,
        action.target,
        options.signal,
        isSidebarNavigationStep(step.action),
      )
      if (domElements.length > 0) {
        // run-code can refresh ephemeral CLI refs, so always capture a new snapshot
        // before selecting/clicking. The DOM locator expressions themselves remain
        // grounded and can be used for the action if selected.
        const afterInspection = await browser.capture(undefined, { signal: options.signal })
        if (afterInspection) snapshot = afterInspection
        const existingRefs = new Set(snapshot.elements.map((element) => element.ref))
        const newElements = domElements.filter((element) => !existingRefs.has(element.ref))
        if (newElements.length > 0) {
          snapshot = { ...snapshot, elements: [...snapshot.elements, ...newElements] }
          compatibleTargets = findActionTargets(
            snapshot,
            action.target,
            action.kind,
            action.kind === 'click' && Boolean(action.intent),
            isSearchTarget(action.target),
          ).map((candidate) => candidate.element)
          evidence.push({
            kind: 'snapshot',
            detail: bestSnapshotScore < 0.35
              ? `Step ${step.order}: enriched generic accessibility snapshot labels with ${newElements.length} visible DOM target(s) for "${action.target}".`
              : `Step ${step.order}: supplemented the snapshot match with ${newElements.length} visible DOM target(s), including frame-scoped locator evidence for "${action.target}".`,
            source: browser.provenance ?? navigation.source,
          })
        }
      }
      // Enterprise apps often finish an SSO redirect or client-side menu render
      // shortly after the click command returns. Give the current page a brief,
      // bounded chance to expose the next screen before declaring that its
      // snapshot has no usable candidates and switching to MCP.
      if (compatibleTargets.length === 0) {
        for (let retry = 0; retry < 6 && compatibleTargets.length === 0; retry++) {
          if (options.signal?.aborted) throw new Error('Browser step replay was cancelled.')
          await new Promise((resolve) => setTimeout(resolve, 400))
          const refreshed = await browser.capture(undefined, { signal: options.signal })
          if (!refreshed) continue
          snapshot = refreshed
          compatibleTargets = findActionTargets(
            snapshot,
            action.target,
            action.kind,
            action.kind === 'click' && Boolean(action.intent),
            isSearchTarget(action.target),
          ).map((candidate) => candidate.element)
        }
      }
      const preActionSnapshot = snapshot
      let target: BrowserElementRef | undefined
      if (options.selectSnapshotTarget) {
        try {
          target = await options.selectSnapshotTarget(step.action, action.kind, compatibleTargets, options.signal)
        } catch (error) {
          if (!(error instanceof SnapshotTargetUnavailableError) || !options.fallbackRetry ||
              !isSidebarNavigationRetryEligible(step.action, action, options.steps[stepIndex + 1])) {
            throw error
          }
          sidebarTrialForStep = await retrySidebarNavigationCandidates(stepIndex, action, snapshot, currentUrl)
          if (sidebarTrialForStep) target = sidebarTrialForStep.target
          else throw new SnapshotTargetUnavailableError(`${error.message} No grounded sidebar candidate could be confirmed by the next expected screen element.`)
        }
      } else {
        target = findActionTarget(snapshot, action.target, action.kind)
      }
      if (!target && options.fallbackRetry && isSidebarNavigationRetryEligible(step.action, action, options.steps[stepIndex + 1])) {
        sidebarTrialForStep = await retrySidebarNavigationCandidates(stepIndex, action, snapshot, currentUrl)
        if (sidebarTrialForStep) target = sidebarTrialForStep.target
      }
      // Never turn unrelated controls from the same page into evidence for a
      // requested target that could not be matched uniquely.
      const candidateElements = target ? [target] : []
      locatorCandidates.push(...await candidatesForStep(
        preActionSnapshot,
        step.order,
        step.action,
        currentUrl,
        candidateElements,
      ))

      if (!target) {
        throw new SnapshotTargetUnavailableError(`Step ${step.order} could not be replayed safely: no unique ${action.kind === 'fill' ? 'editable control' : 'control'} matching "${action.target}" was found in the current browser evidence. No later screen evidence was collected.`)
      }
      if (action.kind === 'fill' && !action.value) {
        throw new Error(`Step ${step.order} could not be replayed safely: no input value was found for "${action.target}".`)
      }
      const result = sidebarTrialForStep?.result ?? await browser.execute(
        async (tool, callOptions) => {
          switch (action.kind) {
            case 'fill': return tool.fill(target.locatorExpression ?? target.ref, action.value!, callOptions)
            case 'check': return tool.check
              ? tool.check(target.locatorExpression ?? target.ref, callOptions)
              : { ok: false, error: `${tool.info.label} does not support safe checkbox check operations.` }
            case 'uncheck': return tool.uncheck
              ? tool.uncheck(target.locatorExpression ?? target.ref, callOptions)
              : { ok: false, error: `${tool.info.label} does not support safe checkbox uncheck operations.` }
            default: return tool.click(target.locatorExpression ?? target.ref, callOptions)
          }
        },
        { signal: options.signal },
      )
      const clickTriggeredNavigationWaitTimeout = action.kind === 'click' &&
        !result.ok && isClickNavigationWaitTimeout(result.error)
      let mcpTimeoutProgressed = false
      if (action.kind === 'click' && !result.ok && isMcpToolCallTimeout(result.error)) {
        const nextStep = options.steps.slice(stepIndex + 1).find((candidate) => isLocatorAction(candidate.action))
        const nextAction = nextStep ? parseReplayAction(nextStep.action) : undefined
        if (nextAction) {
          // MCP can time out while returning from a click that already advanced the
          // application. Observe the page before deciding; never repeat that click.
          const afterTimeout = await browser.capture(undefined, { signal: options.signal })
          if (afterTimeout && browserSnapshotSignature(afterTimeout) !== browserSnapshotSignature(preActionSnapshot) &&
              findActionTarget(afterTimeout, nextAction.target, nextAction.kind)) {
            snapshot = afterTimeout
            mcpTimeoutProgressed = true
          }
        }
      }
      if (!result.ok && !clickTriggeredNavigationWaitTimeout && !mcpTimeoutProgressed) {
        throw new Error(`Step ${step.order} could not be replayed safely: ${result.error ?? 'browser action failed'}. No later screen evidence was collected.`)
      }
      if (!sidebarTrialForStep) await waitForPageReady(`Step ${step.order} action`)
      evidence.push({
        kind: 'interaction',
        detail: sidebarTrialForStep
          ? `Step ${step.order} selected sidebar locator ${target.ref} after candidate attempt ${sidebarTrialForStep.attempt}; the following step's target was visible: ${step.action}`
          : clickTriggeredNavigationWaitTimeout
          ? `Step ${step.order} click completed, but the CLI timed out waiting for the scheduled navigation; the flow continued without repeating the click: ${step.action}`
          : mcpTimeoutProgressed
          ? `Step ${step.order} MCP click timed out, but a fresh snapshot confirmed a changed screen and the next step's target; the click was not repeated: ${step.action}`
          : `Step ${step.order} replayed: ${step.action}`,
        source: result.provenance ?? browser.provenance ?? navigation.source,
      })
      const location = sidebarTrialForStep ? undefined : await browser.execute(
        (tool, callOptions) => tool.eval('() => window.location.href', undefined, callOptions),
        { signal: options.signal },
      )
      if (sidebarTrialForStep) {
        currentUrl = sidebarTrialForStep.url
        snapshot = sidebarTrialForStep.snapshot
      } else if (location?.ok && location.output) {
        const observedUrl = extractStepUrl(location.output)
        if (observedUrl) currentUrl = observedUrl
      }
    }

    // Snapshot after every step. The next step's locator candidates therefore
    // come from the screen that is actually visible at that point in the flow.
    if (!sidebarTrialForStep) {
      snapshot = await captureScreen(`After step ${step.order}: ${step.action}`, currentUrl)
    }
  }
  } catch (error) {
    if (error instanceof SnapshotTargetUnavailableError && !options.fallbackRetry) {
      if (browser.activateFallback(`Playwright CLI could not confidently map a manual step: ${error.message}`)) {
        return gatherEvidenceForTestCase(browser, { ...options, fallbackRetry: true })
      }
      throw new Error(`${error.message} Playwright MCP fallback is unavailable.`)
    }
    throw error
  }

  return { evidence, locatorCandidates }

  async function captureScreen(label: string, pageUrl: string) {
    const observed = await browser.capture(undefined, { signal: options.signal })
    if (!observed) throw new Error(`The browser could not capture a snapshot for ${label}.`)
    const source = browser.provenance ?? navigation.source
    const elements = observed.elements
      .slice(0, 40)
      .map((element) => `${element.role ?? 'element'}${element.name ? ` "${element.name}"` : ''} [${element.ref}]`)
    evidence.push({
      kind: 'snapshot',
      detail: `${label} (${pageUrl})\n${elements.length > 0 ? elements.join('\n') : `Snapshot contains ${observed.elements.length} element(s).`}`,
      source,
    })
    return observed
  }

  async function waitForPageReady(label: string): Promise<void> {
    const ready = await browser.waitForPageReady({ signal: options.signal })
    if (!ready.ok) {
      throw new Error(`${label} did not reach both the load and network-idle states: ${ready.error ?? 'browser readiness wait failed'}.`)
    }
    if (/networkidle timed out|MCP (?:waited|captured)/i.test(ready.output ?? '')) {
      evidence.push({
        kind: 'eval',
        detail: `${label}: ${ready.output}`,
        source: ready.provenance,
      })
    }
  }

  async function retrySidebarNavigationCandidates(
    stepIndex: number,
    action: ReplayAction,
    checkpoint: BrowserSnapshot,
    checkpointUrl: string,
  ): Promise<{
    target: BrowserElementRef
    result: Awaited<ReturnType<BrowserSession['execute']>>
    snapshot: BrowserSnapshot
    url: string
    attempt: number
  } | undefined> {
    if (action.kind !== 'click') return undefined
    const nextStep = options.steps.slice(stepIndex + 1).find((candidate) => !extractStepUrl(candidate.action))
    const expectedNext = nextStep ? parseReplayAction(nextStep.action) : undefined
    if (!nextStep || !expectedNext) return undefined

    const candidateScore = (element: BrowserElementRef): number => Math.max(
      textMatchScore(normalizeWords(element.name ?? ''), normalizeWords(action.target)),
      textMatchScore(normalizeWords(element.context ?? ''), normalizeWords(action.target)) * 0.85,
    )
    const candidates = checkpoint.elements
      .filter((element) => element.actionable !== false && element.navigation && element.locatorExpression)
      .filter((element) => /^(?:link|menuitem|treeitem|tab|button|generic)$/i.test(element.role ?? 'generic'))
      .sort((a, b) => candidateScore(b) - candidateScore(a))
      .slice(0, 4)
    if (candidates.length === 0) return undefined

    const checkpointSignature = browserSnapshotSignature(checkpoint)
    const readUrl = async (): Promise<string> => {
      const observed = await browser.execute(
        (tool, callOptions) => tool.eval('() => window.location.href', undefined, callOptions),
        { signal: options.signal },
      )
      return observed.ok && observed.output ? extractStepUrl(observed.output) ?? checkpointUrl : checkpointUrl
    }
    const restoreCheckpoint = async (): Promise<boolean> => {
      const back = await browser.execute(
        (tool, callOptions) => tool.eval('() => { history.back(); return "restore requested" }', undefined, callOptions),
        { signal: options.signal },
      )
      if (!back.ok) return false
      try { await waitForPageReady('Restore after an unverified sidebar candidate') } catch { return false }
      const restoredUrl = await readUrl()
      const restoredSnapshot = await browser.capture(undefined, { signal: options.signal })
      if (!restoredSnapshot) return false
      snapshot = restoredSnapshot
      currentUrl = restoredUrl
      return normalizeUrl(restoredUrl) === normalizeUrl(checkpointUrl) &&
        browserSnapshotSignature(restoredSnapshot) === checkpointSignature
    }

    let attempts = 0
    for (const candidate of candidates) {
      if (options.signal?.aborted) throw new Error('Sidebar candidate retry was cancelled.')
      attempts++
      const result = await browser.execute(
        (tool, callOptions) => tool.click(candidate.locatorExpression ?? candidate.ref, callOptions),
        { signal: options.signal },
      )
      const completedDespiteTimeout = !result.ok && isClickNavigationWaitTimeout(result.error)
      if (result.ok || completedDespiteTimeout) {
        try { await waitForPageReady(`Sidebar candidate ${attempts} navigation`) } catch { /* inspect before deciding whether to restore */ }
      }

      const observedUrl = await readUrl()
      const after = await browser.capture(undefined, { signal: options.signal })
      if (!after) {
        if (!(await restoreCheckpoint())) {
          throw new SnapshotTargetUnavailableError(`Sidebar candidate ${attempts} left the browser in an unknown state; stopped before trying another control.`)
        }
        continue
      }

      if (result.ok || completedDespiteTimeout) {
        const nextDom = await inspectVisibleDomTargets(
          browser,
          expectedNext.target,
          options.signal,
          isSidebarNavigationStep(nextStep.action),
        )
        const afterWithDom = { ...after, elements: [...after.elements, ...nextDom] }
        const expectedTarget = findActionTarget(afterWithDom, expectedNext.target, expectedNext.kind)
        if (expectedTarget) {
          snapshot = afterWithDom
          currentUrl = observedUrl
          evidence.push({
            kind: 'snapshot',
            detail: `Step ${stepIndex + 1} candidate ${attempts} was confirmed because the next manual step target "${expectedNext.target}" appeared in the resulting screen.`,
            source: browser.provenance ?? navigation.source,
          })
          return { target: candidate, result, snapshot: afterWithDom, url: observedUrl, attempt: attempts }
        }
      }

      const noStateChange = normalizeUrl(observedUrl) === normalizeUrl(checkpointUrl) &&
        browserSnapshotSignature(after) === checkpointSignature
      if (noStateChange) continue
      if (!(await restoreCheckpoint())) {
        throw new SnapshotTargetUnavailableError(`Sidebar candidate ${attempts} did not reveal '${expectedNext.target}', and TestPilot could not verify that the original screen was restored. Stopped before trying another control.`)
      }
    }
    return undefined
  }

  async function candidatesForStep(
    observed: NonNullable<typeof snapshot>,
    stepOrder: number,
    stepAction: string,
    pageUrl: string,
    elements = observed.elements.filter((item) => item.actionable !== false).slice(0, 20),
  ): Promise<VerifiedLocator[]> {
    if (!(browser.capabilities?.canGenerateLocator ?? false)) return []
    const candidates: VerifiedLocator[] = []
    for (const element of elements) {
      if (options.signal?.aborted) throw new Error('Browser locator discovery was cancelled.')
      if (element.locatorExpression) {
        candidates.push({
          ref: element.ref,
          role: element.role,
          name: element.name,
          expression: element.locatorExpression,
          backend: browser.provenance?.backendLabel ?? 'browser DOM inspection',
          observedAt: observed.capturedAt,
          stepOrder,
          pageUrl,
        })
        continue
      }
      const generated = await browser.generateLocator(element.ref, { signal: options.signal })
      const expression = generated.output?.trim()
      if (!generated.ok || !expression || !/^(?:(?:this\.)?page\.)?(?:frameLocator|getByRole|getByLabel|getByText|getByPlaceholder|getByTestId|locator)\(/.test(expression)) continue
      element.locatorExpression = expression
      candidates.push({
        ref: element.ref,
        role: element.role,
        name: element.name,
        expression,
        backend: generated.provenance.backendLabel,
        observedAt: observed.capturedAt,
        stepOrder,
        pageUrl,
      })
    }
    return candidates
  }
}

/**
 * Inspect visible interactive nodes when an accessibility snapshot has only generic
 * names. The returned target selectors and locator expressions are derived from the
 * current DOM's observed role and visible/accessibility name, never from model guesses.
 */
async function inspectVisibleDomTargets(
  browser: BrowserSession,
  requestedTarget: string,
  signal?: AbortSignal,
  includeSidebarCandidates = false,
): Promise<BrowserElementRef[]> {
  // Playwright CLI can inspect cross-origin frames through Playwright's Frame API.
  // The old page.evaluate path below is limited to the main document and would miss
  // the common SAP/Fiori case where the shell is visible but the active form is framed.
  const frameInspection = await browser.runCode(`async page => {
    const selector = 'input,textarea,select,[contenteditable="true"],a,button,[role="link"],[role="button"],[role="searchbox"],[role="textbox"],[role="combobox"],[role="menuitem"],[role="treeitem"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[tabindex],.sapMLnk,.sapMBtn,.sapTntNavLIItem,.sapMITBFilter,.sapMSFI';
    const results = [];
    const frames = page.frames();
    for (const frame of frames.slice(1, 41)) {
      const frameSelectors = [];
      let child = frame;
      let safePath = true;
      while (child.parentFrame()) {
        const parent = child.parentFrame();
        let frameElement;
        try { frameElement = await child.frameElement(); } catch { safePath = false; break; }
        if (!parent || !frameElement) { safePath = false; break; }
        const identity = await frameElement.evaluate(el => {
          const doc = el.ownerDocument;
          const all = Array.from(doc.querySelectorAll('iframe'));
          const unique = (attribute, value) => Boolean(value) && all.filter(item => item.getAttribute(attribute) === value).length === 1;
          return {
            id: el.id || '', name: el.getAttribute('name') || '', title: el.getAttribute('title') || '',
            index: all.indexOf(el),
            idUnique: unique('id', el.id), nameUnique: unique('name', el.getAttribute('name')),
            titleUnique: unique('title', el.getAttribute('title'))
          };
        });
        if (identity.id && identity.idUnique) frameSelectors.unshift({ selector: 'iframe[id=' + JSON.stringify(identity.id) + ']' });
        else if (identity.name && identity.nameUnique) frameSelectors.unshift({ selector: 'iframe[name=' + JSON.stringify(identity.name) + ']' });
        else if (identity.title && identity.titleUnique) frameSelectors.unshift({ selector: 'iframe[title=' + JSON.stringify(identity.title) + ']' });
        else if (identity.index >= 0) frameSelectors.unshift({ selector: 'iframe', ordinal: identity.index });
        else { safePath = false; break; }
        child = parent;
      }
      if (!safePath || frameSelectors.length === 0) continue;
      const rows = await frame.locator('body').evaluate((body, selector) => {
        const roots = [body.ownerDocument];
        for (let i = 0; i < roots.length && i < 40; i++) {
          for (const node of roots[i].querySelectorAll('*')) if (node.shadowRoot) roots.push(node.shadowRoot);
        }
        const nodes = roots.flatMap(root => Array.from(root.querySelectorAll(selector)));
        const idCounts = new Map();
        for (const root of roots) for (const node of root.querySelectorAll('[id]')) idCounts.set(node.id, (idCounts.get(node.id) || 0) + 1);
        const helpIdCounts = new Map();
        for (const root of roots) for (const node of root.querySelectorAll('[data-help-id]')) { const value = node.getAttribute('data-help-id'); if (value) helpIdCounts.set(value, (helpIdCounts.get(value) || 0) + 1); }
        const seen = new Set();
        return nodes.filter(el => {
          if (seen.has(el)) return false;
          seen.add(el);
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && el.getAttribute('aria-hidden') !== 'true';
        }).map(el => {
          const tag = el.tagName.toLowerCase();
          const explicitRole = el.getAttribute('role');
          const classes = typeof el.className === 'string' ? el.className : '';
          const inputType = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
          const role = explicitRole || (tag === 'a' || /sapMLnk|sapTntNavLIItem/.test(classes) ? 'link' : tag === 'button' || /sapMBtn/.test(classes) ? 'button' : tag === 'select' ? 'combobox' : tag === 'textarea' || tag === 'input' ? (inputType === 'search' || /sapMSFI/.test(classes) ? 'searchbox' : 'textbox') : el.isContentEditable ? 'textbox' : 'generic');
          const core = window.sap && window.sap.ui && window.sap.ui.getCore ? window.sap.ui.getCore() : undefined;
          const control = core && el.id ? core.byId(el.id) : undefined;
          const controlType = control && control.getMetadata && control.getMetadata().getName ? control.getMetadata().getName() : '';
          let icon = ''; try { icon = control && typeof control.getIcon === 'function' ? control.getIcon() || '' : ''; } catch {}
          const searchButton = role === 'button' && /search/i.test(icon) && Boolean(el.id && idCounts.get(el.id) === 1);
          const labels = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean).map(id => {
            const root = el.getRootNode(); const label = root.getElementById ? root.getElementById(id) : el.ownerDocument.getElementById(id);
            return label ? (label.innerText || label.textContent || '') : '';
          }).join(' ');
          const associated = el.labels ? Array.from(el.labels).map(label => label.innerText || label.textContent || '').join(' ') : '';
          const ui5Name = ['getAccessibleName','getAriaLabel','getPlaceholder','getTooltip','getTitle','getText'].map(method => {
            try { return control && typeof control[method] === 'function' ? control[method]() : ''; } catch { return ''; }
          }).find(value => typeof value === 'string' && value.trim()) || '';
          const name = (el.getAttribute('aria-label') || labels || el.getAttribute('placeholder') || associated || el.getAttribute('title') || ui5Name || (searchButton ? 'Search' : '') || el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
          const nav = el.closest('nav,[role="navigation"],[role="tree"],aside,.sapTntSideNavigation,.sapTntNavLIGroup,.sapTntNavLIItem,[class*="SideNavigation"],[class*="sideNav"]');
          const id = el.id || '';
          const helpId = el.getAttribute('data-help-id') || '';
          const context = [el.parentElement && (el.parentElement.innerText || el.parentElement.textContent || ''), controlType].filter(Boolean).join(' | ').replace(/\\s+/g, ' ').trim().slice(0, 180);
          return { role, name, id, uniqueId: Boolean(id && idCounts.get(id) === 1), helpId, uniqueHelpId: Boolean(helpId && helpIdCounts.get(helpId) === 1), searchButton, context, navigation: Boolean(nav) };
        });
      }, selector);
      const searchboxes = rows.filter(row => row.role === 'searchbox').length;
      for (const row of rows) {
        if (!row.name && !(row.role === 'searchbox' && searchboxes === 1) && !row.uniqueHelpId) continue;
        results.push({ ...row, frameSelectors, uniqueSearchbox: row.role === 'searchbox' && searchboxes === 1 });
      }
    }
    return JSON.stringify(results.slice(0, 240));
  }`, { signal, timeoutMs: 12_000 })
  if (frameInspection.ok && frameInspection.output) {
    const rows = parseEvaluatedFrameDomRows(frameInspection.output)
    const frameTargets = buildFrameDomTargets(rows, requestedTarget, includeSidebarCandidates)
    if (frameTargets.length > 0) return frameTargets
  }

  const inspected = await browser.execute(
    (tool, callOptions) => tool.eval(`() => {
      const selector = 'input,textarea,select,[contenteditable="true"],a,button,[role="link"],[role="button"],[role="searchbox"],[role="textbox"],[role="combobox"],[role="menuitem"],[role="treeitem"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[tabindex],.sapMLnk,.sapMBtn,.sapTntNavLIItem,.sapMITBFilter,.sapMSFI';
      const allowUnnamedSearch = ${isSearchTarget(requestedTarget)};
      const roots = [document];
      for (let index = 0; index < roots.length && index < 40; index++) {
        for (const node of roots[index].querySelectorAll('*')) {
          if (node.shadowRoot) roots.push(node.shadowRoot);
        }
      }
      const idCounts = new Map();
      for (const root of roots) {
        for (const node of root.querySelectorAll('[id]')) idCounts.set(node.id, (idCounts.get(node.id) || 0) + 1);
      }
      const seen = new Set();
      return roots.flatMap((root) => Array.from(root.querySelectorAll(selector))).filter((el) => {
        if (seen.has(el)) return false;
        seen.add(el);
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && el.getAttribute('aria-hidden') !== 'true';
      }).map((el) => {
        const tag = el.tagName.toLowerCase();
        const explicitRole = el.getAttribute('role');
        const classes = typeof el.className === 'string' ? el.className : '';
        const inputType = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
        const role = explicitRole || (tag === 'a' || /sapMLnk|sapTntNavLIItem/.test(classes) ? 'link' : tag === 'button' || /sapMBtn/.test(classes) ? 'button' : tag === 'select' ? 'combobox' : tag === 'textarea' || tag === 'input' ? (inputType === 'search' || /sapMSFI/.test(classes) ? 'searchbox' : 'textbox') : el.isContentEditable ? 'textbox' : 'generic');
        const core = window.sap && window.sap.ui && window.sap.ui.getCore ? window.sap.ui.getCore() : undefined;
        const control = core && el.id ? core.byId(el.id) : undefined;
        const controlType = control && control.getMetadata && control.getMetadata().getName ? control.getMetadata().getName() : '';
        let icon = ''; try { icon = control && typeof control.getIcon === 'function' ? control.getIcon() || '' : ''; } catch {}
        const searchButton = role === 'button' && /search/i.test(icon) && Boolean(el.id && idCounts.get(el.id) === 1);
        const ui5Labels = ['getText', 'getTitle', 'getTooltip', 'getAccessibleName', 'getAriaLabel', 'getHeaderText', 'getLabel', 'getPlaceholder'].map((method) => {
          try { return control && typeof control[method] === 'function' ? control[method]() : ''; } catch { return ''; }
        }).filter((value) => typeof value === 'string' && value.trim());
        const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean).map((id) => {
          const root = el.getRootNode();
          const label = root.getElementById ? root.getElementById(id) : el.ownerDocument.getElementById(id);
          return label ? (label.innerText || label.textContent || '') : '';
        }).join(' ').trim();
        const associatedLabels = el.labels ? Array.from(el.labels).map((label) => label.innerText || label.textContent || '').join(' ') : '';
        const name = (el.getAttribute('aria-label') || labelledBy || el.getAttribute('placeholder') || associatedLabels || el.getAttribute('title') || ui5Labels[0] || (searchButton ? 'Search' : '') || el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        const nav = el.closest('nav,[role="navigation"],[role="tree"],aside,.sapTntSideNavigation,.sapTntNavLIGroup,.sapTntNavLIItem,[class*="SideNavigation"],[class*="sideNav"]');
        const parentTexts = [el.parentElement, el.parentElement && el.parentElement.parentElement].filter(Boolean).map((parent) => (parent.innerText || parent.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean);
        const context = [...new Set([parentTexts[0], parentTexts[1], controlType].filter(Boolean))].join(' | ').slice(0, 180);
        return { role, name, id: el.id || undefined, uniqueId: Boolean(el.id && idCounts.get(el.id) === 1), searchButton, context, navigation: Boolean(nav) };
      }).filter((item) => (item.name && (item.name.length > 1 || item.navigation)) || (allowUnnamedSearch && item.role === 'searchbox')).slice(0, 160);
    }`, undefined, callOptions),
    { signal },
  )
  if (!inspected.ok || !inspected.output) return []

  const rows = parseEvaluatedDomRows(inspected.output)
  const wanted = normalizeWords(requestedTarget)
  const matching = rows
    .map((row) => ({
      ...row,
      score: isSearchTarget(requestedTarget) && row.role === 'searchbox' && !row.name ? 0.9 : Math.max(
        textMatchScore(normalizeWords(row.name), wanted),
        textMatchScore(normalizeWords(row.context ?? ''), wanted) * 0.85,
      ),
    }))
    .filter((row) => row.score >= 0.35 || (includeSidebarCandidates && row.navigation && row.id && row.uniqueId) || (isSearchTarget(requestedTarget) && row.role === 'searchbox'))
    .sort((a, b) => b.score - a.score || Number(b.navigation) - Number(a.navigation))
    .slice(0, includeSidebarCandidates ? 24 : 20)

  const counts = new Map<string, number>()
  for (const row of matching) {
    const key = `${row.role ?? ''}\u0000${row.name}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const searchboxCount = matching.filter((row) => row.role === 'searchbox').length

  return matching.flatMap((row) => {
    const duplicateName = (counts.get(`${row.role ?? ''}\u0000${row.name}`) ?? 0) !== 1
    // Use the observed element id to distinguish repeated Fiori controls. Without
    // a unique id, identical role/name matches remain ambiguous and are excluded.
    if (duplicateName && !row.uniqueId) return []
    const unnamedUniqueSearchbox = isSearchTarget(requestedTarget) && row.role === 'searchbox' && !row.name && searchboxCount === 1
    const useObservedId = duplicateName || row.searchButton ||
      (isSearchTarget(requestedTarget) && row.role === 'searchbox' && searchboxCount > 1 && row.id && row.uniqueId) ||
      (includeSidebarCandidates && row.navigation && row.id && row.uniqueId && row.score < 0.35)
    const css = row.id ? `[id=${JSON.stringify(row.id)}]` : undefined
    const expression = useObservedId && css
      ? `locator(${JSON.stringify(css)})`
      : unnamedUniqueSearchbox
      ? `getByRole("searchbox")`
      : row.role && row.role !== 'generic'
      ? `getByRole(${JSON.stringify(row.role)}, { name: ${JSON.stringify(row.name)}, exact: true })`
      : `getByText(${JSON.stringify(row.name)}, { exact: true })`
    const selector = useObservedId && css
      ? `css=${css}`
      : unnamedUniqueSearchbox
      ? 'role=searchbox'
      : row.role && row.role !== 'generic'
      ? `role=${row.role}[name=${JSON.stringify(row.name)}]`
      : `text=${JSON.stringify(row.name)}`
    return [{ ref: selector, role: row.role, name: row.name, actionable: true, locatorExpression: expression, context: row.context, navigation: row.navigation }]
  })
}

function parseEvaluatedDomRows(output: string): Array<{ role?: string; name: string; id?: string; uniqueId?: boolean; searchButton?: boolean; context?: string; navigation?: boolean }> {
  const start = output.indexOf('[')
  const end = output.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const value: unknown = JSON.parse(output.slice(start, end + 1))
    if (!Array.isArray(value)) return []
    return value.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const row = item as { role?: unknown; name?: unknown; id?: unknown; uniqueId?: unknown; searchButton?: unknown; context?: unknown; navigation?: unknown }
      const role = typeof row.role === 'string' ? row.role : undefined
      const name = typeof row.name === 'string' ? row.name.trim() : ''
      if (!name && role !== 'searchbox') return []
      return [{
        role,
        name,
        id: typeof row.id === 'string' ? row.id : undefined,
        uniqueId: row.uniqueId === true,
        searchButton: row.searchButton === true,
        context: typeof row.context === 'string' ? row.context : undefined,
        navigation: row.navigation === true,
      }]
    })
  } catch {
    return []
  }
}

interface FrameDomRow {
  role?: string
  name: string
  id?: string
  uniqueId?: boolean
  uniqueSearchbox?: boolean
  searchButton?: boolean
  helpId?: string
  uniqueHelpId?: boolean
  context?: string
  navigation?: boolean
  frameSelectors: Array<{ selector: string; ordinal?: number }>
}

function parseEvaluatedFrameDomRows(output: string): FrameDomRow[] {
  const start = output.indexOf('[')
  const end = output.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const value: unknown = JSON.parse(output.slice(start, end + 1))
    if (!Array.isArray(value)) return []
    return value.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const row = item as Record<string, unknown>
      if (!Array.isArray(row.frameSelectors)) return []
      const frameSelectors = row.frameSelectors.flatMap((segment) => {
        if (!segment || typeof segment !== 'object') return []
        const value = segment as { selector?: unknown; ordinal?: unknown }
        return typeof value.selector === 'string'
          ? [{ selector: value.selector, ...(typeof value.ordinal === 'number' ? { ordinal: value.ordinal } : {}) }]
          : []
      })
      if (frameSelectors.length === 0) return []
      return [{
        role: typeof row.role === 'string' ? row.role : undefined,
        name: typeof row.name === 'string' ? row.name.trim() : '',
        id: typeof row.id === 'string' ? row.id : undefined,
        uniqueId: row.uniqueId === true,
        uniqueSearchbox: row.uniqueSearchbox === true,
        searchButton: row.searchButton === true,
        helpId: typeof row.helpId === 'string' ? row.helpId : undefined,
        uniqueHelpId: row.uniqueHelpId === true,
        context: typeof row.context === 'string' ? row.context : undefined,
        navigation: row.navigation === true,
        frameSelectors,
      }]
    })
  } catch {
    return []
  }
}

function buildFrameDomTargets(
  rows: FrameDomRow[],
  requestedTarget: string,
  includeSidebarCandidates: boolean,
): BrowserElementRef[] {
  const wanted = normalizeWords(requestedTarget)
  const ranked = rows.map((row) => ({
    ...row,
    score: isSearchTarget(requestedTarget) && row.role === 'searchbox' && row.uniqueSearchbox
      ? 0.9
      : Math.max(
          textMatchScore(normalizeWords(row.name), wanted),
          textMatchScore(normalizeWords(row.context ?? ''), wanted) * 0.85,
        ),
  })).filter((row) =>
    row.score >= 0.35 || (isSearchTarget(requestedTarget) && row.role === 'searchbox' && row.uniqueSearchbox) ||
    (includeSidebarCandidates && row.navigation && row.id && row.uniqueId && row.frameSelectors.length > 0),
  ).sort((a, b) => b.score - a.score || Number(b.navigation) - Number(a.navigation)).slice(0, 20)

  const counts = new Map<string, number>()
  for (const row of ranked) {
    const key = `${row.frameSelectors.map((item) => `${item.selector}:${item.ordinal ?? ''}`).join('>')}\u0000${row.role ?? ''}\u0000${row.name}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return ranked.flatMap((row) => {
    const frameScope = row.frameSelectors.map((segment) => segment.ordinal === undefined
      ? `frameLocator(${JSON.stringify(segment.selector)})`
      : `frameLocator(${JSON.stringify(segment.selector)}).nth(${segment.ordinal})`,
    ).join('.')
    const duplicate = (counts.get(`${row.frameSelectors.map((item) => `${item.selector}:${item.ordinal ?? ''}`).join('>')}\u0000${row.role ?? ''}\u0000${row.name}`) ?? 0) > 1
    const useId = Boolean(row.id && row.uniqueId && (row.searchButton || duplicate || (isSearchTarget(requestedTarget) && row.role === 'searchbox' && !row.uniqueSearchbox)))
    if (duplicate && !useId) return []
    const leaf = row.helpId && row.uniqueHelpId
      ? `locator(${JSON.stringify(`[data-help-id=${JSON.stringify(row.helpId)}]`)})`
      : useId
      ? `locator(${JSON.stringify(`[id=${JSON.stringify(row.id)}]`)})`
      : row.role === 'searchbox' && !row.name && row.uniqueSearchbox
        ? `getByRole("searchbox")`
        : row.role && row.name
          ? `getByRole(${JSON.stringify(row.role)}, { name: ${JSON.stringify(row.name)}, exact: true })`
          : undefined
    if (!leaf) return []
    const expression = `${frameScope}.${leaf}`
    return [{
      ref: expression,
      role: row.role,
      name: row.name,
      actionable: true,
      locatorExpression: expression,
      context: row.context,
      navigation: row.navigation,
    }]
  })
}

function textMatchScore(candidate: string, wanted: string): number {
  if (!candidate || !wanted) return 0
  if (candidate === wanted) return 1
  if (candidate.includes(wanted) || wanted.includes(candidate)) return 0.9
  const wantedTokens = new Set(wanted.split(' ').filter(Boolean))
  const overlap = candidate.split(' ').filter((token) => wantedTokens.has(token)).length
  return overlap / Math.max(wantedTokens.size, candidate.split(' ').length, 1)
}

/**
 * The CLI can report a timeout after the click already happened, while it waits
 * for a slow SSO/navigation response. Treat that as a completed click and inspect
 * the resulting page; never click the submit control a second time.
 */
function isClickNavigationWaitTimeout(error: string | undefined): boolean {
  return Boolean(error &&
    /click action done/i.test(error) &&
    /waiting for scheduled navigations/i.test(error) &&
    /timeout/i.test(error))
}

function isMcpToolCallTimeout(error: string | undefined): boolean {
  return Boolean(error && /MCP request ["']tools\/call["'] timed out/i.test(error))
}

type ReplayAction =
  | { kind: 'click'; target: string; intent?: 'expand' | 'collapse' }
  | { kind: 'check' | 'uncheck'; target: string }
  | { kind: 'fill'; target: string; value?: string }

type SnapshotSelectionAction = ReplayAction['kind'] | 'assert-visible'

function parseSnapshotTargetSelection(text: string): { ref?: string; confidence?: number; reason?: string } {
  const normalized = text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '').trim()
  const start = normalized.indexOf('{')
  const end = normalized.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('The selected model returned an invalid snapshot element selection; expected a JSON object with a ref.')
  let parsed: unknown
  try {
    parsed = JSON.parse(normalized.slice(start, end + 1))
  } catch {
    throw new Error('The selected model returned invalid JSON for its snapshot element selection.')
  }
  if (!parsed || typeof parsed !== 'object' || !('ref' in parsed)) {
    throw new Error('The selected model returned no ref for its snapshot element selection.')
  }
  const ref = (parsed as { ref?: unknown }).ref
  const confidence = (parsed as { confidence?: unknown }).confidence
  const reason = (parsed as { reason?: unknown }).reason
  if (ref === null) return {
    confidence: typeof confidence === 'number' ? confidence : undefined,
    reason: typeof reason === 'string' ? reason : undefined,
  }
  if (typeof ref !== 'string' || !ref.trim()) {
    throw new Error('The selected model returned an invalid ref for its snapshot element selection.')
  }
  return {
    ref: ref.trim(),
    confidence: typeof confidence === 'number' ? confidence : undefined,
    reason: typeof reason === 'string' ? reason : undefined,
  }
}

function isLocatorAction(action: string): boolean {
  return /^\s*(?:\d+[.)]\s*)?(?:click|tap|enter|type|fill|input|select|choose|check|uncheck|hover)\b/i.test(action)
}

function isManualWaitStep(action: string): boolean {
  return /^\s*(?:\d+[.)]\s*)?wait\s+(?:until\s+|for\s+)?(?:the\s+)?/i.test(action)
}

function isMfaChallenge(snapshot: BrowserSnapshot): boolean {
  const observedText = [snapshot.raw, ...snapshot.elements.map((element) => element.name ?? '')].join(' ')
  return /ping\s*id|ping identity|select\s+(?:the\s+)?number displayed|approve (?:the )?sign[ -]?in|multi[ -]?factor|verification (?:request|prompt|code).*mobile app/i.test(observedText)
}

function manualWaitTarget(action: string): string | undefined {
  return action
    .replace(/^\s*(?:\d+[.)]\s*)?wait\s+(?:until\s+|for\s+)?(?:the\s+)?/i, '')
    .replace(/\s+(?:is|becomes?)\s+(?:visible|shown|displayed|ready).*$/i, '')
    .replace(/[.!?]+$/, '')
    .trim() || undefined
}

function isLocatorAssertionStep(action: string): boolean {
  return /^\s*(?:\d+[.)]\s*)?(?:validate|verify|assert|expect|check)\b/i.test(action)
}

/** Quoted labels and expected values are the only text anchors used to search assertion snapshots. */
function assertionTextTerms(action: string): string[] {
  const quoted = [...action.matchAll(/["']([^"']{2,})["']/g)]
    .map((match) => match[1]!.trim())
    .filter(Boolean)
  if (quoted.length > 0) return quoted

  const visibleText = /^(?:validate|verify|assert|expect|check)\s+(?:that\s+)?(.+?)\s+(?:text\s+)?(?:is|should\s+be)\s+(?:visible|displayed|shown)\.?$/i.exec(action.trim())
  const term = visibleText?.[1]
    ?.replace(/^["'`]|["'`.,]$/g, '')
    .replace(/\b(?:the|a|an)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return term ? [term] : []
}

function extractStepUrl(action: string): string | undefined {
  return action.match(/https?:\/\/[^\s<>"')\]]+/i)?.[0]?.replace(/[.,;]+$/, '')
}

function normalizeUrl(url: string): string {
  try { return new URL(url).toString().replace(/\/$/, '') } catch { return url.trim().replace(/\/$/, '') }
}

function parseReplayAction(action: string): ReplayAction | undefined {
  const step = action.replace(/^\s*\d+[.)]\s*/, '').trim()
  const toggle = /^(check|uncheck)\s+(?:the\s+)?(.+)$/i.exec(step)
  if (toggle) {
    return {
      kind: toggle[1]!.toLowerCase() as 'check' | 'uncheck',
      target: cleanActionTarget(toggle[2] ?? ''),
    }
  }
  const expand = /^(?:expand|collapse)\s+(?:the\s+)?(.+)$/i.exec(step)
  if (expand) {
    const intent = step.toLowerCase().startsWith('collapse') ? 'collapse' : 'expand'
    const target = cleanActionTarget(expand[1] ?? '').replace(/^(?:(?:left|right)\s+)?(?:side\s*bar|navigation|nav(?:igation)?)(?:\s+(?:side\s*)?(?:bar|menu))?$/i, 'sidebar navigation menu')
    return target ? { kind: 'click', target, intent } : undefined
  }
  const fill = /^(?:enter|type|fill|input)\s+(?:the\s+)?(.+?)(?:\s+(?:as|with|value(?:\s+of)?|=)\s+)(.+)$/i.exec(step)
  if (fill) {
    return { kind: 'fill', target: cleanActionTarget(fill[1] ?? ''), value: stripWrappingQuotes(fill[2] ?? '') }
  }
  // Accept both field-first (`Enter username as ...`) and value-first
  // (`Enter ... into username field`) manual test case conventions.
  const valueFirstFill = /^(?:enter|fill|type|input)\s+(.+?)\s+(?:in|into)\s+(?:the\s+)?(.+)$/i.exec(step)
  if (valueFirstFill) {
    return {
      kind: 'fill',
      value: stripWrappingQuotes(valueFirstFill[1] ?? ''),
      target: cleanActionTarget(valueFirstFill[2] ?? ''),
    }
  }
  const click = /^(?:click|tap|open)\s+(?:on\s+)?(.+)$/i.exec(step)
  if (click) return { kind: 'click', target: cleanActionTarget(click[1] ?? '') }
  return undefined
}

function cleanActionTarget(value: string): string {
  return value
    .replace(/\s+(?:in|from|on)\s+(?:the\s+)?(?:left\s+|right\s+)?(?:side\s*bar|navigation(?:\s+bar)?|nav(?:\s+bar)?|menu|tab|link)\b.*$/i, '')
    .replace(/^[\s"'`]+|[\s"'`.,]+$/g, '')
    .replace(/\s+(?:button|link|tab|menu\s*item|sub\s*menu|checkbox|radio\s*button|field|textbox|input|icon)$/i, '')
    .replace(/^the\s+/i, '')
    .trim()
}

function stripWrappingQuotes(value: string): string {
  return value.trim().replace(/^["'`]|["'`]$/g, '')
}

function findActionTarget(
  snapshot: NonNullable<Awaited<ReturnType<BrowserSession['capture']>>>,
  target: string,
  kind: ReplayAction['kind'],
  allowUnnamedSearch = false,
) {
  const ranked = findActionTargets(snapshot, target, kind, false, allowUnnamedSearch)
  if (!ranked[0] || ranked[0].score < 0.75) return undefined
  if (ranked[1] && ranked[0].score - ranked[1].score < 0.05) return undefined
  return ranked[0].element
}

function findActionTargets(
  snapshot: NonNullable<Awaited<ReturnType<BrowserSession['capture']>>>,
  target: string,
  kind: ReplayAction['kind'],
  includeTreeItems = false,
  allowUnnamedSearch = false,
) {
  const wanted = normalizeWords(target)
  if (!wanted) return []
  const wantedTokens = new Set(wanted.split(' '))
  const ranked = snapshot.elements
    .filter((element) => element.actionable !== false &&
      (element.name || includeTreeItems || (allowUnnamedSearch && isSearchTarget(target) && element.role === 'searchbox')))
    .filter((element) => kind !== 'fill' || /^(?:textbox|searchbox|combobox|spinbutton)$/i.test(element.role ?? ''))
    .filter((element) => !['check', 'uncheck'].includes(kind) || /^(?:checkbox|radio)$/i.test(element.role ?? ''))
    .filter((element) => kind !== 'click' || /^(?:button|link|menuitem|tab|checkbox|radio|option|switch|treeitem|listitem|text|generic)$/i.test(element.role ?? ''))
    .map((element) => {
      const name = normalizeWords(element.name ?? '')
      const tokens = name.split(' ').filter(Boolean)
      const overlap = tokens.filter((token) => wantedTokens.has(token)).length
      const score = allowUnnamedSearch && isSearchTarget(target) && element.role === 'searchbox' && !name ? 0.9
        : name === wanted ? 1 : name.includes(wanted) || wanted.includes(name)
        ? 0.9
        : overlap / Math.max(wantedTokens.size, tokens.length, 1)
      return { element, score }
    })
    .sort((a, b) => b.score - a.score)
  // For menu expand/collapse, retain a few unnamed button/tree controls too:
  // snapshots can expose the real toggle by role/ref even when its accessible name is absent.
  if (includeTreeItems) {
    return [
      ...ranked.filter(({ element }) => Boolean(element.name)).slice(0, 60),
      ...ranked.filter(({ element }) => !element.name).slice(0, 20),
    ]
  }
  return ranked.slice(0, 80)
}

function rankSnapshotElements(elements: BrowserElementRef[], terms: string[]): BrowserElementRef[] {
  const wanted = terms.map(normalizeWords).filter(Boolean).join(' ')
  const wantedTokens = new Set(wanted.split(' ').filter(Boolean))
  return elements
    .filter((element) => element.name || element.context)
    .map((element) => {
      const name = normalizeWords(element.name ?? '')
      const context = normalizeWords(element.context ?? '')
      const tokens = name.split(' ').filter(Boolean)
      const overlap = tokens.filter((token) => wantedTokens.has(token)).length
      const nameScore = name === wanted ? 1 : name.includes(wanted) || wanted.includes(name)
        ? 0.9
        : overlap / Math.max(wantedTokens.size, tokens.length, 1)
      const contextTokens = context.split(' ').filter(Boolean)
      const contextOverlap = contextTokens.filter((token) => wantedTokens.has(token)).length
      const contextScore = context === wanted ? 0.95 : context.includes(wanted)
        ? 0.9
        : contextOverlap / Math.max(wantedTokens.size, contextTokens.length, 1)
      const score = Math.max(nameScore, contextScore * 0.85)
      return { element, score }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 80)
    .map(({ element }) => element)
}

function normalizeWords(value: string): string {
  return value.toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:please|your|the|a|an)\b/g, ' ')
    .replace(/\blisting\b/g, 'list')
    .trim()
    .replace(/\s+/g, ' ')
}

function isSearchTarget(value: string): boolean {
  return /\bsearch\b/i.test(value)
}

function isSidebarNavigationStep(action: string): boolean {
  return /\b(?:sidebar|side\s*bar|navigation|nav(?:igation)?\s+menu)\b/i.test(action)
}

function isSidebarNavigationRetryEligible(
  stepText: string,
  action: ReplayAction,
  nextStep: TestCase['steps'][number] | undefined,
): boolean {
  return action.kind === 'click' &&
    isSidebarNavigationStep(stepText) &&
    Boolean(nextStep && !extractStepUrl(nextStep.action) && parseReplayAction(nextStep.action))
}

function browserSnapshotSignature(snapshot: BrowserSnapshot): string {
  const raw = snapshot.raw
    .replace(/\[ref=[^\]]+\]/g, '')
    .replace(/\["e[A-Za-z0-9_-]+"\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const elements = snapshot.elements
    .map((element) => `${element.role ?? ''}:${element.name ?? ''}:${element.context ?? ''}`)
    .sort()
    .join('|')
  return `${raw}|${elements}`
}

/** Thrown when the manual input cannot be turned into a test case. */
export class InputValidationError extends Error {
  readonly normalization: TestCaseNormalizationResult

  constructor(normalization: TestCaseNormalizationResult) {
    const detail = normalization.issues
      .map((i) => `[${i.severity}] ${i.field}: ${i.message}${i.suggestion ? ` — ${i.suggestion}` : ''}`)
      .join('\n')
    super(`Test case input could not be validated:\n${detail}`)
    this.name = 'InputValidationError'
    this.normalization = normalization
  }
}

/** Split explicitly titled `Test:` sections while leaving the regular single-case adapter intact. */
function splitTitledTestCases(raw: string): string[] {
  const headings = [...raw.matchAll(/^\s*Test\s*:\s*.+$/gim)]
  if (headings.length < 2) return [raw]
  const cases: string[] = []
  for (let index = 0; index < headings.length; index++) {
    const start = headings[index]!.index ?? 0
    const end = headings[index + 1]?.index ?? raw.length
    const block = raw.slice(start, end).trim()
    if (block) cases.push(block)
  }
  return cases.length > 1 ? cases : [raw]
}

/**
 * Map each manual step to a framework symbol using the deterministic reuse
 * analysis. A step with no candidate above threshold is marked unresolved
 * rather than guessed at.
 */
export function buildPlan(
  testCase: TestCase,
  reuse: ReuseReport | undefined,
  analysis: FrameworkAnalysisResult,
): PlanEntry[] {
  const threshold = 0.45

  return testCase.steps.map((step) => {
    const stepPlan = reuse?.stepReuse.find((s) => s.stepOrder === step.order)
    const bestMethod = stepPlan?.candidateMethods.find((c) => c.confidence >= threshold)
    const bestLocator = stepPlan?.candidateLocators.find((c) => c.confidence >= threshold * 0.8)

    if (bestMethod) {
      const isExisting = bestMethod.confidence >= threshold
      const namespaceMatch = /^[a-z]+\.[a-zA-Z]+$/.test(bestMethod.qualifiedName)
      const resolution = namespaceMatch
        ? (bestMethod.qualifiedName.endsWith('.click') || bestMethod.qualifiedName.endsWith('.goTo')
            ? 'existing-action'
            : 'existing-method')
        : 'existing-method'

      return {
        stepOrder: step.order,
        stepAction: step.action,
        stepExpected: step.expectedResult,
        resolution,
        targetFile: bestMethod.file,
        targetSymbol: bestMethod.qualifiedName,
        facadePath: namespaceMatch ? bestMethod.qualifiedName : undefined,
        evidence: [
          `Method "${bestMethod.qualifiedName}" at ${bestMethod.file}:${bestMethod.line}`,
          bestMethod.matchReason,
          `Score ${bestMethod.confidence} (threshold ${threshold}).`,
        ],
      }
    }

    if (bestLocator) {
      return {
        stepOrder: step.order,
        stepAction: step.action,
        stepExpected: step.expectedResult,
        resolution: 'existing-locator',
        targetFile: bestLocator.file,
        targetSymbol: `${bestLocator.ownerClass}.${bestLocator.name}`,
        evidence: [
          `Locator "${bestLocator.ownerClass}.${bestLocator.name}" at ${bestLocator.file}:${bestLocator.line}`,
          bestLocator.matchReason,
          `Score ${bestLocator.confidence}.`,
        ],
      }
    }

    // No plausible existing code: the step needs either an assertion or a new method.
    const looksLikeAssertion =
      /^(assert|verify|check|expect|confirm)/i.test(step.action) ||
      Boolean(step.expectedResult && /^(assert|verify|check|expect|confirm)/i.test(step.expectedResult))

    const pageObject = stepPlan?.candidatePageObjects[0]

    return {
      stepOrder: step.order,
      stepAction: step.action,
      stepExpected: step.expectedResult,
      resolution: looksLikeAssertion ? 'assertion' : 'new-method',
      targetFile: pageObject ? analysis.facts.locators.find((l) => l.ownerClass === pageObject)?.file : undefined,
      targetSymbol: pageObject,
      evidence: pageObject
        ? [`Closest page object: "${pageObject}" — no action method scored above the threshold.`]
        : [
            'No indexed action method, locator, or page object matched this step above the reuse threshold.',
            `Framework indexes ${analysis.facts.actionMethods.length} action method(s); none matched the step vocabulary.`,
          ],
      unresolvedReason: looksLikeAssertion
        ? undefined
        : 'No existing framework method matched this step. Generate the needed page-object method and evidence-based locator from browser observations; do not omit the step.',
    }
  })
}

function renderReuseCoverage(plan: PlanEntry[]): string {
  return plan
    .map((p) => {
      const head = `- **Step ${p.stepOrder}**: ${p.stepAction}`
      const res = `  - Resolution: ${p.resolution}`
      const target = p.targetSymbol ? `  - Target: ${p.targetSymbol}` : ''
      const file = p.targetFile ? `  - File: ${p.targetFile}` : ''
      const unresolved = p.unresolvedReason ? `  - Unresolved: ${p.unresolvedReason}` : ''
      return [head, res, target, file, unresolved].filter(Boolean).join('\n')
    })
    .join('\n')
}

function renderDuplicateFindings(reuse: ReuseReport | undefined): string {
  if (!reuse || reuse.duplicates.length === 0) return 'No existing test overlaps with this test case.'
  return reuse.duplicates
    .map(
      (d) =>
        `- **${d.verdict}** (${d.similarity}): ${d.existingTest.title} at ${d.existingTest.file}:${d.existingTest.line}\n` +
        `  Evidence: ${d.evidence.join('; ')}\n  Recommendation: ${d.recommendation}`,
    )
    .join('\n')
}

function renderActionMethodSummary(
  methods: FrameworkAnalysisResult['facts']['actionMethods'],
  reuse?: ReuseReport,
): string {
  if (methods.length === 0) return 'The framework exposes no reusable action methods.'
  if (reuse?.stepReuse.length) {
    const relevant = new Map<string, { method: (typeof reuse.stepReuse)[number]['candidateMethods'][number]; steps: number[] }>()
    for (const step of reuse.stepReuse) {
      for (const method of step.candidateMethods.slice(0, 2)) {
        const current = relevant.get(method.qualifiedName)
        if (current) current.steps.push(step.stepOrder)
        else relevant.set(method.qualifiedName, { method, steps: [step.stepOrder] })
      }
    }
    if (relevant.size === 0) return 'No indexed action method scored as relevant to these manual steps.'
    return [...relevant.values()].slice(0, 32).map(({ method, steps }) =>
      `- ${method.qualifiedName} — ${method.signature} (${method.file}:${method.line}; related to step${steps.length > 1 ? 's' : ''} ${steps.join(',')}; relevance ${method.confidence.toFixed(2)})`,
    ).join('\n')
  }
  return methods.slice(0, 12).map((m) => {
    const ns = m.facadeNamespace ? `${m.facadeNamespace}.` : ''
    return `- ${ns}${m.name} — ${m.signature} (${m.file}:${m.line})`
  }).join('\n')
}

/** Retrieve only page objects ranked against this request's manual steps. */
function renderRelevantPageObjects(analysis: FrameworkAnalysisResult): string[] {
  const candidates = analysis.reuse?.stepReuse.flatMap((step) => step.candidatePageObjects.slice(0, 2)) ?? []
  const unique = [...new Set(candidates)]
  return unique.length > 0 ? unique.slice(0, 12) : analysis.facts.pageObjects.slice(0, 12)
}

/** Small per-step locator RAG context; never send an arbitrary repository-wide prefix. */
function renderRelevantLocatorExamples(analysis: FrameworkAnalysisResult): string[] {
  const byExpression = new Map<string, string>()
  for (const step of analysis.reuse?.stepReuse ?? []) {
    for (const locator of step.candidateLocators.slice(0, 2)) {
      byExpression.set(
        locator.expression,
        `Step ${step.stepOrder}: ${locator.ownerClass}.${locator.name} → ${locator.expression} (${locator.file}:${locator.line}; relevance ${locator.confidence.toFixed(2)})`,
      )
    }
  }
  if (byExpression.size > 0) return [...byExpression.values()].slice(0, 24)
  return analysis.facts.locators.slice(0, 12).map((locator) => `${locator.ownerClass}.${locator.name} → ${locator.expression}`)
}

/** Keep browser context to the most useful verified candidate per manual step. */
function selectRelevantBrowserCandidates(candidates: VerifiedLocator[]): VerifiedLocator[] {
  const selected = new Map<number, VerifiedLocator>()
  for (const candidate of candidates) {
    const order = candidate.stepOrder ?? Number.MAX_SAFE_INTEGER
    if (!selected.has(order)) selected.set(order, candidate)
  }
  return [...selected.values()].slice(0, 40)
}

export { summariseAnalysis, fingerprint, STAGE_SEQUENCE }

/**
 * Stage 5 (Act): ask the provider for the concrete file content.
 *
 * Only ever called after a human has approved the plan. The returned changes
 * are proposals — `applyChanges` writes them, and only them.
 */
/**
 * Conform the approved plan into framework-standard files.
 *
 * This is deliberately not a model call. The old implementation asked the
 * provider to emit file content as fenced blocks, which could not be made to
 * respect the framework's conventions — a model can forget the `@Step` decorator,
 * the `ConfigManager.getAppBaseUrl` shape, or the data loader path, and would
 * emit something that only compiles if someone happens to fix it later.
 *
 * Emission is generated from the plan and the framework index, so every file
 * is structurally conformant by construction. Steps that lack verified evidence
 * are reported instead of being filled in with a guessed selector.
 */
export function generateChanges(
  options: {
    task: TaskRecord
    analysis: FrameworkAnalysisResult
    plan: PlanEntry[]
    repositoryRoot: string
    /** AppName key for navigation. Omit to emit a TODO rather than invent one. */
    appName?: string
  },
): FileChange[] {
  const { facts } = options.analysis
  const existingTestPath = reusableTestPath(options.task, options.analysis)
  const stem = existingTestPath
    ? existingTestPath.replace(/\\/g, '/').replace(/^.*\//, '').replace(/\.spec\.ts$/, '')
    : (options.task.title || 'manualTestCase')
        .replace(/[^a-zA-Z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .slice(0, 5)
        .map((word, index) => index === 0
          ? word.charAt(0).toLowerCase() + word.slice(1)
          : word.charAt(0).toUpperCase() + word.slice(1))
        .join('') || 'manualTestCase'
  const build = buildEmissionOptions({
    plan: options.plan,
    testCase: options.task.testCase?.steps ?? [],
    reuseReport: options.task.reuseReport,
    locators: facts.locators,
    actionMethods: facts.actionMethods,
    existingTests: facts.tests,
    appName: options.appName,
    stem,
  })

  const files = emitFrameworkStandard(build.options)
  const workspace = new Workspace(options.repositoryRoot)
  const unconfirmed = buildEmissionUnconfirmed(build.options)

  return files.map((f) => {
    const resolved = workspace.tryResolve(f.path)
    return {
      path: resolved?.relative ?? f.path,
      kind: resolved && existsSync(join(workspace.rootPath, resolved.relative)) ? 'modify' : 'create',
      newContent: f.content.endsWith('\n') ? f.content : `${f.content}\n`,
      reason: `Conformed from the approved plan by ${f.layer} emission.`,
      evidence: [
        `Plan approved by the user before emission was requested.`,
        build.needsEvidence.length > 0
          ? `${build.needsEvidence.length} step(s) still need verified locator evidence: ${build.needsEvidence
              .map((s) => `#${s.stepOrder}`)
              .join(', ')}`
          : `All ${build.steps.length} emitted step(s) have verified locators.`,
        ...unconfirmed.map((verb) => `Action "${verb}" was not confirmed in the framework's facade.`),
      ],
    }
  })
}

/**
 * Action calls the emitter produced that the framework's facade does not confirm.
 *
 * Kept separate from `validateEmittedCalls` so the caller gets a flat list
 * suitable for an evidence string without re-deriving the step list.
 */
function buildEmissionUnconfirmed(options: EmissionOptions): string[] {
  const known = new Set(options.knownActions ?? [])
  const unconfirmed = new Set(options.unconfirmedActions ?? [])
  const verbs = options.steps.map((s) => s.methodSignature)
  return [...new Set(verbs.filter((v) => !known.has(v) || unconfirmed.has(v)))]
}

/**
 * The previous model-emit path, kept for environments that cannot run emission.
 *
 * Retained rather than deleted: a caller may legitimately want the model's
 * phrasing, and the evidence-gating logic above would not apply to it. Marking it
 * as the fallback makes the difference between the two paths explicit at the call site.
 */
export async function generateChangesFromProvider(
  options: {
    task: TaskRecord
    analysis: FrameworkAnalysisResult
    plan: PlanEntry[]
    repositoryRoot: string
    config?: Partial<ProviderConfig>
    vscodeLmBridge?: VscodeLmBridge
    signal?: AbortSignal
  },
): Promise<FileChange[]> {
  const config = buildConfig(options.config ?? {}, options.repositoryRoot)
  const provider = getProvider(config, { vscodeLmBridge: options.vscodeLmBridge })
  const info = await provider.check()

  if (!info.available) {
    throw new Error(
      `Model provider "${info.id}" is unavailable: ${info.unavailableReason ?? 'unknown reason'}`,
    )
  }

  const model = await provider.selectDefault()
  const { buildGenerationUserPrompt } = await import('@tcoe/provider-abstraction')
  const { facts, report } = options.analysis
  const testCaseTitle = options.task.title || 'Manual test case'
  const safeStem = testCaseTitle
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .map((word, index) => index === 0
      ? word.charAt(0).toLowerCase() + word.slice(1)
      : word.charAt(0).toUpperCase() + word.slice(1))
    .join('') || 'manualTestCase'
  const existingTestPath = reusableTestPath(options.task, options.analysis)
  const stem = existingTestPath
    ? existingTestPath.replace(/\\/g, '/').replace(/^.*\//, '').replace(/\.spec\.ts$/, '')
    : safeStem
  const scenarioStem = deriveScenarioStem(options.task)
  const pageName = scenarioStem.charAt(0).toUpperCase() + scenarioStem.slice(1)
  const targetPagePath = `pages/${pageName}/${scenarioStem}.page.ts`
  const targetLocatorPath = `pages/${pageName}/${scenarioStem}.locators.ts`
  const targetDataPath = `test-data/${scenarioStem}/${scenarioStem}.qa.json`
  const manualCases = options.task.testCases ?? (options.task.testCase ? [options.task.testCase] : [])
  const dataCases = manualCases.map((testCase) => ({
    caseKey: caseDataKey(testCase.title),
    title: testCase.title,
    values: extractManualTestData(testCase),
  }))
  // Always create the scenario data module for manual cases, including an empty
  // row when the case contains no non-secret values. This keeps generated specs
  // on the framework's DataLoader path instead of silently omitting the file.
  const manualTestData = manualCases.length > 0
    ? {
        moduleName: scenarioStem,
        cases: dataCases,
        sharedFlow: casesShareFlow(manualCases, dataCases),
        targetPath: targetDataPath,
        existingJson: readExistingJson(options.repositoryRoot, targetDataPath),
        dataTypesPath: 'src/utils/testData/dataTypes.ts',
      }
    : undefined
  const multiScreenFlow = requiresMultipleScreenPages(manualCases)
  const targetSpecPath = manualCases.length > 1
    ? `tests/${scenarioStem}.spec.ts`
    : existingTestPath ?? `tests/${stem}.spec.ts`
  const browserEvidence = [
    ...selectRelevantBrowserCandidates(options.task.browserLocatorCandidates ?? []).map((candidate) =>
      `Observed for step ${candidate.stepOrder ?? 'unspecified'} on ${candidate.pageUrl ?? 'an inspected screen'} via ${candidate.backend} at ${candidate.observedAt}: ref=${candidate.ref}, role=${candidate.role ?? 'unknown'}, name=${candidate.name ?? 'unnamed'}, locator=${candidate.expression}`),
    ...(options.plan.flatMap((entry) => entry.verifiedLocator
      ? [`Selected for step ${entry.stepOrder} (${entry.stepAction}): ${entry.verifiedLocator.expression} via ${entry.verifiedLocator.backend}, ref=${entry.verifiedLocator.ref}`]
      : [])),
  ].join('\n')
  const frameworkExamples = renderFrameworkExamples(options.analysis)
  const sharedPageSources = [targetPagePath, targetLocatorPath].flatMap((path) => {
    const absolute = join(options.repositoryRoot, path)
    return existsSync(absolute)
      ? [`EXISTING SHARED FILE ${path}\n\`\`\`typescript\n${readFileSync(absolute, 'utf-8').slice(0, 6000)}\n\`\`\``]
      : []
  })
  if (sharedPageSources.length > 0) {
    frameworkExamples.text += `\n\n## Existing scenario files to reuse\n\n${sharedPageSources.join('\n\n')}`
  }

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You emit file content only. Emit nothing but the files requested, each as a fenced block tagged with its path. ' +
        'The target framework conventions are mandatory. Follow the included real source examples and never substitute generic Playwright patterns for the framework architecture. Never use test.only or invent a fixture, action method, or helper API that was not discovered. Locator fields must be Playwright Locator objects, not strings containing locator code. Every locator must exactly match a Playwright CLI snapshot observation or an indexed framework locator; comments such as "adjust this selector" are not acceptable evidence. If a snapshot locator is scoped to an iframe, preserve the entire frameLocator/contentFrame chain in the paired locator class and page actions; do not strip the frame scope. ' +
        'Preserve the manual step order and execute each navigation exactly where it appears. If a step navigates to a URL and the next step clicks a link, navigate to that stated URL and then click the snapshot-observed link; do not navigate directly to the linked page before attempting the click. Name each test from its manual test title; do not read the title from test data unless that field is explicitly present. DataLoader.get(module) returns a typed JSON object whose named case properties contain values directly; do not expect title/values wrappers. Generate one explicit standalone test(...) block per manual case using its literal manual title and literal typed case property. Do not use loops, Object.keys/entries/values, test.each, or map/forEach to create tests.',
    },
    {
      role: 'user',
      content: buildGenerationUserPrompt({
        testCaseTitle: options.task.title,
        testCaseSteps: (options.task.testCases ?? (options.task.testCase ? [options.task.testCase] : []))
          .map((testCase) => `Test: ${testCase.title}\n${testCase.steps.map((step) => `${step.order}. ${step.action}${step.expectedResult ? ` — expected: ${step.expectedResult}` : ''}`).join('\n')}`)
          .join('\n\n'),
        manualTestCases: options.task.testCases,
        reuseCoverage: options.plan
          .map(
            (p) =>
              `- Step ${p.stepOrder}: ${p.stepAction}\n  resolution: ${p.resolution}` +
              `${p.targetSymbol ? `\n  target symbol: ${p.targetSymbol}` : ''}` +
              `${p.targetFile ? `\n  target file: ${p.targetFile}` : ''}`,
          )
          .join('\n'),
        duplicateFindings: 'See the selected plan.',
        conventions: report.conventions.confirmed.join('\n'),
        actionMethodsSummary: renderActionMethodSummary(facts.actionMethods, options.analysis.reuse),
        pageObjectNames: renderRelevantPageObjects(options.analysis),
        locatorExamples: renderRelevantLocatorExamples(options.analysis),
        fixtures: facts.fixtures.map((f) => f.name),
        testDataModules: facts.testDataModules.slice(0, 12),
        taskId: options.task.taskId,
        approvalMode: config.approvalMode,
        approvedPlan: renderReuseCoverage(options.plan),
        targetSpecPath,
        targetPagePath,
        targetLocatorPath,
        targetDataPath,
        manualTestData,
        browserEvidence,
        frameworkExamples: frameworkExamples.text,
      }) + renderScreenArchitectureRequirements(manualCases, targetPagePath, targetLocatorPath),
    },
  ]

  const modelId = options.config?.model ?? model?.id
  const recordGenerationCall = (modelUsed: string | undefined): void => {
    options.task.modelCalls.push({ provider: info.id, model: modelUsed, at: new Date().toISOString(), purpose: 'generate' })
  }
  const hasSpec = (changes: FileChange[]): boolean =>
    changes.some((change) =>
      /(^|\/)tests\/[^/]+\.spec\.tsx?$/.test(`/${change.path.replace(/\\/g, '/')}`) &&
      /\btest\s*\(/.test(change.newContent ?? ''),
    )
  const approvedLocatorExpressions = [
    ...facts.locators.map((locator) => locator.expression),
    ...(options.task.browserLocatorCandidates ?? []).map((candidate) => candidate.expression),
    ...options.plan.flatMap((entry) => entry.verifiedLocator ? [entry.verifiedLocator.expression] : []),
  ]
  const standardIssues = (changes: FileChange[]): string[] =>
    [
      ...findFrameworkStandardIssues(changes, frameworkExamples, facts.customFixtureUsed, approvedLocatorExpressions),
      ...findAssertionLocatorIssues(changes, manualCases, options.task.browserLocatorCandidates ?? []),
      ...findManualNavigationIssues(changes, manualCases),
      ...findManualStepCoverageIssues(changes, manualCases),
      ...findScreenPageArchitectureIssues(changes, manualCases, options.repositoryRoot),
    ]
  const normalizeGeneratedChanges = (changes: FileChange[]): FileChange[] => {
    const withObservedFrames = rewriteObservedFrameLocators(rewriteDirectPageActions(
      changes,
      facts.actionMethods,
    ), options.task.browserLocatorCandidates ?? [])
    return manualTestData ? rewriteHardcodedManualData(withObservedFrames, manualTestData) : withObservedFrames
  }

  let response = await provider.chat(messages, { purpose: 'generate', modelId, signal: options.signal })
  recordGenerationCall(response.modelId)
  let changes = normalizeGeneratedChanges(
    parseGeneratedFiles(response.text, options.repositoryRoot, { defaultSpecPath: targetSpecPath }),
  )
  const maxCorrections = 2
  const needsCorrection = (candidate: FileChange[]): boolean =>
    !hasSpec(candidate) || standardIssues(candidate).length > 0 ||
    (!!manualTestData && manualDataUsageIssues(candidate, manualTestData, options.repositoryRoot, targetPagePath, targetLocatorPath, frameworkExamples.dataLoaderImportPath, multiScreenFlow).length > 0)
  for (let correction = 0; correction < maxCorrections && needsCorrection(changes); correction++) {
    const issues = standardIssues(changes)
    const dataIssues = manualTestData ? manualDataUsageIssues(changes, manualTestData, options.repositoryRoot, targetPagePath, targetLocatorPath, frameworkExamples.dataLoaderImportPath, multiScreenFlow) : []
    const failedStepOrders = new Set(issues.flatMap((issue) => {
      const order = issue.match(/manual step\s+(\d+)/i)?.[1]
      return order ? [Number(order)] : []
    }))
    const exactStepLocators = (options.task.browserLocatorCandidates ?? [])
      .filter((candidate) => candidate.stepOrder !== undefined && failedStepOrders.has(candidate.stepOrder))
      .map((candidate) => `- Step ${candidate.stepOrder} on ${candidate.pageUrl ?? 'observed screen'}: ${candidate.expression}`)
    const locatorCorrectionGuidance = exactStepLocators.length > 0
      ? `Exact observed locator candidates for the rejected steps (copy the role and name exactly; do not change an observed button/link into an option):\n${[...new Set(exactStepLocators)].join('\n')}`
      : ''
    const correctionPrompt = [
      'Your previous response was rejected and no files have been written.',
      !hasSpec(changes) ? 'It did not contain a runnable TypeScript test spec with a test(...) declaration.' : '',
      ...(issues.length > 0 ? [`It violated these discovered framework standards:\n${issues.map((issue) => `- ${issue}`).join('\n')}`] : []),
      locatorCorrectionGuidance,
      ...(dataIssues.length > 0 ? [`It failed to use the extracted test data:\n${dataIssues.map((issue) => `- ${issue}`).join('\n')}`] : []),
      'Return the complete file set again. Implement every manual step in order; the generated code does not need to repeat the manual wording verbatim. Correct every listed standards violation and copy the architecture from the real source examples where needed. For new page behavior, create page-object/locator code using matching browser observations; never invent a selector that is absent from evidence. Every new locator expression must exactly match an expression in the Playwright CLI observations or an indexed framework locator. For data-driven text assertions, a locator-class method may accept the expected value and use getByText(expectedValue) only when a literal getByText candidate for that assertion is present in the matching snapshot evidence; pass the value from the data row. If evidence is insufficient, do not invent a locator or leave a guessed CSS selector with an adjustment comment; keep the specific step unresolved and explain which live snapshot is missing.',
        'Page methods must never call this.page.getByRole(...), this.page.frameLocator(...), this.page.locator(...), or this.page.goto(...). Put the observed locator in the paired locator class, then call the confirmed framework wrapper: await this.actions.fill(this.locators.FIELD, value), await this.actions.click(this.locators.FIELD), and await this.actions.browser.navigate(url). For an element observed inside an iframe, preserve its complete frame-scoped locator chain exactly (for example this.page.frameLocator(observedFrameSelector).getByRole(...)); never drop the frame scope or treat the control as belonging to the main page. Match the target framework examples and do not use raw Playwright interactions inside a page object.',
      'Preserve the manual step order and execute each navigation exactly where it appears. If a step navigates to a URL and the next step clicks a link, navigate to that stated URL and then click the snapshot-observed link; do not navigate directly to the linked page before attempting the click. Name each test from its manual test title; do not read the title from test data unless that field is explicitly present. DataLoader.get(module) returns a typed JSON object whose named case properties contain values directly; do not expect title/values wrappers. Generate one explicit standalone test(...) block per manual case using its literal manual title and literal typed case property. Do not use loops, Object.keys/entries/values, test.each, or map/forEach to create tests.',
      renderScreenArchitectureRequirements(manualCases, targetPagePath, targetLocatorPath),
      'Output only fenced TypeScript file blocks with repository-relative paths, including a tests/*.spec.ts file.',
    ].filter(Boolean).join('\n\n')
    response = await provider.chat([
      ...messages,
      { role: 'assistant', content: response.text },
      { role: 'user', content: correctionPrompt },
    ], { purpose: 'generate', modelId, signal: options.signal })
    recordGenerationCall(response.modelId)
    changes = normalizeGeneratedChanges(
      parseGeneratedFiles(response.text, options.repositoryRoot, { defaultSpecPath: targetSpecPath }),
    )
  }

  if (!hasSpec(changes)) {
    const parsed = changes.length > 0
      ? `Parsed file blocks: ${changes.map((change) => change.path).join(', ')}; none contained a tests/*.spec.ts file with a test(...) declaration.`
      : 'No repository-relative TypeScript file blocks could be parsed from the model reply.'
    throw new Error(`The selected Copilot model did not return a runnable TypeScript test spec after two automatic correction attempts. ${parsed} No files were written.`)
  }
  const remainingStandardsIssues = standardIssues(changes)
  if (remainingStandardsIssues.length > 0) {
    throw new Error(
      `Browser evidence replay completed, but final code validation rejected the generated files after two automatic correction attempts. No files were written:\n${remainingStandardsIssues.map((issue) => `- ${issue}`).join('\n')}`,
    )
  }
  if (manualTestData) {
    let dataUseIssues = manualDataUsageIssues(changes, manualTestData, options.repositoryRoot, targetPagePath, targetLocatorPath, frameworkExamples.dataLoaderImportPath, multiScreenFlow)
    let usedDirectJsonFallback = false
    if (dataUseIssues.length > 0 && supportsJsonModuleImports(options.repositoryRoot)) {
      const directJsonChanges = applyDirectJsonDataFallback(changes, manualTestData)
      const directJsonIssues = manualDataUsageIssues(
        directJsonChanges,
        manualTestData,
        options.repositoryRoot,
        targetPagePath,
        targetLocatorPath,
        frameworkExamples.dataLoaderImportPath,
        multiScreenFlow,
        'direct-json',
      )
      if (directJsonIssues.length === 0) {
        changes = directJsonChanges
        dataUseIssues = []
        usedDirectJsonFallback = true
      }
    }
    if (dataUseIssues.length > 0) {
      throw new Error(`The selected Copilot model did not wire the extracted manual test data after two automatic correction attempts. No files were written:\n${dataUseIssues.map((issue) => `- ${issue}`).join('\n')}`)
    }
    // Page/locator files are scenario-level assets. Once present, keep the existing
    // implementation and have each title-specific spec consume a separate data row.
    changes = changes.filter((change) =>
      !([targetPagePath, targetLocatorPath].includes(change.path) &&
        existsSync(join(options.repositoryRoot, change.path))) &&
      change.path !== targetDataPath &&
      change.path !== 'src/utils/testData/dataTypes.ts',
    )
    changes.push(...buildManualDataChanges(options.repositoryRoot, targetDataPath, manualTestData)
      .filter((change) => !usedDirectJsonFallback || change.path !== 'src/utils/testData/dataTypes.ts'))
  } else {
    // Preserve shared page-object paths even when this test case has no inline data.
    changes = changes.filter((change) =>
      !([targetPagePath, targetLocatorPath].includes(change.path) &&
        existsSync(join(options.repositoryRoot, change.path))),
    )
  }
  return changes.map((change) => ({
    ...change,
    reason: change.reason || 'Generated by the selected Copilot model from the manual test case, selected plan, browser observations, and framework index.',
    evidence: [
      ...(change.evidence ?? []),
      `Task ${options.task.taskId}; model ${response.modelId ?? modelId ?? 'unknown'}.`,
      ...(browserEvidence ? ['Includes Playwright CLI snapshots and step-scoped locator candidates.'] : ['No live browser evidence was supplied; model output must identify any remaining TODOs.']),
    ],
  }))
}

interface ExtractedManualData {
  moduleName: string
  cases: Array<{ caseKey: string; title: string; values: Record<string, string> }>
  sharedFlow: boolean
  targetPath: string
  existingJson?: string
  dataTypesPath?: string
}

/** Update an existing spec only when its title is the same case, not just a similar workflow. */
function reusableTestPath(task: TaskRecord, analysis: FrameworkAnalysisResult): string | undefined {
  const decision = task.reuseReport?.decision
  if (decision?.decision !== 'update-existing' || !decision.targetTestFile) return undefined
  const normalizeTitle = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const title = normalizeTitle(task.title)
  const sameCase = analysis.facts.tests.some((test) =>
    test.file === decision.targetTestFile &&
    (normalizeTitle(test.title) === title || normalizeTitle(test.fullTitle) === title),
  )
  return sameCase ? decision.targetTestFile : undefined
}

/** Stable scenario identity is based on the first in-app action, not the case title. */
function deriveScenarioStem(task: TaskRecord): string {
  const steps = (task.testCase ?? task.testCases?.[0])?.steps ?? []
  const click = steps.map((step) => step.action).find((action) => /^\s*click\b/i.test(action))
  const quotedClick = click?.match(/["']([^"']+)["']/)?.[1]
  const actionLabel = quotedClick ?? click?.replace(/^\s*click\s+(?:on\s+)?/i, '').replace(/[.!?]+$/, '')
  const url = steps.map((step) => step.action.match(/https?:\/\/[^\s)]+/i)?.[0]).find(Boolean)
  const fallback = (() => {
    if (!url) return task.title || 'manualScenario'
    try {
      const pathPart = new URL(url).pathname.split('/').filter(Boolean).at(-1)
      return pathPart || new URL(url).hostname.replace(/^www\./i, '').split('.')[0]!
    } catch {
      return task.title || 'manualScenario'
    }
  })()
  const isAuthTransition = /^(?:continue|next|sign\s*in|log\s*in|submit)(?:\s+button)?$/i.test(actionLabel?.trim() ?? '') &&
    steps.some((step) => /\b(?:username|user name|password)\b/i.test(step.action))
  const source = isAuthTransition ? task.title || fallback : actionLabel || fallback
  const words = source.replace(/([a-z0-9])([A-Z])/g, '$1 $2').match(/[A-Za-z0-9]+/g) ?? []
  const stem = words.slice(0, 5).map((word, index) =>
    index === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1),
  ).join('')
  return stem || 'manualScenario'
}

/** A screen transition followed by further actions needs distinct page objects. */
function requiresMultipleScreenPages(cases: TestCase[]): boolean {
  return cases.some((testCase) => {
    const steps = testCase.steps.map((step) => step.action)
    const transitionIndex = steps.findIndex((step) =>
      /\b(?:link|submenu|sidebar\s+navigation|navigation\s+menu|menu\s+item|card|tile|next\s+page|new\s+screen)\b/i.test(step) ||
      /\b(?:continue|sign\s*in|log\s*in|submit)\b/i.test(step),
    )
    return transitionIndex >= 0 && transitionIndex < steps.length - 2
  })
}

function renderScreenArchitectureRequirements(cases: TestCase[], targetPagePath: string, targetLocatorPath: string): string {
  if (!requiresMultipleScreenPages(cases)) return ''
  return `\n\n## Screen-based page-object architecture\n\nAnalyze the manual steps and step-scoped Playwright CLI snapshots to identify the actual screens and transitions. You are responsible for choosing accurate, descriptive page and locator class names and repository-relative paths from that evidence; do not use fixed page names supplied by TestPilot, and never name a page after a control or action such as ContinueButton. Create a separate framework-standard page class and paired locator class for each distinct screen, assign each action to the screen where it occurs, and have the spec call those page objects in flow order. The scenario's primary workflow page may use the stable shared paths ${targetPagePath} and ${targetLocatorPath}; name every additional screen page from its observed screen purpose and manual-step context. Keep multiple cases that share the same screens/actions on the same page and locator classes. Every page class must extend BasePage, delegate interactions through the discovered action facade, and have a matching *Locators class. The spec must import and use every page class. Use observed or indexed locators only.\n`
}

function findScreenPageArchitectureIssues(
  changes: FileChange[],
  cases: TestCase[],
  repositoryRoot: string,
): string[] {
  const issues: string[] = []
  if (!requiresMultipleScreenPages(cases)) return issues
  const specs = changes.filter((change) => /(^|\/)tests\/[^/]+\.spec\.tsx?$/.test(`/${change.path.replace(/\\/g, '/')}`))
  const specSource = specs.map((spec) => spec.newContent ?? '').join('\n')
  const generatedPageClasses = new Set<string>()
  const pageImports = [...specSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]@pages\/([^'"]+\.page(?:\.tsx?)?)['"]/g)]
    .flatMap((match) => {
      const importPath = match[2]!
      const relativePath = `pages/${importPath.endsWith('.ts') ? importPath : `${importPath}.ts`}`
      return match[1]!.split(',').map((name) => name.trim().split(/\s+as\s+/)[0]!).filter((name) => /Page$/.test(name))
        .map((className) => ({ className, relativePath }))
    })
  for (const { className, relativePath: pagePath } of pageImports) {
    const generatedPage = changes.find((change) => change.path === pagePath)
    const source = generatedPage?.newContent ?? (existsSync(join(repositoryRoot, pagePath))
      ? readFileSync(join(repositoryRoot, pagePath), 'utf-8')
      : '')
    if (!source || !new RegExp(`export\\s+class\\s+${className}\\s+extends\\s+BasePage\\b`).test(source)) {
      issues.push(`The imported page class ${className} must be exported from '${pagePath}' and extend BasePage.`)
      continue
    }
    generatedPageClasses.add(className)
    if (/(?:Button|Field|Textbox|TextBox|Input|Link|Icon|Checkbox|Card|Tile)Page$/.test(className)) {
      issues.push(`${pagePath} names a page class after a control rather than a screen; choose a descriptive screen/page name from the manual steps and browser evidence.`)
    }
    const locatorPath = pagePath.replace(/\.page\.tsx?$/i, '.locators.ts')
    const locator = changes.find((change) => change.path === locatorPath)
    const locatorSource = locator?.newContent ?? (existsSync(join(repositoryRoot, locatorPath))
      ? readFileSync(join(repositoryRoot, locatorPath), 'utf-8')
      : '')
    const locatorModule = basename(locatorPath).replace(/\.ts$/i, '')
    const locatorImportPattern = new RegExp(`from\\s+['\"]\\./${escapeRegExp(locatorModule)}(?:\\.tsx?)?['\"]`)
    if (!locatorSource || !/export\s+class\s+\w+Locators\b/.test(locatorSource) ||
        !locatorImportPattern.test(source)) {
      issues.push(`${pagePath} must have a paired locator class in '${locatorPath}' and import that class.`)
    }
    if (!new RegExp(`new\\s+${className}\\s*\\(`).test(specSource)) {
      issues.push(`The generated spec must import and instantiate ${className} for its screen.`)
    }
  }
  if (generatedPageClasses.size < 2) {
    issues.push('This flow crosses screens, but only one page class was generated. Create separate page/locator pairs for the screens, naming each from the manual steps and snapshot evidence.')
  }
  return issues
}

/** Extract quoted non-secret values from common fill/enter/type manual-step phrasing. */
function caseDataKey(title: string): string {
  return title
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .map((word, index) => index === 0
      ? word.charAt(0).toLowerCase() + word.slice(1)
      : word.charAt(0).toUpperCase() + word.slice(1))
    .join('') || 'manualCase'
}

function extractManualTestData(testCase: TestCase): Record<string, string> {
  const values: Record<string, string> = {}
  for (const step of testCase.steps) {
    const match = step.action.match(/\b(?:fill|enter|type)\s+(?:["']([^"']+)["']|(.+?))\s+(?:in|into|to)\s+(?:the\s+)?(.+?)\s*[.!]?$/i)
    if (!match) continue
    const value = (match[1] ?? match[2] ?? '').trim()
    const target = match[3]!.replace(/\b(?:text\s*box|textbox|input|field|text field)\b/gi, ' ')
      .replace(/\b(?:enter|input)\b/gi, ' ')
      .replace(/\s+/g, ' ').trim()
    const words = target.match(/[A-Za-z0-9]+/g) ?? []
    const key = words.map((word, index) => index === 0
      ? word.charAt(0).toLowerCase() + word.slice(1)
      : word.charAt(0).toUpperCase() + word.slice(1)).join('')
    if (!key || /password|secret|token|credential|apiKey/i.test(key)) continue
    values[key] = value
  }
  return values
}

/** Determine whether cases have the same ordered actions after masking their data values. */
function casesShareFlow(
  cases: TestCase[],
  dataCases: Array<{ caseKey: string; title: string; values: Record<string, string> }>,
): boolean {
  if (cases.length < 2) return true
  const signatures = cases.map((testCase, index) => {
    const values = Object.values(dataCases[index]?.values ?? {}).filter(Boolean)
    return testCase.steps.map((step) => {
      let text = `${step.action} ${step.expectedResult ?? ''}`.toLowerCase()
      for (const value of values) text = text.replaceAll(value.toLowerCase(), '<data>')
      text = text.replace(/["'][^"']+["']/g, '<quoted>')
      return text.replace(/[^a-z0-9<>]+/g, ' ').trim()
    })
  })
  return signatures.every((signature) =>
    signature.length === signatures[0]!.length && signature.every((step, index) => step === signatures[0]![index]),
  )
}

function readExistingJson(repositoryRoot: string, relativePath: string): string | undefined {
  const path = join(repositoryRoot, relativePath)
  if (!existsSync(path)) return undefined
  return readFileSync(path, 'utf-8').slice(0, 12000)
}

/** Direct JSON imports are a last-resort data source when generated DataLoader wiring is invalid. */
function supportsJsonModuleImports(repositoryRoot: string): boolean {
  const tsconfigPath = join(repositoryRoot, 'tsconfig.json')
  if (!existsSync(tsconfigPath)) return false
  try {
    const source = readFileSync(tsconfigPath, 'utf-8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '')
    return /"resolveJsonModule"\s*:\s*true\b/.test(source)
  } catch {
    return false
  }
}

/** Replace broken DataLoader-only spec wiring with a typed import of the generated JSON module. */
function applyDirectJsonDataFallback(changes: FileChange[], data: ExtractedManualData): FileChange[] {
  const jsonImportName = `${data.moduleName}Json`
  return changes.map((change) => {
    if (!/(^|\/)tests\/[^/]+\.spec\.tsx?$/.test(`/${change.path.replace(/\\/g, '/')}`)) return change
    let source = change.newContent ?? ''
    const dataVariable = source.match(new RegExp(
      `(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*DataLoader\\s*\\.\\s*get\\(\\s*['"]${escapeRegExp(data.moduleName)}['"]\\s*\\)`,
    ))?.[1]

    source = source.replace(/^import\s+\{\s*DataLoader\s*\}\s+from\s+['"][^'"]+['"]\s*;?\s*\r?\n/gm, '')
    if (dataVariable) {
      source = source.replace(new RegExp(
        `^\\s*(?:const|let)\\s+${escapeRegExp(dataVariable)}\\s*=\\s*DataLoader\\s*\\.\\s*get\\(\\s*['"]${escapeRegExp(data.moduleName)}['"]\\s*\\)\\s*;?\\s*\\r?\\n`,
        'gm',
      ), '')
      source = source.replace(new RegExp(`\\b${escapeRegExp(dataVariable)}\\s*\\[\\s*(['"])([^'"]+)\\1\\s*\\]`, 'g'), `${jsonImportName}['$2']`)
      source = source.replace(new RegExp(`\\b${escapeRegExp(dataVariable)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g'), `${jsonImportName}.$1`)
    }
    source = source.replace(new RegExp(`DataLoader\\s*\\.\\s*get\\(\\s*['"]${escapeRegExp(data.moduleName)}['"]\\s*\\)`, 'g'), jsonImportName)

    for (const testCase of data.cases) {
      const row = `${jsonImportName}['${testCase.caseKey}']`
      source = source.replace(new RegExp(`${escapeRegExp(jsonImportName)}\\s*\\[\\s*['"]${escapeRegExp(testCase.caseKey)}['"]\\s*\\]\\s*\\.\\s*values\\b`, 'g'), row)
      const titlePattern = new RegExp(`\\btest\\s*\\(\\s*(['"\x60])${escapeRegExp(testCase.title)}\\1`)
      const titleMatch = titlePattern.exec(source)
      if (!titleMatch) continue
      const start = titleMatch.index
      const nextTest = source.slice(start + titleMatch[0].length).search(/\n\s*test\s*\(/)
      const end = nextTest < 0 ? source.length : start + titleMatch[0].length + nextTest
      let block = source.slice(start, end)
      for (const [key, value] of Object.entries(testCase.values)) {
        const valuePattern = new RegExp(`((?:\\(|,)\\s*)(['"])${escapeRegExp(value)}\\2(?=\\s*[,);])`, 'g')
        block = block.replace(valuePattern, `$1${row}.${key}`)
      }
      source = source.slice(0, start) + block + source.slice(end)
    }

    const importPath = relative(dirname(change.path), data.targetPath).replace(/\\/g, '/')
    const specifier = importPath.startsWith('.') ? importPath : `./${importPath}`
    const importLine = `import ${jsonImportName} from '${specifier}'\n`
    const firstImport = source.match(/^import\s/m)
    source = firstImport ? source.slice(0, firstImport.index) + importLine + source.slice(firstImport.index) : importLine + source
    return {
      ...change,
      newContent: source,
      reason: `${change.reason ?? ''} DataLoader wiring was invalid, so the scenario JSON is imported directly as the configured fallback.`.trim(),
      evidence: [...(change.evidence ?? []), 'Used the framework-supported direct JSON import fallback after DataLoader wiring failed validation.'],
    }
  })
}

/** Replace hardcoded manual input literals with their typed JSON row fields. */
export function rewriteHardcodedManualData(changes: FileChange[], data: ExtractedManualData): FileChange[] {
  return changes.map((change) => {
    if (!/(^|\/)tests\/[^/]+\.spec\.tsx?$/.test(`/${change.path.replace(/\\/g, '/')}`) || !change.newContent) return change
    let source = change.newContent
    let updated = false

    for (const testCase of data.cases) {
      const titlePattern = new RegExp(`\\btest\\s*\\(\\s*(['"\\x60])${escapeRegExp(testCase.title)}\\1`)
      const titleMatch = titlePattern.exec(source)
      if (!titleMatch) continue
      const start = titleMatch.index
      const tailStart = start + titleMatch[0].length
      const nextTest = source.slice(tailStart).search(/\n\s*test\s*\(/)
      const end = nextTest < 0 ? source.length : tailStart + nextTest
      let block = source.slice(start, end)

      let rowExpression: string | undefined
      const dataLoaderImport = /import\s+\{\s*DataLoader\s*\}\s+from\s+['"][^'"]+['"]/.test(source)
      if (dataLoaderImport) {
        const moduleGetter = `DataLoader\\s*\\.\\s*get\\(\\s*['"]${escapeRegExp(data.moduleName)}['"]\\s*\\)`
        const indexedDeclaration = source.match(new RegExp(
          `\\b(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${moduleGetter}\\s*\\[\\s*['"]${escapeRegExp(testCase.caseKey)}['"]\\s*\\]`,
        ))?.[1]
        const rootDeclaration = source.match(new RegExp(
          `\\b(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${moduleGetter}(?!\\s*\\[)`,
        ))?.[1]
        rowExpression = indexedDeclaration ?? (rootDeclaration
          ? `${rootDeclaration}['${testCase.caseKey}']`
          : `DataLoader.get('${data.moduleName}')['${testCase.caseKey}']`)
      } else {
        const jsonImport = source.match(new RegExp(`import\\s+(${escapeRegExp(`${data.moduleName}Json`)})\\s+from\\s+['"][^'"]+['"]`))?.[1]
        if (jsonImport) rowExpression = `${jsonImport}['${testCase.caseKey}']`
      }
      if (!rowExpression) continue

      for (const [key, value] of Object.entries(testCase.values)) {
        if (value.length < 3) continue
        const literal = new RegExp(`(['"\\x60])${escapeRegExp(value)}\\1`, 'g')
        const replaced = block.replace(literal, `${rowExpression}.${key}`)
        if (replaced !== block) {
          updated = true
          block = replaced
        }
      }
      source = source.slice(0, start) + block + source.slice(end)
    }

    return updated
      ? {
          ...change,
          newContent: source,
          reason: `${change.reason ?? ''} Replaced hardcoded manual inputs with their extracted typed test-data fields.`.trim(),
          evidence: [...(change.evidence ?? []), 'Manual input literals in each test block now reference the corresponding extracted JSON case row.'],
        }
      : change
  })
}

function manualDataUsageIssues(
  changes: FileChange[],
  data: ExtractedManualData,
  repositoryRoot: string,
  targetPagePath: string,
  targetLocatorPath: string,
  expectedDataLoaderImportPath?: string,
  multiScreenFlow = false,
  accessMode: 'data-loader' | 'direct-json' = 'data-loader',
): string[] {
  const specs = changes.filter((change) => /(^|\/)tests\/[^/]+\.spec\.tsx?$/.test(`/${change.path.replace(/\\/g, '/')}`))
  if (specs.length === 0) return ['No spec was returned to verify DataLoader usage.']
  const issues: string[] = []
  const modulePattern = new RegExp(`DataLoader\\.get\\(\\s*['"]${data.moduleName}['"]\\s*\\)`)
  const jsonImportName = `${data.moduleName}Json`
  const pageName = data.moduleName.charAt(0).toUpperCase() + data.moduleName.slice(1)
  const pageImport = `@pages/${pageName}/${data.moduleName}.page`
  for (const spec of specs) {
    const source = spec.newContent ?? ''
    const dataLoaderImport = source.match(/import\s+\{\s*DataLoader\s*\}\s+from\s+['"]([^'"]+)['"]/)
    if (data.sharedFlow && !source.includes(`from '${pageImport}'`) && !source.includes(`from "${pageImport}"`)) {
      issues.push(`${spec.path} must import the shared scenario page object from '${pageImport}'.`)
    }
    const jsonImport = source.match(new RegExp(`import\\s+${escapeRegExp(jsonImportName)}\\s+from\\s+['"]([^'"]+)['"]`))
    if (accessMode === 'data-loader' && expectedDataLoaderImportPath && dataLoaderImport?.[1] !== expectedDataLoaderImportPath) {
      issues.push(`${spec.path} must import DataLoader from '${expectedDataLoaderImportPath}' to match the target framework.`)
    }
    if (accessMode === 'data-loader' && !modulePattern.test(source)) issues.push(`${spec.path} must load the shared '${data.moduleName}' module through DataLoader.`)
    if (accessMode === 'direct-json') {
      const expectedPath = relative(dirname(spec.path), data.targetPath).replace(/\\/g, '/')
      const expectedSpecifier = expectedPath.startsWith('.') ? expectedPath : `./${expectedPath}`
      if (jsonImport?.[1] !== expectedSpecifier) issues.push(`${spec.path} must import the generated '${data.targetPath}' JSON directly using its relative path.`)
      if (dataLoaderImport || /DataLoader\s*\.\s*get\s*\(/.test(source)) issues.push(`${spec.path} must use the direct JSON import consistently after the DataLoader fallback.`)
    }
  }
  const generatedCode = changes
    // Locator names/selectors are derived from live browser evidence. They can
    // legitimately contain the same text as a data value (for example, a VA01
    // result-card locator) and must not be mistaken for hardcoded test input.
    .filter((change) => /\.tsx?$/.test(change.path) &&
      !/\.locators\.tsx?$/i.test(change.path) &&
      change.path !== 'src/utils/testData/dataTypes.ts')
    .map((change) => change.newContent ?? '')
    .join('\n')
  const combinedSource = specs.map((spec) => spec.newContent ?? '').join('\n')
  const dataVariable = accessMode === 'direct-json'
    ? combinedSource.match(new RegExp(`import\\s+(${escapeRegExp(jsonImportName)})\\s+from`))?.[1]
    : combinedSource.match(new RegExp(
    `(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*DataLoader\\s*\\.\\s*get\\(\\s*['"]${escapeRegExp(data.moduleName)}['"]\\s*\\)`,
  ))?.[1]
  if (/\bObject\s*\.\s*(?:keys|entries|values)\s*\(|\btest\s*(?:\.\s*each|\.\s*describe\s*\.\s*each)\s*\(|\b(?:testCases|cases)\s*\.\s*(?:map|forEach)\s*\(/.test(combinedSource)) {
    issues.push('Generate separate, explicit test(...) blocks for the manual cases. Do not loop through data rows or parameterize tests.')
  }
  if (/\bconst\s*\{\s*title\s*,\s*values\s*\}\s*=/.test(combinedSource)) {
    issues.push(`Rows in DataLoader.get('${data.moduleName}') contain the case values directly; they do not have title/values wrappers. Use the manual title in test(...) and access the row's fields directly.`)
  }
  if (dataVariable && new RegExp(`\\b${escapeRegExp(dataVariable)}\\s*\\[\\s*[A-Za-z_$][\\w$]*\\s*\\]`).test(combinedSource)) {
    issues.push(`Do not index DataLoader.get('${data.moduleName}') with a string variable. Use each case's literal typed property in its own explicit test block.`)
  }
  if (new RegExp(`DataLoader\\s*\\.\\s*get\\(\\s*['"]${escapeRegExp(data.moduleName)}['"]\\s*\\)\\s*\\[\\s*[A-Za-z_$][\\w$]*\\s*\\]`).test(combinedSource)) {
    issues.push(`Do not index DataLoader.get('${data.moduleName}') with a string variable. Use each case's literal typed property in its own explicit test block.`)
  }
  for (const testCase of data.cases) {
    const literalTest = new RegExp(
      "\\btest\\s*\\(\\s*(['\"`])" + escapeRegExp(testCase.title) + "\\1",
    )
    if (!literalTest.test(combinedSource)) {
      issues.push(`Declare a standalone test('${testCase.title}', ...) block for this manual case; test titles must be literal manual titles.`)
    }
    const module = escapeRegExp(data.moduleName)
    const caseKey = escapeRegExp(testCase.caseKey)
    const directRow = accessMode === 'direct-json'
      ? new RegExp(`${escapeRegExp(jsonImportName)}\\s*\\[\\s*['"]${caseKey}['"]\\s*\\](?!\\s*\\.\\s*values\\b)`)
      : new RegExp(`DataLoader\\s*\\.\\s*get\\(\\s*['"]${module}['"]\\s*\\)\\s*\\[\\s*['"]${caseKey}['"]\\s*\\](?!\\s*\\.\\s*values\\b)`)
    const typedPropertyRow = dataVariable
      ? new RegExp(`\\b${escapeRegExp(dataVariable)}\\s*(?:\\.\\s*${caseKey}\\b|\\[\\s*['"]${caseKey}['"]\\s*\\])`)
      : /(?!)/
    const valuesWrapper = new RegExp(`DataLoader\\s*\\.\\s*get\\(\\s*['"]${module}['"]\\s*\\)\\s*\\[\\s*['"]${caseKey}['"]\\s*\\]\\s*\\.\\s*values\\b`)
    const typedValuesWrapper = dataVariable
      ? new RegExp(`\\b${escapeRegExp(dataVariable)}\\s*(?:\\.\\s*${caseKey}\\b|\\[\\s*['"]${caseKey}['"]\\s*\\])\\s*\\.\\s*values\\b`)
      : /(?!)/
    if (valuesWrapper.test(combinedSource) || typedValuesWrapper.test(combinedSource)) {
      issues.push(`Data row '${testCase.caseKey}' is already the values object; remove the incorrect '.values' wrapper after DataLoader.get(...)[caseKey].`)
    } else if (!directRow.test(combinedSource) && !typedPropertyRow.test(combinedSource)) {
      issues.push(`Select data row '${testCase.caseKey}' directly from DataLoader.get('${data.moduleName}'); case rows do not have a '.values' wrapper.`)
    }
    for (const [key, value] of Object.entries(testCase.values)) {
      if (!combinedSource.includes(`.${key}`) && !combinedSource.includes(`['${key}']`) && !combinedSource.includes(`["${key}"]`)) {
        issues.push(`The generated spec set must pass the '${key}' value from the '${testCase.caseKey}' row to page actions/assertions.`)
      }
      if (value.length >= 3 && containsQuotedStringLiteral(generatedCode, value)) {
        issues.push(`Generated TypeScript hardcodes '${value}' instead of reading it from the test-data JSON.`)
      }
    }
  }
  if (data.sharedFlow) {
    for (const target of [targetPagePath, targetLocatorPath]) {
      const presentOnDisk = existsSync(join(repositoryRoot, target))
      const presentInProposal = changes.some((change) => change.path === target && !!change.newContent)
      if (!presentOnDisk && !presentInProposal) issues.push(`The shared scenario file '${target}' is missing; return it at this exact path.`)
    }
    for (const change of changes) {
      if (!multiScreenFlow && /^pages\/.+\.(?:page|locators)\.tsx?$/.test(change.path) &&
          change.path !== targetPagePath && change.path !== targetLocatorPath) {
        issues.push(`${change.path} duplicates scenario assets for a shared flow; use shared paths '${targetPagePath}' and '${targetLocatorPath}'.`)
      }
    }
  }
  return issues
}

function containsQuotedStringLiteral(source: string, value: string): boolean {
  return new RegExp(`(['"\\x60])${escapeRegExp(value)}\\1`).test(source)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Prevent generated code from jumping past manual click/navigation steps. */
function findManualNavigationIssues(changes: FileChange[], testCases: TestCase[]): string[] {
  const canonicalUrl = (value: string): string =>
    value.trim().replace(/[.,;!?]+$/, '').replace(/\/+$/, '').toLowerCase()
  const expectedCounts = new Map<string, number>()
  for (const testCase of testCases) {
    for (const step of testCase.steps) {
      for (const match of step.action.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
        const url = canonicalUrl(match[0] ?? '')
        if (url) expectedCounts.set(url, (expectedCounts.get(url) ?? 0) + 1)
      }
    }
  }

  const navigationCalls: Array<{ path: string; url: string; key: string }> = []
  for (const change of changes) {
    const source = change.newContent ?? ''
    for (const match of source.matchAll(/\.(?:navigate|goto)\s*\(\s*(['"`])(https?:\/\/[^'"`\r\n]+)\1/g)) {
      const rawUrl = match[2] ?? ''
      navigationCalls.push({ path: change.path, url: rawUrl, key: canonicalUrl(rawUrl) })
    }
  }

  const issues: string[] = []
  const actualCounts = new Map<string, number>()
  for (const call of navigationCalls) {
    actualCounts.set(call.key, (actualCounts.get(call.key) ?? 0) + 1)
    if (!expectedCounts.has(call.key)) {
      issues.push(`${call.path} navigates to '${call.url}', which is not a URL in the manual steps. Keep the browser on the stated screen and use the observed link/action to reach the next screen.`)
    }
  }
  for (const [url, actualCount] of actualCounts) {
    const expectedCount = expectedCounts.get(url) ?? 0
    if (actualCount > expectedCount) {
      issues.push(`Generated code navigates to '${url}' ${actualCount} time(s), but the manual steps specify it ${expectedCount} time(s). Remove duplicate navigation so later actions run on the screen reached by preceding steps.`)
    }
  }

  const testCalls = new Set(navigationCalls
    .filter((call) => /(^|\/)tests\//i.test(call.path.replace(/\\/g, '/')))
    .map((call) => call.key))
  for (const call of navigationCalls) {
    if (/(^|\/)pages\/.+\.page\.tsx?$/i.test(call.path.replace(/\\/g, '/')) && testCalls.has(call.key)) {
      issues.push(`Navigation to '${call.url}' is implemented in both a test file and page object. Keep it in one place only so each manual navigation runs exactly once.`)
    }
  }
  return [...new Set(issues)]
}

/**
 * Reject generated specs that silently drop manual actions. This is intentionally
 * conservative: navigation URLs are checked separately, action labels must appear
 * in that case's executable test body, and every non-navigation step must have an
 * awaited implementation call. Assertions must retain an assertion/validation call.
 */
function findManualStepCoverageIssues(changes: FileChange[], testCases: TestCase[]): string[] {
  const specs = changes.filter((change) => /(^|\/)tests\/[^/]+\.spec\.tsx?$/.test(`/${change.path.replace(/\\/g, '/')}`))
  const issues: string[] = []
  for (const testCase of testCases) {
    const matchingBodies = specs.flatMap((spec) => {
      const body = extractNamedTestBody(spec.newContent ?? '', testCase.title)
      return body === undefined ? [] : [body]
    })
    if (matchingBodies.length !== 1) {
      issues.push(`Could not verify one standalone test body for '${testCase.title}'. Generate one literal test('${testCase.title}', ...) block so every manual step can be checked.`)
      continue
    }

    const body = matchingBodies[0]!
    const executableCalls = [...body.matchAll(/\bawait\b/g)].length
    const actions = testCase.steps.filter((step) => !extractStepUrl(step.action))
    if (executableCalls < actions.length) {
      issues.push(`Test '${testCase.title}' has ${executableCalls} awaited call(s) for ${actions.length} non-navigation manual step(s). Add an executable call for every step, in order.`)
    }

    const awaitedLines = body.split(/\r?\n/).filter((line) => /\bawait\b/.test(line))
    const awaitedCalls = awaitedLines.flatMap((line) =>
      [...line.matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1] ?? ''),
    )
    const awaitedLocators = awaitedLines.flatMap((line) =>
      [...line.matchAll(/\b(?:locators|locator)\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1] ?? ''),
    )
    const invokedPageMethods = [...body.matchAll(/\bawait\s+[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)\s*\(/g)]
      .map((match) => match[1] ?? '')
    const pageMethodContext = invokedPageMethods.flatMap((methodName) => {
      const escaped = escapeRegExp(methodName)
      const declaration = new RegExp(`\\basync\\s+${escaped}\\s*\\([^)]*\\)[^{]*\\{`).exec(
        changes.filter((change) => /^pages\/.+\.page\.tsx?$/.test(change.path))
          .map((change) => change.newContent ?? '').join('\n'),
      )
      if (!declaration || declaration.index === undefined) return []
      const source = changes.filter((change) => /^pages\/.+\.page\.tsx?$/.test(change.path))
        .map((change) => change.newContent ?? '').join('\n')
      const openBrace = declaration.index + declaration[0].lastIndexOf('{')
      const closeBrace = findMatchingBrace(source, openBrace)
      const stepAnnotation = source.lastIndexOf('@Step', declaration.index)
      return [source.slice(stepAnnotation >= 0 ? stepAnnotation : declaration.index, closeBrace >= 0 ? closeBrace + 1 : openBrace + 1)]
    })
    const bodyWords = new Set(normalizeCoverageText([
      ...awaitedCalls,
      ...awaitedLocators,
      ...invokedPageMethods,
      ...pageMethodContext,
    ].join(' ')).split(' ').filter(Boolean))
    for (const step of actions) {
      if (isLocatorAssertionStep(step.action)) {
        if (!/\b(?:expect|assert|validate|verify|toBe|toHave|toContain)\w*/i.test(body)) {
          issues.push(`Test '${testCase.title}' has no assertion or validation call for manual step ${step.order}: '${step.action}'.`)
        }
        continue
      }
      const target = parseReplayAction(step.action)?.target
      const terms = target ? coverageTerms(target) : []
      const missing = terms.filter((term) => !bodyWords.has(term))
      if (missing.length > 0) {
        issues.push(`Test '${testCase.title}' does not visibly implement manual step ${step.order}: '${step.action}'. Its target term(s) ${missing.join(', ')} are absent from that test body.`)
      }
    }
  }
  return [...new Set(issues)]
}

function extractNamedTestBody(source: string, title: string): string | undefined {
  const pattern = new RegExp(`\\btest\\s*\\(\\s*(['\"\x60])${escapeRegExp(title)}\\1\\s*,[\\s\\S]*?=>\\s*\\{`)
  const match = pattern.exec(source)
  if (!match || match.index === undefined) return undefined
  const openBrace = match.index + match[0].lastIndexOf('{')
  const closeBrace = findMatchingBrace(source, openBrace)
  return closeBrace < 0 ? undefined : source.slice(openBrace + 1, closeBrace)
}

/** Find the matching TypeScript brace while ignoring quoted strings and comments. */
function findMatchingBrace(source: string, openBrace: number): number {
  let depth = 0
  let quote: "'" | '"' | '`' | undefined
  let lineComment = false
  let blockComment = false
  for (let index = openBrace; index < source.length; index++) {
    const char = source[index]!
    const next = source[index + 1]
    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index++ }
      continue
    }
    if (quote) {
      if (char === '\\') { index++; continue }
      if (char === quote) quote = undefined
      continue
    }
    if (char === '/' && next === '/') { lineComment = true; index++; continue }
    if (char === '/' && next === '*') { blockComment = true; index++; continue }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue }
    if (char === '{') depth++
    if (char === '}' && --depth === 0) return index
  }
  return -1
}

function normalizeCoverageText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:listing|listed)\b/g, 'list')
    .trim()
    .replace(/\s+/g, ' ')
}

function coverageTerms(value: string): string[] {
  const ignored = new Set(['the', 'a', 'an', 'on', 'in', 'to', 'from', 'of', 'for', 'with', 'and', 'or', 'enter', 'fill', 'type', 'input', 'select', 'choose', 'side', 'sidebar', 'navigation', 'nav', 'menu', 'submenu', 'sub', 'item', 'button', 'link', 'icon', 'field', 'textbox', 'checkbox', 'radio', 'visible', 'displayed', 'shown', 'page', 'screen'])
  return [...new Set(normalizeCoverageText(value)
    .split(' ')
    .map((word) => word === 'listing' ? 'list' : word)
    .filter((word) => word.length > 1 && !ignored.has(word)))]
}

/** Keep an assertion locator tied to its own post-action snapshot, not an input control. */
function findAssertionLocatorIssues(
  changes: FileChange[],
  testCases: TestCase[],
  candidates: VerifiedLocator[],
): string[] {
  const locatorFiles = changes.filter((change) => /(^|\/)pages\/.+\.locators\.tsx?$/.test(`/${change.path.replace(/\\/g, '/')}`))
  const issues: string[] = []
  for (const testCase of testCases) {
    for (const step of testCase.steps) {
      if (!isLocatorAssertionStep(step.action)) continue
      const quoted = assertionTextTerms(step.action)
      const expected = quoted.at(-1) ?? step.expectedResult
      if (!expected) continue
      const expectedName = normalizeWords(expected)
      const assertionCandidates = candidates.filter((candidate) =>
        candidate.stepOrder === step.order && normalizeWords(candidate.name ?? '') === expectedName,
      )
      if (assertionCandidates.length === 0) continue

      for (const locatorFile of locatorFiles) {
        const source = locatorFile.newContent ?? ''
        const assertionMembers = [
          ...source.matchAll(/(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*=\s*([^\n;]+)/g),
        ].filter((match) =>
          /display|result|output|expected|validation|confirm|success/i.test(match[1] ?? '') &&
          extractLocatorExpressions(match[2] ?? '').length > 0,
        )
        const assertionMethods = [...source.matchAll(
          /\b([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*:\s*string\s*\)\s*(?::\s*[^={]+)?\s*\{([\s\S]*?)\}/g,
        )].filter((match) => /display|result|output|expected|validation|confirm|success/i.test(match[1] ?? ''))
        const observedExpressions = assertionCandidates.map((candidate) => normalizeLocatorExpression(candidate.expression))
        const observedStrategies = new Set(assertionCandidates.map((candidate) => locatorCallDetails(candidate.expression)?.method))
        const hasMatchingField = assertionMembers.some((match) => observedExpressions.includes(normalizeLocatorExpression(match[2] ?? '')))
        const hasMatchingMethod = assertionMethods.some((method) => {
          const parameter = method[2]
          const body = method[3] ?? ''
          const dynamicCalls = extractLocatorExpressions(body)
            .map(locatorCallDetails)
            .filter((call): call is NonNullable<typeof call> => Boolean(call))
          return dynamicCalls.some((call) =>
            observedStrategies.has(call.method) && call.args?.trim() === parameter,
          )
        })
        if ((assertionMembers.length > 0 || assertionMethods.length > 0) && !hasMatchingField && !hasMatchingMethod) {
          issues.push(`${locatorFile.path} must use the locator candidate from assertion step ${step.order} whose observed text is '${expected}'. Do not reuse the input control or another step's locator.`)
        }
      }
    }
  }
  return [...new Set(issues)]
}

/** Merge the case row into the shared JSON module and register its inferred TS type. */
function buildManualDataChanges(
  repositoryRoot: string,
  dataPath: string,
  data: ExtractedManualData,
): FileChange[] {
  const absoluteDataPath = join(repositoryRoot, dataPath)
  let allRows: Record<string, unknown> = {}
  if (existsSync(absoluteDataPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(absoluteDataPath, 'utf-8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object')
      allRows = parsed as Record<string, unknown>
    } catch (error) {
      throw new Error(`Cannot safely merge ${dataPath}: existing JSON is invalid (${error instanceof Error ? error.message : String(error)}).`)
    }
  }
  for (const testCase of data.cases) allRows[testCase.caseKey] = testCase.values
  const changes: FileChange[] = [{
    path: dataPath,
    kind: existsSync(absoluteDataPath) ? 'modify' : 'create',
    newContent: `${JSON.stringify(allRows, null, 2)}\n`,
    reason: `Added ${data.cases.length} non-secret case row(s) to the shared '${data.moduleName}' scenario module.`,
    evidence: ['Values were extracted from quoted fill/enter/type actions in the normalized manual test case.'],
  }]

  const typePath = join(repositoryRoot, 'src/utils/testData/dataTypes.ts')
  if (!existsSync(typePath)) return changes
  const typeSource = readFileSync(typePath, 'utf-8')
  const registry = typeSource.match(/(export\s+interface\s+DataRegistry\s*\{)([\s\S]*?)(\n\s*\})/)
  if (!registry || new RegExp(`^\\s*${data.moduleName}\\s*:`, 'm').test(registry[2]!)) return changes
  // DataLoader imports are resolved from src/utils/testData; ../../../ reaches the repository root.
  const desiredEntry = `\n  ${data.moduleName}: typeof import('../../../test-data/${data.moduleName}/${data.moduleName}.qa.json')`
  const nextSource = typeSource.replace(registry[0], `${registry[1]}${registry[2]}${desiredEntry}${registry[3]}`)
  changes.push({
    path: 'src/utils/testData/dataTypes.ts',
    kind: 'modify',
    newContent: nextSource.endsWith('\n') ? nextSource : `${nextSource}\n`,
    reason: `Registered the '${data.moduleName}' JSON module in the framework's DataRegistry so DataLoader.get remains typed.`,
    evidence: ['Matched the existing DataRegistry typeof import convention in the target framework.'],
  })
  return changes
}

interface FrameworkGenerationExamples {
  text: string
  fixtureImportPath?: string
  dataLoaderImportPath?: string
  specUsesPageAlias: boolean
  pageExtendsBasePage: boolean
  pageUsesActionFacade: boolean
  locatorClassBased: boolean
}

/** Select compact, real source examples that show how this framework is used. */
function renderFrameworkExamples(analysis: FrameworkAnalysisResult): FrameworkGenerationExamples {
  const files = analysis.analysis.indexedFiles
  const read = (file: (typeof files)[number]): string => {
    try { return readFileSync(file.absolutePath, 'utf-8') } catch { return '' }
  }

  const testCandidates = files
    .filter((file) => file.role === 'test')
    .map((file) => ({ file, source: read(file) }))
    .filter(({ source }) => source.length > 0 && !/\b(?:test|describe|it)\.only\s*\(/.test(source))
    .sort((a, b) => {
      const score = (source: string) =>
        Number(/@src\/config\/fixture/.test(source)) * 2 +
        Number(/import\s+\{\s*DataLoader\s*\}\s+from\s+['"][^'"]*utils\/testData\/dataLoader['"]/.test(source)) * 6 +
        Number(/DataLoader\.get\s*\(/.test(source)) * 2 -
        Number(/DataLoader\.get\s*\([^)]*\)[^\n;]*\.values\b/.test(source)) * 3
      return score(b.source) - score(a.source)
    })
  const pageCandidates = files
    .filter((file) => file.role === 'page-object')
    .map((file) => ({ file, source: read(file) }))
    .filter(({ source }) => source.length > 0)
    .sort((a, b) => {
      const score = (source: string) => Number(/extends\s+BasePage/.test(source)) * 2 + Number(/this\.actions\./.test(source))
      return score(b.source) - score(a.source)
    })
  const locatorCandidates = files
    .filter((file) => file.role === 'locators')
    .map((file) => ({ file, source: read(file) }))
    .filter(({ source }) => source.length > 0)
    .sort((a, b) => Number(/export\s+class\s+\w+Locators/.test(b.source)) - Number(/export\s+class\s+\w+Locators/.test(a.source)))

  const selected = [testCandidates[0], pageCandidates[0], locatorCandidates[0]].filter(
    (item): item is NonNullable<typeof item> => Boolean(item),
  )
  const text = selected.map(({ file, source }) =>
    `### ${file.relativePath}\n\n\`\`\`typescript\n${source.slice(0, 3500)}\n\`\`\``,
  ).join('\n\n')
  const testSource = testCandidates[0]?.source ?? ''
  const pageSource = pageCandidates[0]?.source ?? ''
  const locatorSource = locatorCandidates[0]?.source ?? ''
  const fixtureImportPath = testSource.match(/import\s+\{[^}]*\btest\b[^}]*\}\s+from\s+['"]([^'"]+)['"]/s)?.[1]
  const dataLoaderImportPath = testSource.match(/import\s+\{\s*DataLoader\s*\}\s+from\s+['"]([^'"]+)['"]/)?.[1]
  const dataLoaderConvention = dataLoaderImportPath
    ? `\n\nTarget framework DataLoader import: ${dataLoaderImportPath}. Case rows returned by DataLoader.get are direct JSON objects; access values as DataLoader.get(module)[caseKey].field.`
    : ''

  return {
    text: `${text}${dataLoaderConvention}`,
    fixtureImportPath,
    dataLoaderImportPath,
    specUsesPageAlias: /from\s+['"]@pages\//.test(testSource),
    pageExtendsBasePage: /extends\s+BasePage/.test(pageSource),
    pageUsesActionFacade: /this\.actions\./.test(pageSource),
    locatorClassBased: /export\s+class\s+\w+Locators/.test(locatorSource),
  }
}

/** Reject generated files that visibly violate conventions established by real framework sources. */
function findFrameworkStandardIssues(
  changes: FileChange[],
  examples: FrameworkGenerationExamples,
  customFixtureUsed: boolean,
  approvedLocatorExpressions: string[] = [],
): string[] {
  const issues: string[] = []
  const specs = changes.filter((change) => /(^|\/)tests\/[^/]+\.spec\.tsx?$/.test(`/${change.path.replace(/\\/g, '/')}`))
  const pages = changes.filter((change) => /(^|\/)pages\/.+\.page\.tsx?$/.test(`/${change.path.replace(/\\/g, '/')}`))
  const locators = changes.filter((change) => /(^|\/)pages\/.+\.locators\.tsx?$/.test(`/${change.path.replace(/\\/g, '/')}`))

  for (const spec of specs) {
    const source = spec.newContent ?? ''
    if (/import\s+\{[^}]*\bxray\b[^}]*\}\s+from\s+['"][^'"]+['"]|\bxray\s*\(|@Xray\b/i.test(source)) {
      issues.push(`${spec.path} includes Xray integration. Do not add Xray imports, IDs, annotations, or integrations to generated specs.`)
    }
    if (/\b(?:test|describe|it)\.only\s*\(|\b(?:fit|fdescribe)\s*\(/.test(source)) {
      issues.push(`${spec.path} uses a focused test (.only/fit/fdescribe); generated specs must not suppress the rest of the suite.`)
    }
    if (customFixtureUsed && examples.fixtureImportPath) {
      const escaped = examples.fixtureImportPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const fixtureImport = new RegExp(`import\\s+\\{[^}]*\\btest\\b[^}]*\\}\\s+from\\s+['"]${escaped}['"]`, 's')
      if (!fixtureImport.test(source)) {
        issues.push(`${spec.path} must import test from the framework fixture ${examples.fixtureImportPath}, not directly from @playwright/test.`)
      }
    }
    if (examples.specUsesPageAlias && !/from\s+['"]@pages\//.test(source)) {
      issues.push(`${spec.path} must use the framework's @pages/... import alias shown in existing specs.`)
    }
  }

  for (const page of pages) {
    const source = page.newContent ?? ''
    if (examples.pageExtendsBasePage && !/class\s+\w+\s+extends\s+BasePage\b/.test(source)) {
      issues.push(`${page.path} must extend BasePage, as existing framework page classes do.`)
    }
    if (examples.pageUsesActionFacade && /this\.page\.(?:frameLocator|locator|getBy\w+|goto)\s*\(/.test(source)) {
      issues.push(`${page.path} bypasses the framework Actions facade; page methods should call this.actions and use this.locators.`)
    }
  }

  for (const locator of locators) {
    const source = locator.newContent ?? ''
    if (examples.locatorClassBased && !/export\s+class\s+\w+Locators\b/.test(source)) {
      issues.push(`${locator.path} must export a *Locators class, matching existing locator modules.`)
    }
    if (/export\s+const\s+locators\s*=/.test(source) || /:\s*["'`]\s*(?:this\.page\.)?(?:frameLocator|getByRole|getByLabel|getByText|getByPlaceholder|locator)\s*\(/.test(source)) {
      issues.push(`${locator.path} stores locator expressions as strings; locator fields must be actual this.page.getBy.../locator(...) objects.`)
    }
    if (/adjust this selector|selector based on the actual|todo\s*:\s*.*locator|assumed\s*[-:]\s*not observed/i.test(source)) {
      issues.push(`${locator.path} contains a guessed/unverified locator note. Remove it and use a locator observed in a Playwright snapshot or already indexed in the framework.`)
    }
    const allowed = new Set(approvedLocatorExpressions.map(normalizeLocatorExpression).filter(Boolean))
    const locatorCalls = extractLocatorExpressions(source).map((expression) => ({
      expression,
      method: locatorCallDetails(expression)?.method ?? '',
      args: locatorCallDetails(expression)?.args ?? '',
      index: source.indexOf(expression),
    }))
    const stringParameterMethods = [...source.matchAll(
      /\b[A-Za-z_$][\w$]*\s*\(\s*([A-Za-z_$][\w$]*)\s*:\s*string\s*\)\s*(?::\s*[^={]+)?\s*\{([\s\S]*?)\}/g,
    )].map((method) => ({
      parameter: method[1],
      body: method[2] ?? '',
      bodyStart: (method.index ?? 0) + method[0].indexOf('{') + 1,
    }))
    for (const match of locatorCalls) {
      const expression = match.expression.replace(/^this\.page\./, '')
      const normalizedExpression = normalizeLocatorExpression(expression)
      const locatorIsObserved = isObservedLocatorExpression(normalizedExpression, allowed) ||
        [...allowed].some((observed) => observed.startsWith(`${normalizedExpression}.`))
      if (!locatorIsObserved) {
        const callIndex = match.index
        const method = stringParameterMethods.find((candidate) =>
          callIndex >= candidate.bodyStart && callIndex < candidate.bodyStart + candidate.body.length,
        )
        const approvedTextStrategy = [...allowed].some((item) => item.startsWith('getByText('))
        const isVerifiedDynamicText = match.method === 'getByText' &&
          method?.parameter && match.args.trim() === method.parameter &&
          new RegExp(`\\breturn\\s+this\\.page\\.getByText\\s*\\(\\s*${method.parameter}\\s*\\)\\s*;?`).test(method.body) &&
          approvedTextStrategy
        if (!isVerifiedDynamicText) {
          const dynamicVariable = /^[A-Za-z_$][\w$]*$/.test(match.args.trim())
          issues.push(dynamicVariable && match.method === 'getByText' && approvedTextStrategy
            ? `${locator.path} uses ${expression} outside a locator method that accepts and returns the expected text. Define a method with a string parameter and return this.page.getByText(theSameParameter); do not put a data-driven locator in a readonly field.`
            : `${locator.path} contains unverified locator ${expression}. New locators must match Playwright CLI snapshot evidence or an indexed framework locator exactly.`)
        }
      }
    }
  }

  return [...new Set(issues)]
}

/** A frame wrapper may be generated when its child control locator is observed exactly. */
export function isObservedLocatorExpression(expression: string, allowed: Set<string>): boolean {
  if (allowed.has(expression) || [...allowed].some((observed) => observed.startsWith(`${expression}.`))) return true
  if (!expression.includes('frameLocator(')) return false
  const details = locatorCallDetails(expression)
  if (!details || details.method === 'frameLocator') return false
  const observedLeaf = normalizeLocatorExpression(`${details.method}(${details.args})`)
  return allowed.has(observedLeaf)
}

function normalizeLocatorExpression(expression: string): string {
  const source = expression.trim()
    .replace(/;\s*$/, '')
    .replace(/^(?:(?:this\.)?page\.)/, '')
    .replace(/locator\(([^()]*)\)\s*\.\s*contentFrame\s*\(\s*\)/g, 'frameLocator($1)')
  let normalized = ''
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!
    if (char === "'" || char === '"' || char === '`') {
      let value = ''
      const quote = char
      index++
      for (; index < source.length; index++) {
        const current = source[index]!
        if (current === '\\' && index + 1 < source.length) {
          const escaped = source[++index]!
          value += escaped === quote || escaped === '\\' ? escaped : `\\${escaped}`
          continue
        }
        if (current === quote) break
        value += current
      }
      normalized += JSON.stringify(value)
      continue
    }
    if (/\s/.test(char)) continue
    if (char === ',') {
      let next = index + 1
      while (next < source.length && /\s/.test(source[next]!)) next++
      if (/[}\])]/.test(source[next] ?? '')) continue
    }
    normalized += char
  }
  return normalized
}

/**
 * Convert common direct Playwright page interactions into the framework's Actions
 * facade when the exact locator already exists in that page's paired locator file.
 * This conservative repair never creates a selector or changes locator evidence.
 */
function rewriteDirectPageActions(
  changes: FileChange[],
  actionMethods: FrameworkAnalysisResult['facts']['actionMethods'],
): FileChange[] {
  const knownMethods = new Set(actionMethods.flatMap((method) => [
    method.name,
    method.facadeNamespace ? `${method.facadeNamespace}.${method.name}` : '',
  ]).filter(Boolean))
  const hasAction = (name: string): boolean =>
    knownMethods.has(name) || knownMethods.has(`Actions.${name}`)

  return changes.map((page) => {
    if (!/^pages\/.+\.page\.tsx?$/i.test(page.path) || !page.newContent) return page
    const locatorPath = page.path.replace(/\.page\.tsx?$/i, '.locators.ts')
    const locatorFile = changes.find((change) => change.path === locatorPath)
    const locatorSource = locatorFile?.newContent ?? ''
    if (!locatorSource) return page

    const locatorFields = [...locatorSource.matchAll(
      /^\s*readonly\s+([A-Za-z_$][\w$]*)\s*=\s*this\.page\.(getByRole|getByLabel|getByText|getByPlaceholder|getByTestId|locator)\(([^\r\n]*)\)\s*;?\s*$/gm,
    )].map((match) => ({
      name: match[1]!,
      expression: `this.page.${match[2]}(${match[3]})`,
    }))
    if (locatorFields.length === 0) return page

    let source = page.newContent
    const directCall = /this\.page\.(getByRole|getByLabel|getByText|getByPlaceholder|getByTestId|locator)\(([^\r\n]*)\)\.(click|fill|check|uncheck|hover|isVisible)\(([^\r\n]*)\)/g
    source = source.replace(directCall, (full, locatorMethod: string, locatorArgs: string, action: string, actionArgs: string) => {
      const expression = `this.page.${locatorMethod}(${locatorArgs})`
      const field = locatorFields.find((candidate) =>
        normalizeLocatorExpression(candidate.expression) === normalizeLocatorExpression(expression),
      )
      if (!field) return full

      const args = actionArgs.trim()
      const simpleSignature = action === 'fill' ? args.length > 0 && !args.includes(',') : args.length === 0
      if (!simpleSignature || !hasAction(action)) return full
      return `this.actions.${action}(this.locators.${field.name}${args ? `, ${args}` : ''})`
    })

    if (hasAction('navigate') || hasAction('browser.navigate')) {
      source = source.replace(/this\.page\.goto\(([^\r\n]*)\)/g, (_full, args: string) => {
        const url = args.split(',')[0]?.trim()
        if (!url) return _full
        return `this.actions.browser.navigate(${url})`
      })
    }

    return source === page.newContent ? page : { ...page, newContent: source }
  })
}

/** Propose a bounded repair using actual validation output and applied source files. */
export async function generateRepairChanges(options: {
  task: TaskRecord
  repositoryRoot: string
  config?: Partial<ProviderConfig>
  vscodeLmBridge?: VscodeLmBridge
  /** Fresh browser observations from Playwright MCP, when a locator failure was replayed. */
  browserEvidence?: string[]
  signal?: AbortSignal
}): Promise<FileChange[]> {
  const attempts = options.task.repairAttempts ?? 0
  if (attempts >= 2) throw new Error('The repair limit (2 proposals) has been reached for this task.')
  if (!options.task.validation || options.task.validation.passed) {
    throw new Error('A repair proposal requires a failed validation report.')
  }
  if (options.task.appliedChanges.length === 0) {
    throw new Error('No applied source files are recorded for this task; there is nothing safe to repair.')
  }

  for (const path of options.task.appliedChanges) {
    const resolved = new Workspace(options.repositoryRoot).tryResolve(path)
    if (!resolved || !existsSync(resolved.resolved)) throw new Error(`Applied source file is missing or outside the repository: ${path}`)
    const expected = options.task.appliedFileFingerprints?.[resolved.relative]
    if (!expected || fingerprint(readFileSync(resolved.resolved, 'utf-8')) !== expected) {
      throw new Error(`Applied source changed since TestPilot last wrote it: ${resolved.relative}. Re-validate and re-plan before repair.`)
    }
  }

  const workspace = new Workspace(options.repositoryRoot)
  const sourceBlocks = options.task.appliedChanges.flatMap((path) => {
    const resolved = workspace.tryResolve(path)
    if (!resolved || !existsSync(resolved.resolved)) return []
    const source = readFileSync(resolved.resolved, 'utf-8').slice(0, 24000)
    return [`SOURCE ${resolved.relative}\n\`\`\`typescript\n${source}\n\`\`\``]
  })
  if (sourceBlocks.length === 0) throw new Error('Could not read any applied source files for a grounded repair.')

  const config = buildConfig(options.config ?? {}, options.repositoryRoot)
  const provider = getProvider(config, { vscodeLmBridge: options.vscodeLmBridge })
  const info = await provider.check()
  if (!info.available) throw new Error(`Repair provider is unavailable: ${info.unavailableReason ?? 'unknown reason'}`)
  const model = await provider.selectDefault()
  const checks = options.task.validation.checks
    .filter((check) => !check.passed)
    .map((check) => `${check.kind}: ${check.detail.slice(0, 5000)}`)
    .join('\n\n')
  const evidence = options.task.validation.failureAnalysis
  const response = await provider.chat([
    {
      role: 'system',
      content: 'You propose a minimal repair to existing TypeScript files. Use only the exact supplied validation output and Playwright MCP snapshot evidence. For a locator change, use an exact locator expression present in the MCP observations or in the existing source. Never remove or weaken assertions, never invent framework APIs, and never create additional files. Return only one fenced TypeScript block per changed existing path, formatted as ```typescript path/to/file.ts followed by the complete replacement file content. If the evidence does not support a safe correction, return no blocks.',
    },
    {
      role: 'user',
      content: [
        `Task: ${options.task.taskId} — ${options.task.title}`,
        `Attempt: ${attempts + 1} of 2`,
        `Failure analysis: ${evidence?.likelyCause ?? 'No deterministic cause identified.'}`,
        `Evidence: ${(evidence?.evidence ?? []).join('\n')}`,
        `Failed checks:\n${checks}`,
        `Playwright MCP observations (fresh snapshots captured while replaying the manual steps):\n${(options.browserEvidence ?? []).join('\n\n') || 'No browser observations were available.'}`,
        `Only these applied files may be changed:\n${options.task.appliedChanges.join('\n')}`,
        `Current source:\n${sourceBlocks.join('\n\n')}`,
      ].join('\n\n'),
    },
  ], { purpose: 'repair', modelId: options.config?.model ?? model?.id, signal: options.signal })

  options.task.modelCalls.push({ provider: info.id, model: response.modelId, at: new Date().toISOString(), purpose: 'repair' })
  const parsed = parseGeneratedFiles(response.text, options.repositoryRoot)
  const allowed = new Set(options.task.appliedChanges.map((path) => workspace.tryResolve(path)?.relative).filter(Boolean))
  const scoped = parsed
    .filter((change) => change.kind === 'modify' && allowed.has(change.path))
    .map((change) => ({
      ...change,
      reason: `Repair proposal ${attempts + 1}/2 grounded in validation output; human review required.`,
      evidence: [
        ...(evidence?.evidence ?? []),
        ...options.task.validation!.checks.filter((check) => !check.passed).map((check) => `${check.kind}: ${check.detail.slice(0, 1000)}`),
      ],
    }))

  const observedExpressions = new Set(
    (options.task.browserLocatorCandidates ?? [])
      .map((candidate) => normalizeLocatorExpression(candidate.expression)),
  )
  for (const change of scoped.filter((item) => /\.locators\.tsx?$/.test(item.path))) {
    const resolved = workspace.tryResolve(change.path)
    if (!resolved) return []
    const before = readFileSync(resolved.resolved, 'utf-8')
    const oldExpressions = new Set(extractLocatorExpressions(before).map(normalizeLocatorExpression))
    const proposedExpressions = extractLocatorExpressions(change.newContent ?? '')
    const newExpressions = proposedExpressions
      .map(normalizeLocatorExpression)
      .filter((expression) => !oldExpressions.has(expression))
    if (newExpressions.some((expression) => !observedExpressions.has(expression))) return []
  }
  return scoped
}

function locatorCallDetails(expression: string): { method: string; args: string } | undefined {
  const calls = [...expression.matchAll(/(?:^|\.)(frameLocator|getByRole|getByLabel|getByText|getByPlaceholder|getByTestId|locator)\s*\(/g)]
  const call = calls.at(-1)
  if (!call) return undefined
  const opening = (call.index ?? 0) + call[0].lastIndexOf('(')
  const closing = matchingParen(expression, opening)
  if (closing < 0) return undefined
  return { method: call[1]!, args: expression.slice(opening + 1, closing) }
}

function extractLocatorExpressions(source: string): string[] {
  const startPattern = /(?:this\.page\.)?(?:frameLocator|getByRole|getByLabel|getByText|getByPlaceholder|getByTestId|locator)\s*\(/g
  const expressions: string[] = []
  let start: RegExpExecArray | null
  let consumedUntil = -1
  while ((start = startPattern.exec(source)) !== null) {
    if (start.index < consumedUntil) continue
    const opening = start.index + start[0].lastIndexOf('(')
    let end = matchingParen(source, opening)
    if (end < 0) continue
    let cursor = end + 1
    while (true) {
      const chainedCall = /^\s*\.\s*(?:contentFrame|frameLocator|nth|getByRole|getByLabel|getByText|getByPlaceholder|getByTestId|locator)\s*\(/.exec(source.slice(cursor))
      if (!chainedCall) break
      const chainOpening = cursor + chainedCall[0].lastIndexOf('(')
      const chainEnd = matchingParen(source, chainOpening)
      if (chainEnd < 0) break
      end = chainEnd
      cursor = chainEnd + 1
    }
    expressions.push(source.slice(start.index, end + 1).trim())
    consumedUntil = end + 1
    startPattern.lastIndex = consumedUntil
  }
  return expressions
}

/** Reattach a frame scope from live evidence when the model split it from the control locator. */
export function rewriteObservedFrameLocators(changes: FileChange[], candidates: VerifiedLocator[]): FileChange[] {
  const frameCandidates = new Map<string, Set<string>>()
  const observedControlLocators: { expression: string; role: string; name: string }[] = []
  for (const candidate of candidates) {
    const expression = extractLocatorExpressions(candidate.expression)[0]
    if (!expression) continue
    const normalized = normalizeLocatorExpression(expression)
    const details = locatorCallDetails(expression)
    if (!details || details.method === 'frameLocator') continue
    const metadata = candidate.role && candidate.name
      ? { role: candidate.role, name: candidate.name }
      : locatorRoleAndName(expression)
    if (!metadata) continue
    observedControlLocators.push({ expression, ...metadata })
    if (!normalized.includes('frameLocator(')) continue
    const leaf = normalizeLocatorExpression(`${details.method}(${details.args})`)
    const matches = frameCandidates.get(leaf) ?? new Set<string>()
    matches.add(expression)
    frameCandidates.set(leaf, matches)
  }
  if (observedControlLocators.length === 0) return changes

  return changes.map((change) => {
    if (!/\.locators\.tsx?$/i.test(change.path) || !change.newContent) return change
    let source = change.newContent.replace(
      /^(\s*readonly\s+[A-Za-z_$][\w$]*\s*=\s*)([^;\r\n]+)(;?\s*)$/gm,
      (line, prefix: string, current: string, suffix: string) => {
        const currentExpression = extractLocatorExpressions(current)[0]
        if (!currentExpression) return line
        const normalizedCurrent = normalizeLocatorExpression(currentExpression)
        const details = locatorCallDetails(currentExpression)
        if (!details || details.method === 'frameLocator') return line
        const currentFrameScope = locatorFrameScope(currentExpression)
        const leaf = normalizeLocatorExpression(`${details.method}(${details.args})`)
        const observed = frameCandidates.get(leaf)
        const exact = observed?.size === 1 ? [...observed][0] : undefined
        if (exact && normalizeLocatorExpression(exact) === normalizedCurrent) return line

        const generated = locatorRoleAndName(currentExpression)
        if (!generated) return line
        const unique = new Map<string, { expression: string; role: string; name: string }>()
        for (const candidate of observedControlLocators) {
          unique.set(normalizeLocatorExpression(candidate.expression), candidate)
        }
        const ranked = [...unique.values()]
          .filter((candidate) => candidate.role === generated.role)
          .map((candidate) => {
            const candidateFrameScope = locatorFrameScope(candidate.expression)
            const sameFrame = currentFrameScope !== undefined && candidateFrameScope !== undefined &&
              normalizeLocatorExpression(candidateFrameScope) === normalizeLocatorExpression(currentFrameScope)
            const unscopedControl = candidateFrameScope === undefined
            return {
              candidate,
              sameFrame,
              unscopedControl,
              score: textMatchScore(normalizeWords(candidate.name), normalizeWords(generated.name)),
            }
          })
          .filter((item) => item.score >= 0.8)
          .sort((left, right) =>
            Number(right.sameFrame) - Number(left.sameFrame) ||
            Number(right.unscopedControl) - Number(left.unscopedControl) ||
            right.score - left.score,
          )
        if (!ranked[0] || (ranked[1] && ranked[0].sameFrame === ranked[1].sameFrame &&
            ranked[0].unscopedControl === ranked[1].unscopedControl && ranked[0].score - ranked[1].score < 0.15)) return line

        const selected = ranked[0]
        let scopedExpression: string
        if (selected.sameFrame || !selected.unscopedControl || !currentFrameScope) {
          scopedExpression = selected.candidate.expression.replace(/^(?:(?:this\.)?page\.)/, '')
        } else {
          // Keep the model's iframe wrapper when browser evidence verified the
          // child role/name but the backend did not expose a frame-scoped ref.
          const observedLeaf = selected.candidate.expression.replace(/^(?:(?:this\.)?page\.)/, '')
          scopedExpression = `${currentFrameScope}.${observedLeaf}`.replace(/^(?:(?:this\.)?page\.)/, '')
        }
        return `${prefix}this.page.${scopedExpression}${suffix}`
      },
    )
    source = source.replace(
      /^\s*readonly\s+([A-Za-z_$][\w$]*)\s*=\s*this\.page\.locator\(\s*(['"`])iframe(?:\[[^\r\n]*?)?\2\s*\)\s*;?\s*\r?\n/gm,
      (line, field: string) => {
        const identifier = new RegExp(`\\b${field}\\b`, 'g')
        return identifier.test(source.replace(line, '')) ? line : ''
      },
    )
    return source === change.newContent
      ? change
      : {
          ...change,
          newContent: source,
          reason: `${change.reason ?? ''} Reattached a uniquely observed iframe scope to its matching locator.`.trim(),
          evidence: [...(change.evidence ?? []), 'The element role and accessible name matched one iframe-scoped Playwright snapshot locator.'],
        }
  })
}

function locatorRoleAndName(expression: string): { role: string; name: string } | undefined {
  const details = locatorCallDetails(expression)
  if (!details || details.method !== 'getByRole') return undefined
  const match = details.args.match(/^\s*(['"])(.*?)\1\s*,\s*\{\s*name\s*:\s*(['"])((?:\\.|(?!\3)[\s\S])*)\3/)
  if (!match) return undefined
  const decode = (quote: string, value: string): string => {
    if (quote === '"') {
      try { return JSON.parse(`"${value}"`) as string } catch { return value }
    }
    return value.replace(/\\(['"\\])/g, '$1')
  }
  return { role: decode(match[1]!, match[2]!), name: decode(match[3]!, match[4]!) }
}

function locatorFrameScope(expression: string): string | undefined {
  const details = locatorCallDetails(expression)
  if (!details || details.method === 'frameLocator') return undefined
  const methodCall = new RegExp(`\\s*\\.\\s*${details.method}\\s*\\(`, 'g')
  let match: RegExpExecArray | null
  let lastCallIndex = -1
  while ((match = methodCall.exec(expression)) !== null) lastCallIndex = match.index
  if (lastCallIndex < 0) return undefined
  const scope = expression.slice(0, lastCallIndex).trim()
  return /(?:frameLocator\(|\.\s*contentFrame\s*\()/.test(scope) ? scope : undefined
}

function matchingParen(source: string, opening: number): number {
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = opening; index < source.length; index++) {
    const char = source[index]!
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '(') depth++
    else if (char === ')' && --depth === 0) return index
  }
  return -1
}

/**
 * Parse the provider's fenced blocks into file changes.
 *
 * Tolerates the common path prefixes and reports anything it had to guess,
 * rather than silently accepting an unparseable response.
 */
export function parseGeneratedFiles(
  text: string,
  repositoryRoot: string,
  options: { defaultSpecPath?: string } = {},
): FileChange[] {
  const workspace = new Workspace(repositoryRoot)
  const changes: FileChange[] = []
  const blockPattern = /```([^\r\n`]*)\r?\n([\s\S]*?)```/g

  let match: RegExpExecArray | null
  while ((match = blockPattern.exec(text)) !== null) {
    const info = match[1]!.trim()
    let content = match[2]!

    // Copilot commonly puts the path in the fence header, but may instead put
    // it on a `// path/to/file.ts` line inside an otherwise normal TS fence.
    const headerPath = info.match(/(?:^|\s)(?:file:\s*)?["']?((?:[A-Za-z]:[\\/])?[^\s"'`]+\.tsx?)["']?\s*$/i)?.[1]
    const firstLine = content.match(/^\s*(?:(?:\/\/|#)\s*)?(?:file:\s*)?([^\r\n]+\.tsx?)\s*\r?\n/i)
    const bodyPath = firstLine?.[1]?.trim().replace(/^["']|["']$/g, '')
    if (bodyPath) content = content.slice(firstLine![0].length)

    const rawPath = headerPath ?? bodyPath ?? (
      options.defaultSpecPath && /\btest\s*\(/.test(content)
        ? options.defaultSpecPath
        : undefined
    )
    if (!rawPath) continue

    // Strip a leading label when the model wrote "path: filename" on its own line.
    const cleanedPath = rawPath.trim()
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      // Some Copilot models combine the language and file path as
      // ```typescript:tests/example.spec.ts; the language is fence metadata,
      // not part of the repository path.
      .replace(/^(?:(?:typescript|tsx|ts|javascript|jsx|js)\s*:\s*)/i, '')
      .replace(/^file:\s*/i, '')

    const resolved = workspace.tryResolve(cleanedPath)
    if (!resolved) {
      continue
    }

    changes.push({
      path: resolved.relative,
      kind: existsSync(join(workspace.rootPath, resolved.relative)) ? 'modify' : 'create',
      newContent: content.endsWith('\n') ? content : `${content}\n`,
      reason: 'Generated from the approved plan; each step mapped to indexed framework symbols.',
      evidence: ['Plan approved by the user before generation was requested.'],
    })
  }

  return changes
}

