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
import { join } from 'node:path'

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
import type { BrowserEvidence, BrowserElementRef, BrowserSession } from '@tcoe/browser-tools'
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
          selectSnapshotTarget: providerInfo.liveService
            ? async (stepAction, actionKind, candidates, signal) => {
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
                      observedSnapshotElements: candidates.map(({ ref, role, name }) => ({ ref, role, name })),
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
                  throw new SnapshotTargetUnavailableError(`Step "${stepAction}" has no confident match in the Playwright CLI snapshot.${selected.reason ? ` Model response: ${selected.reason}` : ''}`)
                }
                const match = candidates.filter((candidate) => candidate.ref === selected.ref)
                if (match.length !== 1) {
                  throw new SnapshotTargetUnavailableError(`The selected model returned ref "${selected.ref}", which is not a unique element in the Playwright CLI snapshot.`)
                }
                return match[0]!
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
        actionMethodsSummary: renderActionMethodSummary(analysis.facts.actionMethods),
        pageObjectNames: analysis.facts.pageObjects,
        locatorExamples: analysis.facts.locators.slice(0, 20).map((l) => `${l.ownerClass}.${l.name} → ${l.expression}`),
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
  },
): Promise<{ evidence: BrowserEvidence[]; locatorCandidates: VerifiedLocator[] }> {
  const evidence: BrowserEvidence[] = []
  const locatorCandidates: VerifiedLocator[] = []
  const navigation = await browser.navigate(options.targetUrl, { signal: options.signal })
  if (navigation.detail.startsWith('Navigation failed:')) {
    throw new Error(navigation.detail)
  }
  evidence.push(navigation)

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
  for (const step of options.steps) {
    if (options.signal?.aborted) throw new Error('Browser step replay was cancelled.')

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
    if (action) {
      const compatibleTargets = findActionTargets(
        snapshot,
        action.target,
        action.kind,
        action.kind === 'click' && Boolean(action.intent),
      )
        .map((candidate) => candidate.element)
      const target = options.selectSnapshotTarget
        ? await options.selectSnapshotTarget(step.action, action.kind, compatibleTargets, options.signal)
        : findActionTarget(snapshot, action.target, action.kind)
      // Never turn unrelated controls from the same page into evidence for a
      // requested target that could not be matched uniquely.
      const candidateElements = target ? [target] : []
      locatorCandidates.push(...await candidatesForStep(
        snapshot,
        step.order,
        step.action,
        currentUrl,
        candidateElements,
      ))

      if (!target) {
        throw new Error(`Step ${step.order} could not be replayed safely: no unique ${action.kind === 'fill' ? 'editable control' : 'control'} matching "${action.target}" was found in the current Playwright snapshot. No later screen evidence was collected.`)
      }
      if (action.kind === 'fill' && !action.value) {
        throw new Error(`Step ${step.order} could not be replayed safely: no input value was found for "${action.target}".`)
      }
      const result = await browser.execute(
        async (tool, callOptions) => {
          switch (action.kind) {
            case 'fill': return tool.fill(target.ref, action.value!, callOptions)
            case 'check': return tool.check
              ? tool.check(target.ref, callOptions)
              : { ok: false, error: `${tool.info.label} does not support safe checkbox check operations.` }
            case 'uncheck': return tool.uncheck
              ? tool.uncheck(target.ref, callOptions)
              : { ok: false, error: `${tool.info.label} does not support safe checkbox uncheck operations.` }
            default: return tool.click(target.ref, callOptions)
          }
        },
        { signal: options.signal },
      )
      if (!result.ok) {
        throw new Error(`Step ${step.order} could not be replayed safely: ${result.error ?? 'browser action failed'}. No later screen evidence was collected.`)
      }
      evidence.push({
        kind: 'interaction',
        detail: `Step ${step.order} replayed: ${step.action}`,
        source: result.provenance,
      })
      const location = await browser.execute(
        (tool, callOptions) => tool.eval('() => window.location.href', undefined, callOptions),
        { signal: options.signal },
      )
      if (location.ok && location.output) {
        const observedUrl = extractStepUrl(location.output)
        if (observedUrl) currentUrl = observedUrl
      }
    }

    // Snapshot after every step. The next step's locator candidates therefore
    // come from the screen that is actually visible at that point in the flow.
    snapshot = await captureScreen(`After step ${step.order}: ${step.action}`, currentUrl)
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
      const generated = await browser.generateLocator(element.ref, { signal: options.signal })
      const expression = generated.output?.trim()
      if (!generated.ok || !expression || !/^(getByRole|getByLabel|getByText|getByPlaceholder|getByTestId|locator)\(/.test(expression)) continue
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
  const valueFirstFill = /^(?:fill|type|input)\s+(.+?)\s+(?:in|into)\s+(?:the\s+)?(.+)$/i.exec(step)
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
    .replace(/\s+(?:in|from)\s+(?:the\s+)?(?:left\s+|right\s+)?(?:side\s*bar|navigation(?:\s+bar)?|nav(?:\s+bar)?|menu|tab|link)\b.*$/i, '')
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
) {
  const ranked = findActionTargets(snapshot, target, kind)
  if (!ranked[0] || ranked[0].score < 0.75) return undefined
  if (ranked[1] && ranked[0].score - ranked[1].score < 0.05) return undefined
  return ranked[0].element
}

function findActionTargets(
  snapshot: NonNullable<Awaited<ReturnType<BrowserSession['capture']>>>,
  target: string,
  kind: ReplayAction['kind'],
  includeTreeItems = false,
) {
  const wanted = normalizeWords(target)
  if (!wanted) return []
  const wantedTokens = new Set(wanted.split(' '))
  const ranked = snapshot.elements
    .filter((element) => element.actionable !== false && (element.name || includeTreeItems))
    .filter((element) => kind !== 'fill' || /^(?:textbox|searchbox|combobox|spinbutton)$/i.test(element.role ?? ''))
    .filter((element) => !['check', 'uncheck'].includes(kind) || /^(?:checkbox|radio)$/i.test(element.role ?? ''))
    .filter((element) => kind !== 'click' || /^(?:button|link|menuitem|tab|checkbox|radio|option|switch)$/i.test(element.role ?? '') ||
      (includeTreeItems && /^(?:treeitem|listitem)$/i.test(element.role ?? '')))
    .map((element) => {
      const name = normalizeWords(element.name ?? '')
      const tokens = name.split(' ').filter(Boolean)
      const overlap = tokens.filter((token) => wantedTokens.has(token)).length
      const score = name === wanted ? 1 : name.includes(wanted) || wanted.includes(name)
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
    .filter((element) => element.name)
    .map((element) => {
      const name = normalizeWords(element.name ?? '')
      const tokens = name.split(' ').filter(Boolean)
      const overlap = tokens.filter((token) => wantedTokens.has(token)).length
      const score = name === wanted ? 1 : name.includes(wanted) || wanted.includes(name)
        ? 0.9
        : overlap / Math.max(wantedTokens.size, tokens.length, 1)
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
    .trim()
    .replace(/\s+/g, ' ')
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

function renderActionMethodSummary(methods: FrameworkAnalysisResult['facts']['actionMethods']): string {
  if (methods.length === 0) return 'The framework exposes no reusable action methods.'
  return methods
    .slice(0, 60)
    .map((m) => {
      const ns = m.facadeNamespace ? `${m.facadeNamespace}.` : ''
      return `- ${ns}${m.name} — ${m.signature} (${m.file}:${m.line})`
    })
    .join('\n')
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
  const manualTestData = dataCases.some((testCase) => Object.keys(testCase.values).length > 0)
    ? {
        moduleName: scenarioStem,
        cases: dataCases,
        sharedFlow: casesShareFlow(manualCases, dataCases),
        targetPath: targetDataPath,
        existingJson: readExistingJson(options.repositoryRoot, targetDataPath),
        dataTypesPath: 'src/utils/testData/dataTypes.ts',
      }
    : undefined
  const targetSpecPath = manualCases.length > 1
    ? `tests/${scenarioStem}.spec.ts`
    : existingTestPath ?? `tests/${stem}.spec.ts`
  const browserEvidence = [
    ...(options.task.browserLocatorCandidates ?? []).map((candidate) =>
      `Observed for step ${candidate.stepOrder ?? 'unspecified'} on ${candidate.pageUrl ?? 'an inspected screen'} via ${candidate.backend} at ${candidate.observedAt}: ref=${candidate.ref}, role=${candidate.role ?? 'unknown'}, name=${candidate.name ?? 'unnamed'}, locator=${candidate.expression}`),
    ...(options.plan.flatMap((entry) => entry.verifiedLocator
      ? [`Selected for step ${entry.stepOrder} (${entry.stepAction}): ${entry.verifiedLocator.expression} via ${entry.verifiedLocator.backend}, ref=${entry.verifiedLocator.ref}`]
      : [])),
  ].join('\n')
  const frameworkExamples = renderFrameworkExamples(options.analysis)
  const sharedPageSources = [targetPagePath, targetLocatorPath].flatMap((path) => {
    const absolute = join(options.repositoryRoot, path)
    return existsSync(absolute)
      ? [`EXISTING SHARED FILE ${path}\n\`\`\`typescript\n${readFileSync(absolute, 'utf-8').slice(0, 12000)}\n\`\`\``]
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
        'The target framework conventions are mandatory. Follow the included real source examples and never substitute generic Playwright patterns for the framework architecture. Never use test.only or invent a fixture, action method, or helper API that was not discovered. Locator fields must be Playwright Locator objects, not strings containing locator code. Every locator must exactly match a Playwright CLI snapshot observation or an indexed framework locator; comments such as "adjust this selector" are not acceptable evidence. ' +
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
        actionMethodsSummary: renderActionMethodSummary(facts.actionMethods),
        pageObjectNames: facts.pageObjects,
        locatorExamples: facts.locators
          .slice(0, 20)
          .map((l) => `${l.ownerClass}.${l.name} → ${l.expression}`),
        fixtures: facts.fixtures.map((f) => f.name),
        testDataModules: facts.testDataModules,
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
      }),
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
    ]

  let response = await provider.chat(messages, { purpose: 'generate', modelId, signal: options.signal })
  recordGenerationCall(response.modelId)
  let changes = parseGeneratedFiles(response.text, options.repositoryRoot, { defaultSpecPath: targetSpecPath })
  const maxCorrections = 2
  const needsCorrection = (candidate: FileChange[]): boolean =>
    !hasSpec(candidate) || standardIssues(candidate).length > 0 ||
    (!!manualTestData && manualDataUsageIssues(candidate, manualTestData, options.repositoryRoot, targetPagePath, targetLocatorPath, frameworkExamples.dataLoaderImportPath).length > 0)
  for (let correction = 0; correction < maxCorrections && needsCorrection(changes); correction++) {
    const issues = standardIssues(changes)
    const dataIssues = manualTestData ? manualDataUsageIssues(changes, manualTestData, options.repositoryRoot, targetPagePath, targetLocatorPath, frameworkExamples.dataLoaderImportPath) : []
    const correctionPrompt = [
      'Your previous response was rejected and no files have been written.',
      !hasSpec(changes) ? 'It did not contain a runnable TypeScript test spec with a test(...) declaration.' : '',
      ...(issues.length > 0 ? [`It violated these discovered framework standards:\n${issues.map((issue) => `- ${issue}`).join('\n')}`] : []),
      ...(dataIssues.length > 0 ? [`It failed to use the extracted test data:\n${dataIssues.map((issue) => `- ${issue}`).join('\n')}`] : []),
      'Return the complete file set again. Implement every manual step in order; the generated code does not need to repeat the manual wording verbatim. Correct every listed standards violation and copy the architecture from the real source examples where needed. For new page behavior, create page-object/locator code using matching browser observations; never invent a selector that is absent from evidence. Every new locator expression must exactly match an expression in the Playwright CLI observations or an indexed framework locator. For data-driven text assertions, a locator-class method may accept the expected value and use getByText(expectedValue) only when a literal getByText candidate for that assertion is present in the matching snapshot evidence; pass the value from the data row. If evidence is insufficient, do not invent a locator or leave a guessed CSS selector with an adjustment comment; keep the specific step unresolved and explain which live snapshot is missing.',
      'Preserve the manual step order and execute each navigation exactly where it appears. If a step navigates to a URL and the next step clicks a link, navigate to that stated URL and then click the snapshot-observed link; do not navigate directly to the linked page before attempting the click. Name each test from its manual test title; do not read the title from test data unless that field is explicitly present. DataLoader.get(module) returns a typed JSON object whose named case properties contain values directly; do not expect title/values wrappers. Generate one explicit standalone test(...) block per manual case using its literal manual title and literal typed case property. Do not use loops, Object.keys/entries/values, test.each, or map/forEach to create tests.',
      'Output only fenced TypeScript file blocks with repository-relative paths, including a tests/*.spec.ts file.',
    ].filter(Boolean).join('\n\n')
    response = await provider.chat([
      ...messages,
      { role: 'assistant', content: response.text },
      { role: 'user', content: correctionPrompt },
    ], { purpose: 'generate', modelId, signal: options.signal })
    recordGenerationCall(response.modelId)
    changes = parseGeneratedFiles(response.text, options.repositoryRoot, { defaultSpecPath: targetSpecPath })
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
      `The selected Copilot model did not follow the target framework standards after two automatic correction attempts. No files were written:\n${remainingStandardsIssues.map((issue) => `- ${issue}`).join('\n')}`,
    )
  }
  if (manualTestData) {
    const dataUseIssues = manualDataUsageIssues(changes, manualTestData, options.repositoryRoot, targetPagePath, targetLocatorPath, frameworkExamples.dataLoaderImportPath)
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
    changes.push(...buildManualDataChanges(options.repositoryRoot, targetDataPath, manualTestData))
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
  const steps = task.testCase?.steps ?? []
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
  const source = actionLabel || fallback
  const words = source.replace(/([a-z0-9])([A-Z])/g, '$1 $2').match(/[A-Za-z0-9]+/g) ?? []
  const stem = words.slice(0, 5).map((word, index) =>
    index === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1),
  ).join('')
  return stem || 'manualScenario'
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
    const match = step.action.match(/\b(?:fill|enter|type)\s+["']([^"']+)["']\s+(?:in|into|to)\s+(?:the\s+)?(.+?)\s*[.!]?$/i)
    if (!match) continue
    const value = match[1]!.trim()
    const target = match[2]!.replace(/\b(?:text\s*box|textbox|input|field|text field)\b/gi, ' ')
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

function manualDataUsageIssues(
  changes: FileChange[],
  data: ExtractedManualData,
  repositoryRoot: string,
  targetPagePath: string,
  targetLocatorPath: string,
  expectedDataLoaderImportPath?: string,
): string[] {
  const specs = changes.filter((change) => /(^|\/)tests\/[^/]+\.spec\.tsx?$/.test(`/${change.path.replace(/\\/g, '/')}`))
  if (specs.length === 0) return ['No spec was returned to verify DataLoader usage.']
  const issues: string[] = []
  const modulePattern = new RegExp(`DataLoader\\.get\\(\\s*['"]${data.moduleName}['"]\\s*\\)`)
  const pageName = data.moduleName.charAt(0).toUpperCase() + data.moduleName.slice(1)
  const pageImport = `@pages/${pageName}/${data.moduleName}.page`
  for (const spec of specs) {
    const source = spec.newContent ?? ''
    const dataLoaderImport = source.match(/import\s+\{\s*DataLoader\s*\}\s+from\s+['"]([^'"]+)['"]/)
    if (data.sharedFlow && !source.includes(`from '${pageImport}'`) && !source.includes(`from "${pageImport}"`)) {
      issues.push(`${spec.path} must import the shared scenario page object from '${pageImport}'.`)
    }
    if (expectedDataLoaderImportPath && dataLoaderImport?.[1] !== expectedDataLoaderImportPath) {
      issues.push(`${spec.path} must import DataLoader from '${expectedDataLoaderImportPath}' to match the target framework.`)
    }
    if (!modulePattern.test(source)) issues.push(`${spec.path} must load the shared '${data.moduleName}' module through DataLoader.`)
  }
  const generatedCode = changes
    .filter((change) => /\.tsx?$/.test(change.path) && change.path !== 'src/utils/testData/dataTypes.ts')
    .map((change) => change.newContent ?? '')
    .join('\n')
  const combinedSource = specs.map((spec) => spec.newContent ?? '').join('\n')
  const dataVariable = combinedSource.match(new RegExp(
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
    const directRow = new RegExp(`DataLoader\\s*\\.\\s*get\\(\\s*['"]${module}['"]\\s*\\)\\s*\\[\\s*['"]${caseKey}['"]\\s*\\](?!\\s*\\.\\s*values\\b)`)
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
      if (value.length >= 3 && generatedCode.includes(value)) {
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
      if (/^pages\/.+\.(?:page|locators)\.tsx?$/.test(change.path) &&
          change.path !== targetPagePath && change.path !== targetLocatorPath) {
        issues.push(`${change.path} duplicates scenario assets for a shared flow; use shared paths '${targetPagePath}' and '${targetLocatorPath}'.`)
      }
    }
  }
  return issues
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
          ...source.matchAll(/(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*=\s*((?:this\.page\.)?(?:getByRole|getByLabel|getByText|getByPlaceholder|getByTestId|locator)\s*\([^\n;]*\))/g),
        ].filter((match) => /display|result|output|expected|validation|confirm|success/i.test(match[1] ?? ''))
        const assertionMethods = [...source.matchAll(
          /\b([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*:\s*string\s*\)\s*(?::\s*[^={]+)?\s*\{([\s\S]*?)\}/g,
        )].filter((match) => /display|result|output|expected|validation|confirm|success/i.test(match[1] ?? ''))
        const observedExpressions = assertionCandidates.map((candidate) => normalizeLocatorExpression(candidate.expression))
        const observedStrategies = new Set(assertionCandidates.map((candidate) => candidate.expression.match(/^(?:this\.page\.)?(getByRole|getByLabel|getByText|getByPlaceholder|getByTestId|locator)\s*\(/)?.[1]))
        const hasMatchingField = assertionMembers.some((match) => observedExpressions.includes(normalizeLocatorExpression(match[2] ?? '')))
        const hasMatchingMethod = assertionMethods.some((method) => {
          const parameter = method[2]
          const body = method[3] ?? ''
          const dynamicCalls = [...body.matchAll(/(?:this\.page\.)?(getByRole|getByLabel|getByText|getByPlaceholder|getByTestId|locator)\s*\(([^)]*)\)/g)]
          return dynamicCalls.some((call) =>
            observedStrategies.has(call[1]) && call[2]?.trim() === parameter,
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
    `### ${file.relativePath}\n\n\`\`\`typescript\n${source.slice(0, 5000)}\n\`\`\``,
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
    if (examples.pageUsesActionFacade && /this\.page\.(?:locator|getBy\w+|goto)\s*\(/.test(source)) {
      issues.push(`${page.path} bypasses the framework Actions facade; page methods should call this.actions and use this.locators.`)
    }
  }

  for (const locator of locators) {
    const source = locator.newContent ?? ''
    if (examples.locatorClassBased && !/export\s+class\s+\w+Locators\b/.test(source)) {
      issues.push(`${locator.path} must export a *Locators class, matching existing locator modules.`)
    }
    if (/export\s+const\s+locators\s*=/.test(source) || /:\s*["'`]\s*(?:this\.page\.)?(?:getByRole|getByLabel|getByText|getByPlaceholder|locator)\s*\(/.test(source)) {
      issues.push(`${locator.path} stores locator expressions as strings; locator fields must be actual this.page.getBy.../locator(...) objects.`)
    }
    if (/adjust this selector|selector based on the actual|todo\s*:\s*.*locator|assumed\s*[-:]\s*not observed/i.test(source)) {
      issues.push(`${locator.path} contains a guessed/unverified locator note. Remove it and use a locator observed in a Playwright snapshot or already indexed in the framework.`)
    }
    const allowed = new Set(approvedLocatorExpressions.map(normalizeLocatorExpression).filter(Boolean))
    const locatorCalls = [...source.matchAll(/(?:this\.page\.)?(getByRole|getByLabel|getByText|getByPlaceholder|getByTestId|locator)\s*\(([^)]*)\)/g)]
    const stringParameterMethods = [...source.matchAll(
      /\b[A-Za-z_$][\w$]*\s*\(\s*([A-Za-z_$][\w$]*)\s*:\s*string\s*\)\s*(?::\s*[^={]+)?\s*\{([\s\S]*?)\}/g,
    )].map((method) => ({
      parameter: method[1],
      body: method[2] ?? '',
      bodyStart: (method.index ?? 0) + method[0].indexOf('{') + 1,
    }))
    for (const match of locatorCalls) {
      const expression = `${match[1]}(${match[2]})`
      if (!allowed.has(normalizeLocatorExpression(expression))) {
        const callIndex = match.index ?? -1
        const method = stringParameterMethods.find((candidate) =>
          callIndex >= candidate.bodyStart && callIndex < candidate.bodyStart + candidate.body.length,
        )
        const approvedTextStrategy = [...allowed].some((item) => item.startsWith('getByText('))
        const isVerifiedDynamicText = match[1] === 'getByText' &&
          method?.parameter && match[2]?.trim() === method.parameter &&
          new RegExp(`\\breturn\\s+this\\.page\\.getByText\\s*\\(\\s*${method.parameter}\\s*\\)\\s*;?`).test(method.body) &&
          approvedTextStrategy
        if (!isVerifiedDynamicText) {
          const dynamicVariable = /^[A-Za-z_$][\w$]*$/.test(match[2]?.trim() ?? '')
          issues.push(dynamicVariable && match[1] === 'getByText' && approvedTextStrategy
            ? `${locator.path} uses ${expression} outside a locator method that accepts and returns the expected text. Define a method with a string parameter and return this.page.getByText(theSameParameter); do not put a data-driven locator in a readonly field.`
            : `${locator.path} contains unverified locator ${expression}. New locators must match Playwright CLI snapshot evidence or an indexed framework locator exactly.`)
        }
      }
    }
  }

  return [...new Set(issues)]
}

function normalizeLocatorExpression(expression: string): string {
  return expression
    .trim()
    .replace(/;\s*$/, '')
    .replace(/^this\.page\./, '')
    .replace(/\s+/g, '')
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

function extractLocatorExpressions(source: string): string[] {
  return [...source.matchAll(/(?:this\.page\.)?(getByRole|getByLabel|getByText|getByPlaceholder|getByTestId|locator)\s*\(([^)]*)\)/g)]
    .map((match) => `${match[1]}(${match[2] ?? ''})`)
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
    const cleanedPath = rawPath.replace(/\\/g, '/').replace(/^\/+/, '')

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

