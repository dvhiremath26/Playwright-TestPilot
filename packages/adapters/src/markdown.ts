/**
 * Markdown adapter.
 *
 * Handles:
 * - Document title (# Title)
 * - ## Steps / ### Steps sections
 * - Numbered list items  (1. ...)
 * - Bulleted list items   (- ...)
 * - Pipe |test data| on any step line
 * - XRAY / Jira keys anywhere in the document (PROJ-123, @PROJ-123, etc.)
 * - @tag style labels
 * - Metadata tables (| Field | Value | ...)
 * - Blockquote expected results ( > expected: ... )
 */

import type {
  TestCaseIssue,
  TestCaseMetadata,
  TestCaseNormalizationResult,
  TestCaseSourceInfo,
  TestCaseStep,
} from '@tcoe/shared-types'

import { TestCaseAdapter, normaliseAction, parsePriority, extractKeys } from './abstract-adapter.ts'

const STEPS_HEADER = /^(?:##|###)\s+(?:steps|precondition|pre-?cond|test steps|test steps?)/i
const TITLE = /^#{1}\s+(.+)$/
const XRAY_KEY = /\b(XRAY-\d+|PROJ-\d+|TPA-\d+|JIRA-\d+|BC-\d+|LPD-\d+)\b/gi
const AT_TAG = /@([A-Z][A-Z0-9]*-[1-9]\d*)/g

function collectKeys(text: string): string[] {
  const keys = new Set<string>()
  for (const m of text.matchAll(XRAY_KEY)) keys.add(m[1]!)
  for (const m of text.matchAll(AT_TAG)) keys.add(m[1]!)
  return [...keys]
}

function extractPriorityFromTable(lines: string[]): TestCaseMetadata['priority'] {
  for (const line of lines) {
    const m = line.match(/\|\s*priority\s*\|\s*(\w+)\s*/i)
    if (m) return parsePriority(m[1]) ?? undefined
  }
  return undefined
}

export class MarkdownTestCaseAdapter extends TestCaseAdapter {
  constructor() {
    super('markdown')
  }

  /**
   * Markdown test cases are distinguished by ATX headings. The Jira adapter
   * would otherwise grab this input, since a `# Heading` line looks like
   * nothing special to it.
   */
  override supports(raw: string): boolean {
    return raw.split('\n').some((line) => /^#{1,6}\s+/.test(line.trim()))
  }

  async parse(
    raw: string,
    options?: { permissive?: boolean },
  ): Promise<TestCaseNormalizationResult> {
    const issues: TestCaseIssue[] = []
    const lines = raw.split('\n')
    const allText = lines.join('\n')

    // --- Document-level metadata
    const docKeys = collectKeys(allText)
    const metadata: TestCaseMetadata = {
      tags: docKeys.map((k) => `@${k}`),
    }

    let title = ''
    let description = ''
    const preconditions: string[] = []
    const steps: TestCaseStep[] = []
    let inPrecondition = false
    let inSteps = false
    let inTable = false
    let tableBody: string[] = []
    let stepNumber = 0
    let pendingExpected: string | undefined

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const trimmed = line.trim()

      // Title
      const titleMatch = TITLE.exec(trimmed)
      if (titleMatch && !title) {
        title = titleMatch[1]!.trim()
        inSteps = false
        inPrecondition = false
        continue
      }

      // Steps section header
      if (STEPS_HEADER.test(trimmed)) {
        inSteps = true
        inPrecondition = false
        inTable = false
        continue
      }

      // Precondition header
      if (/^(?:##|###)\s+(?:precondition|pre-?cond|given|setup)/i.test(trimmed)) {
        inPrecondition = true
        inSteps = false
        inTable = false
        continue
      }

      // Other ## headings reset context
      if (/^#{2,}\s+/.test(trimmed) && !STEPS_HEADER.test(trimmed) && !/^#{2,}\s+(?:precondition|pre-?cond)/i.test(trimmed)) {
        inSteps = false
        inPrecondition = false
        inTable = false
        continue
      }

      // `|test data| value` attaches to the current step. This must be
      // checked before the table branch: it also starts with a pipe.
      const testDataMatch = trimmed.match(/^\|\s*test\s*data\s*\|\s*([^|]+?)\s*\|?\s*$/i)
      if (testDataMatch) {
        const last = steps[steps.length - 1]
        if (last) {
          last.testData = testDataMatch[1]!.trim() as TestCaseStep['testData']
        } else {
          issues.push({
            severity: 'warning',
            field: 'testData',
            message: 'A |test data| value appeared before any step; it was not attached.',
            suggestion: 'Place the |test data| line directly under the step it belongs to.',
          })
        }
        pendingExpected = undefined
        continue
      }

      // Metadata table
      if (trimmed.startsWith('|') && !trimmed.match(/^\|\s*[-:]+\s*\|/)) {
        if (!inTable) {
          inTable = true
          tableBody = []
        }
        tableBody.push(trimmed)
        metadata.priority = metadata.priority ?? extractPriorityFromTable(tableBody)
        continue
      }

      inTable = false

      // Empty line
      if (!trimmed) {
        inPrecondition = false
        inSteps = false
        pendingExpected = undefined
        continue
      }

      // Bulleted item
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        const content = trimmed.slice(2)
        if (inSteps) {
          this.addStep(content, ++stepNumber, issues, steps, pendingExpected)
          pendingExpected = undefined
        } else if (inPrecondition) {
          preconditions.push(content)
        }
        continue
      }

      // Numbered list item
      const numMatch = trimmed.match(/^\d+[.)]\s+(.+)$/)
      if (numMatch) {
        if (inSteps) {
          this.addStep(numMatch[1]!, ++stepNumber, issues, steps, pendingExpected)
          pendingExpected = undefined
        } else if (inPrecondition) {
          preconditions.push(numMatch[1]!)
        } else {
          // Step outside a ## Steps section — promote it
          this.addStep(numMatch[1]!, ++stepNumber, issues, steps, pendingExpected)
          pendingExpected = undefined
        }
        continue
      }

      // Blockquote — could be an expected result
      if (trimmed.startsWith('>')) {
        const content = trimmed.replace(/^>\s*/, '')
        if (/^(?:expected|verify|ensure|result)[:\s]/i.test(content)) {
          pendingExpected = content.replace(/^(?:expected|verify|ensure|result)[:\s]*/i, '').trim()
        } else {
          // Free-text blockquote treated as description
          description += (description ? ' ' : '') + content
        }
        continue
      }

      // Plain paragraph
      if (inSteps) {
        this.addStep(trimmed, ++stepNumber, issues, steps, pendingExpected)
        pendingExpected = undefined
      } else if (inPrecondition) {
        preconditions.push(trimmed)
      } else if (!trimmed.startsWith('```') && !trimmed.startsWith('<!--')) {
        description += (description ? '\n' : '') + trimmed
      }
    }

    // A document with neither a title nor a single step is not a test case at all.
    // This holds in permissive mode too — a title can be substituted, an empty
    // document cannot.
    if (!title && steps.length === 0) {
      issues.push({
        severity: 'error',
        field: 'title',
        message: 'No Markdown title (# heading) or steps were found.',
      })
      return { testCase: null, issues }
    }

    if (!title) {
      if (options?.permissive) {
        title = deriveFallbackTitle(steps)
        issues.push({
          severity: 'warning',
          field: 'title',
          message: `No Markdown title found; using "${title}" as a generated title.`,
          suggestion: 'Start the document with a single # Heading to choose a specific title.',
        })
      } else {
        issues.push({ severity: 'error', field: 'title', message: 'No Markdown title (# heading) found.' })
      }
    }

    if (steps.length === 0) {
      issues.push({
        severity: 'warning',
        field: 'steps',
        message: 'No steps were extracted from the Markdown document.',
        suggestion: 'Enclose steps in a ## Steps section with numbered list items (1. ...).',
      })
    }

    const testCase =
      title && (options?.permissive || issues.every((i) => i.severity === 'warning'))
        ? {
            metadata,
            title,
            description: description || undefined,
            preconditions,
            steps,
            testData: {},
            source: {
              kind: 'markdown',
              reference: 'inline markdown',
              ambiguous: steps.length === 0,
              assumptions: [],
            } satisfies TestCaseSourceInfo,
          }
        : null

    return { testCase, issues }
  }

  private addStep(
    raw: string,
    order: number,
    issues: TestCaseIssue[],
    steps: TestCaseStep[],
    pendingExpected: string | undefined,
  ): void {
    const { action, testData } = normaliseAction(raw)
    const step: TestCaseStep = {
      order,
      action,
      expectedResult: pendingExpected,
      testData: testData as TestCaseStep['testData'],
    }
    steps.push(step)
  }
}

/** Give a title-less Markdown case a stable title based on its first URL. */
function deriveFallbackTitle(steps: TestCaseStep[]): string {
  const firstUrl = steps.map((step) => step.action.match(/https?:\/\/[^\s)]+/i)?.[0]).find(Boolean)
  if (firstUrl) {
    try {
      const host = new URL(firstUrl).hostname
        .replace(/^www\./i, '')
        .split('.')[0]!
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase())
      if (host) return `${host} manual test`
    } catch {
      // Fall through to the generic title when a URL is malformed.
    }
  }
  return `Manual test case (${steps.length} steps)`
}
