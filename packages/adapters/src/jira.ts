/**
 * Jira adapter.
 *
 * Parses a single Jira issue (summary, description, status, priority, custom
 * fields) and assembles it into a TestCase.  Handles JQL-style issue-key lists
 * by processing only the first key and warning about the rest.
 *
 * When fields are truncated or the adapter has to guess a structure, it records
 * an explicit uncertainty so the reviewer knows what to verify.
 */

import type {
  TestCaseIssue,
  TestCaseMetadata,
  TestCaseNormalizationResult,
  TestCaseSourceInfo,
  TestCaseStep,
} from '@tcoe/shared-types'

import { TestCaseAdapter, normaliseAction, parsePriority, extractKeys } from './abstract-adapter.ts'

const FIELD_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+)$/
const JQL_LINE = /^[A-Z][A-Z0-9]+-\d+\s*$/i
const XRAY_KEY = /\b(XRAY-\d+|TPA-\d+|PROJ-\d+)\b/gi

const TRUNCATION_MARKERS = ['...', '…']

function isTruncated(value: string): boolean {
  return (
    TRUNCATION_MARKERS.some((m) => value.endsWith(m)) ||
    (value.length < 40 && /[a-z]$/.test(value) && !/[.!?]$/.test(value))
  )
}

function parseFieldLines(text: string): Map<string, { value: string; uncertain: boolean }> {
  const map = new Map<string, { value: string; uncertain: boolean }>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = FIELD_RE.exec(trimmed)
    if (m) {
      map.set(m[1]!.toLowerCase(), { value: m[2]!, uncertain: isTruncated(m[2]!) })
    }
  }
  return map
}

function parseSteps(description: string): { steps: TestCaseStep[]; issues: TestCaseIssue[] } {
  const issues: TestCaseIssue[] = []
  const steps: TestCaseStep[] = []
  let stepNumber = 0
  let pendingExpected: string | undefined

  for (const line of description.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) { pendingExpected = undefined; continue }

    const numMatch = trimmed.match(/^(\d+)[.)]\s+(.+)/)
    if (numMatch) {
      stepNumber++
      const { action, testData } = normaliseAction(numMatch[2]!)
      steps.push({
        order: stepNumber,
        action,
        expectedResult: pendingExpected,
        testData: testData as TestCaseStep['testData'],
      })
      pendingExpected = undefined
      continue
    }

    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      stepNumber++
      const { action, testData } = normaliseAction(trimmed.slice(2))
      steps.push({
        order: stepNumber,
        action,
        expectedResult: pendingExpected,
        testData: testData as TestCaseStep['testData'],
      })
      pendingExpected = undefined
      continue
    }

    if (/^(?:→|=>)\s*(.+)/.test(trimmed)) {
      pendingExpected = trimmed.replace(/^(?:→|=>)\s*/, '').trim()
      continue
    }
    if (/^expected[:\s]/i.test(trimmed)) {
      pendingExpected = trimmed.replace(/^expected[:\s]*/i, '').trim()
    }
  }

  if (steps.length === 0 && description.trim().length > 0) {
    issues.push({
      severity: 'warning',
      field: 'steps',
      message: 'The description contains no numbered or bulleted steps.',
      suggestion: 'Format steps as numbered items (1. ...) or bullets (- ...).',
    })
  }

  return { steps, issues }
}

export class JiraTestCaseAdapter extends TestCaseAdapter {
  constructor() {
    super('jira')
  }

  /**
   * A Jira issue export identifies itself with field lines (`Summary:`,
   * `Description:`, `Status:`).
   *
   * Requiring at least two of them, or a Jira issue key, is deliberate: a
   * single field-looking line cannot be told apart from ordinary prose, and
   * this adapter is greedy enough to otherwise claim any plain-text test case
   * as a Jira issue with an empty description. Detection would then never
   * reach the adapter that was written for the input.
   */
  override supports(raw: string): boolean {
    const lines = raw.split('\n').map((line) => line.trim())
    const fieldLine = /^(?:summary|description|status|priority|application|component|project)\s*:/i
    const fieldCount = lines.filter((line) => fieldLine.test(line)).length
    return fieldCount >= 2 || lines.some((line) => JQL_LINE.test(line))
  }

