/**
 * Normalized manual test case representation.
 *
 * Every input adapter (TXT, Markdown, Excel, Jira, pasted text) must produce
 * this shape. It is the single contract the rest of the agent consumes.
 */

/** Where a manual test case came from. */
export type TestCaseSourceKind = 'txt' | 'markdown' | 'excel' | 'jira' | 'pasted' | 'inline'

/** Priority values as normally written in test-management tools. */
export type TestCasePriority = 'critical' | 'high' | 'medium' | 'low'

export interface TestCaseStep {
  /** 1-based position of the step. */
  order: number
  /** The action to perform. */
  action: string
  /** Expected result for this step, when supplied. */
  expectedResult?: string
  /** Explicit test data for this step, when supplied. */
  testData?: string
}

export interface TestCaseMetadata {
  /** Case identifier such as "TC-001". Absent when the source has none. */
  testCaseId?: string
  /** Jira issue key such as "PROJ-123". */
  jiraKey?: string
  /** Xray test key such as "TPA-5". */
  xrayKey?: string
  /** Application the case targets, e.g. "Sales Order Management". */
  application?: string
  /** Free-text business context. */
  businessContext?: string
  priority?: TestCasePriority
  tags: string[]
}

export interface TestCase {
  metadata: TestCaseMetadata
  title: string
  description?: string
  preconditions: string[]
  steps: TestCaseStep[]
  /** Global test data not tied to a single step. */
  testData: Record<string, unknown>
  source: TestCaseSourceInfo
}

export interface TestCaseSourceInfo {
  kind: TestCaseSourceKind
  /** Display name of the origin, e.g. a file path or Jira key. */
  reference: string
  /** True when the adapter had to guess any structural detail. */
  ambiguous?: boolean
  /** What the adapter guessed, so a human can correct it. */
  assumptions: string[]
}

/**
 * A problem found while normalizing a test case.
 *
 * These are actionable, never swallowed: the agent must either ask a
 * clarification question or fail the task with these messages.
 */
export interface TestCaseIssue {
  severity: 'error' | 'warning'
  /** Which step or field is affected, if any. */
  field: string
  message: string
  /** Suggested resolution the user can apply. */
  suggestion?: string
}

/**
 * The result of normalizing raw input into a {@link TestCase}.
 *
 * `testCase` is null when the input could not be normalized at all.
 * `issues` is populated for warnings even when `testCase` is present.
 */
export interface TestCaseNormalizationResult {
  testCase: TestCase | null
  issues: TestCaseIssue[]
}

export function hasBlockingIssues(issues: TestCaseIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error')
}
