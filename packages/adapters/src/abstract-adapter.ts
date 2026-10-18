/**
 * Test case adapter base class.
 *
 * Every adapter normalises raw input into the shared {@link TestCase} contract.
 * This class provides the common normalisation pipeline so subclasses only need to
 * implement format-specific parsing.
 */

import type {
  TestCase,
  TestCaseIssue,
  TestCaseMetadata,
  TestCaseNormalizationResult,
  TestCaseSourceKind,
  TestCaseSourceInfo,
  TestCaseStep,
} from '@tcoe/shared-types'

export interface AdapterParseOptions {
  /** When true the adapter should return partial results with uncertainties rather than failing. */
  permissive?: boolean
}

export interface AdapterParseResult {
  testCase: TestCase | null
  issues: TestCaseIssue[]
}

/** Shared evidence shape so each adapter records provenance consistently. */
export interface StepEvidence {
  source: 'text' | 'cell' | 'field' | 'description'
  /** Step index in the source (0-based). */
  stepIndex: number
  /** Human-readable origin for logging. */
  origin: string
}

/** Subclasses emit these events during parse(). */
export interface AdapterParseEvents {
  onStep?: (step: TestCaseStep, evidence: StepEvidence) => void
  onIssue?: (issue: TestCaseIssue) => void
}

/**
 * Normalises action text and extracts the optional |test data| marker.
 *
 *   "Fill the username field | admin_user |"
 *   → action: "Fill the username field", testData: "admin_user"
 *
 * Returns the cleaned action text and detected test data.
 */
export function normaliseAction(raw: string): { action: string; testData?: string } {
  // The trailing pipe is optional. SAP Xray writes `|test data| value |`, but
  // `| value` at the end of a line is just as common in hand-written cases.
  const pipeMatch = raw.match(/^(.+?)\s*\|\s*([^|]+?)\s*\|?$/)
  if (pipeMatch) {
    return { action: pipeMatch[1]!.trim(), testData: pipeMatch[2]!.trim() }
  }
  return { action: raw.trim() }
}

/**
 * Splits a free-text precondition block into individual precondition strings.
 *
 * Handles numbered lists, bullets, and plain paragraphs.
 */
export function splitPreconditions(raw: string): string[] {
  return raw
    .split(/\n/)
    .map((l) => l.replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
    .filter((l) => l.length > 0)
}

/**
 * Canonicalises a step's expectedResult: removes common prefixes like
 * "Expected:", "Verify:", "Ensure:" so only the meaningful content remains.
 */
export function canonicaliseExpected(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const cleaned = raw
    .replace(/^(expected[:\s]*|verify[:\s]*|ensure[:\s]*|then[:\s]*|result[:\s]*)/i, '')
    .trim()
  return cleaned.length > 0 ? cleaned : undefined
}

/**
 * Extracts priority from free text.
 */
export function parsePriority(raw: string | undefined): TestCaseMetadata['priority'] {
  if (!raw) return undefined
  const low = raw.toLowerCase()
  if (low.includes('critical') || low.includes('p0') || low.includes('p1')) return 'critical'
  if (low.includes('high') || low.includes('p2')) return 'high'
  if (low.includes('medium') || low.includes('p3')) return 'medium'
  if (low.includes('low') || low.includes('p4')) return 'low'
  return undefined
}

/**
 * Extracts Jira/Xray-style keys: PROJ-123, XRAY-456, TPA-5, @PROJ-123, etc.
 */
export function extractKeys(raw: string): string[] {
  const keys: string[] = []
  // Unadorned: PROJ-123
  for (const m of raw.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g)) {
    keys.push(m[1]!)
  }
  // @-prefixed: @PROJ-123
  for (const m of raw.matchAll(/@([A-Z][A-Z0-9]+-\d+)/g)) {
    const k = m[1]!
    if (!keys.includes(k)) keys.push(k)
  }
  return keys
}

export abstract class TestCaseAdapter {
  protected readonly sourceKind: TestCaseSourceKind

  constructor(sourceKind: TestCaseSourceKind) {
    this.sourceKind = sourceKind
  }

  /**
   * Parse raw input into a normalised test case.
   * Returns null only when the input is structurally unrecognisable.
   */
  abstract parse(
    raw: string,
    options?: AdapterParseOptions,
  ): Promise<TestCaseNormalizationResult>

  /**
   * True when the input looks like this adapter's format.
   *
   * Detection is only trusted for adapters that return true here. The other
   * adapters are greedy — the Jira one, in particular, will "parse" arbitrary
   * prose as a Jira issue — so letting them win a detection vote would make
   * every input resolve to the wrong format.
   */
  supports(raw: string): boolean {
    return true
  }

  protected buildResult(result: AdapterParseResult): TestCaseNormalizationResult {
    return {
      testCase: result.testCase,
      issues: result.issues,
    }
  }

  /**
   * Builds a minimally valid TestCase so the agent can still reason about it
   * when the input is partial or ambiguous.  Only used in permissive mode.
   */
  protected minimalCase(
    title: string,
    sourceInfo: TestCaseSourceInfo,
    issues: TestCaseIssue[],
  ): TestCase {
    return {
      metadata: {
        tags: [],
      },
      title,
      preconditions: [],
      steps: [],
      testData: {},
      source: sourceInfo,
    }
  }

  /**
   * Shared post-processing applied by all adapters before returning.
   *
   * - Strips empty steps.
   * - Assigns sequential `order` numbers starting at 1.
   * - Copies test data at step level into the top-level `testData` object
   *   when no top-level key exists yet.
   */
  protected normaliseSteps(
    steps: TestCaseStep[],
    testData: Record<string, unknown>,
  ): { steps: TestCaseStep[]; issues: TestCaseIssue[] } {
    const issues: TestCaseIssue[] = []
    let order = 1
    const kept: TestCaseStep[] = []

    for (const step of steps) {
      if (!step.action && !step.expectedResult) {
        issues.push({
          severity: 'warning',
          field: `steps[${order - 1}]`,
          message: `Step ${order} has no action text — skipped.`,
        })
        continue
      }

      const cleaned: TestCaseStep = {
        order,
        action: step.action.trim(),
        expectedResult: canonicaliseExpected(step.expectedResult?.trim()),
        testData: step.testData,
      }

      if (step.testData && !testData['stepData']) {
        testData['stepData'] = step.testData
      }

      kept.push(cleaned)
      order++
    }

    return { steps: kept, issues }
  }
}