  async parse(
    raw: string,
    options?: { permissive?: boolean },
  ): Promise<TestCaseNormalizationResult> {
    const issues: TestCaseIssue[] = []
    const lines = raw.trim().split('\n').map((l) => l.trim()).filter(Boolean)

    // Detect JQL-style key list.
    const jqlKeys: string[] = []
    const bodyLines: string[] = []
    for (const line of lines) {
      if (JQL_LINE.test(line)) jqlKeys.push(line.toUpperCase())
      else bodyLines.push(line)
    }

    if (jqlKeys.length > 1) {
      issues.push({
        severity: 'warning',
        field: 'source',
        message: `Multiple Jira keys detected (${jqlKeys.join(', ')}). Only the first will be processed.`,
        suggestion: 'Paste one Jira issue at a time.',
      })
    }

    const jiraKey = jqlKeys[0]

    if (bodyLines.length === 0 && jiraKey) {
      return {
        testCase: {
          metadata: { jiraKey, tags: [`@${jiraKey}`] },
          title: `Jira ${jiraKey}`,
          preconditions: [],
          steps: [],
          testData: {},
          source: {
            kind: 'jira',
            reference: jiraKey,
            ambiguous: true,
            assumptions: [`Issue "${jiraKey}" has no description body.`],
          },
        },
        issues: [
          ...issues,
          { severity: 'warning', field: 'description', message: `Issue "${jiraKey}" has no description.` },
        ],
      }
    }

    const workText = bodyLines.join('\n')
    const fields = parseFieldLines(workText)

    // Summary.
    let summary = ''
    let summaryUncertain = false
    const summaryField = fields.get('summary')
    if (summaryField) {
      summary = summaryField.value
      summaryUncertain = summaryField.uncertain
    } else {
      // Fall back to first non-field line.
      for (const line of bodyLines) {
        if (!FIELD_RE.test(line)) {
          summary = line
          summaryUncertain = isTruncated(line)
          break
        }
      }
    }

    if (!summary) {
      return { testCase: null, issues: [{ severity: 'error', field: 'summary', message: 'No summary found.' }] }
    }

    // Description.
    const descField = fields.get('description')
    const description = descField?.value ?? ''
    if (descField?.uncertain) {
      issues.push({ severity: 'warning', field: 'description', message: 'Description appears truncated.' })
    }

    // Priority.
    const priorityField = fields.get('priority')
    const priority = priorityField ? parsePriority(priorityField.value) : undefined

    // Application / component / project.
    const appField =
      fields.get('application') ?? fields.get('component') ?? fields.get('project')
    const application = appField?.value

    // Xray keys in description.
    const xrayKeys = [...description.matchAll(XRAY_KEY)].map((m) => m[1]!)
    const allKeys = [...(jiraKey ? [jiraKey] : []), ...xrayKeys]

    const { steps, issues: stepIssues } = parseSteps(description)
    issues.push(...stepIssues)

    const assumptions: string[] = []
    if (summaryUncertain) assumptions.push('Summary may be truncated — verify the title is complete.')
    if (!description.trim()) assumptions.push('No description was found.')
    if (steps.length === 0) assumptions.push('No structured steps were found.')

    const testCase: TestCaseNormalizationResult['testCase'] = {
      metadata: {
        tags: allKeys.map((k) => `@${k}`),
        jiraKey,
        xrayKey: xrayKeys[0],
        application,
        priority,
      },
      title: summary,
      description: description || undefined,
      preconditions: [],
      steps,
      testData: {},
      source: {
        kind: 'jira',
        reference: jiraKey ?? summary.slice(0, 40),
        ambiguous: steps.length === 0 || summaryUncertain,
        assumptions,
      } as TestCaseSourceInfo,
    }

    return { testCase, issues }
  }
}
