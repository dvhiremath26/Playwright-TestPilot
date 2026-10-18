/**
 * Plain-text adapter.
 *
 * Accepts free-form numbered lists (1. ...  2. ...), blank-line separated
 * paragraphs, and pipe-delimited |test data| on any line.
 *
 * Every step produced includes a verbatim provenance record so the reviewer can
 * see exactly which source line it came from.
 */

import type {
  TestCaseIssue,
  TestCaseMetadata,
  TestCaseNormalizationResult,
  TestCaseSourceInfo,
  TestCaseStep,
} from '@tcoe/shared-types'

import { TestCaseAdapter, normaliseAction, parsePriority, extractKeys } from './abstract-adapter.ts'

const NUMBERED_STEP = /^\s*(\d+)[.)]\s+(.+)$/
const SECTION_HEADER = /^(?:precondition|pre-?cond|given|setup)[:\s]/i
const TITLE_MARKER = /^(?:title|case|test)[:\s*]+(.+)$/i

interface StepEvidence {
  sourceLine: number
  verbatim: string
}

export class TextTestCaseAdapter extends TestCaseAdapter {
  constructor() {
    super('txt')
  }

  /**
   * Plain text identifies itself by numbered steps, or by an explicit section
   * heading.
   *
   * A lone block of prose with neither is not a test case — refusing it here
   * is what stops a blank input coming back as a fabricated case with zero
   * steps.
   */
  override supports(raw: string): boolean {
    const lines = raw.split('\n')
    return (
      lines.some((line) => NUMBERED_STEP.test(line.trim())) ||
      lines.some((line) => SECTION_HEADER.test(line.trim()))
    )
  }

  async parse(
    raw: string,
    options?: { permissive?: boolean },
  ): Promise<TestCaseNormalizationResult> {
    const lines = raw.split('\n')
    const issues: TestCaseIssue[] = []

    let title = ''
    const metadata: TestCaseMetadata = { tags: [] }
    let preconditionBlock = ''
    const steps: Array<TestCaseStep & { _evidence: StepEvidence }> = []
    let mode: 'title' | 'precondition' | 'steps' = 'title'
    let stepIndex = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const trimmed = line.trim()
      if (!trimmed) {
        if (mode === 'precondition') {
          // blank line ends the precondition block
          mode = 'steps'
        }
        continue
      }

      // Title line — first non-empty, non-step line.
      if (mode === 'title' && !NUMBERED_STEP.test(trimmed) && !SECTION_HEADER.test(trimmed)) {
        const titleMatch = TITLE_MARKER.exec(trimmed)
        if (titleMatch) {
          title = titleMatch[1]!.trim()
        } else {
          title = trimmed
        }
        const keys = extractKeys(trimmed)
        if (keys.length) metadata.tags = [...new Set([...metadata.tags, ...keys.map((k) => `@${k}`)])]
        const pri = trimmed.match(/priority[:\s]+(\w+)/i)?.[1]
        if (pri) metadata.priority = parsePriority(pri)
        mode = 'steps'
        continue
      }

      // Section divider — switch mode.
      if (SECTION_HEADER.test(trimmed)) {
        mode = 'precondition'
        preconditionBlock += trimmed.replace(SECTION_HEADER, '') + ' '
        continue
      }

      // Precondition continuation.
      if (mode === 'precondition') {
        preconditionBlock += trimmed + ' '
        continue
      }

      // Numbered step.
      const stepMatch = NUMBERED_STEP.exec(trimmed)
      if (stepMatch) {
        stepIndex++
        const num = parseInt(stepMatch[1]!, 10)
        if (num !== stepIndex) {
          issues.push({
            severity: 'warning',
            field: `steps[${stepIndex - 1}]`,
            message: `Step numbers are non-consecutive: expected ${stepIndex}, found ${num}. Step text preserved.`,
          })
        }

        // An expected result may be written inline on the step line, as in
        // "1. Click Login → expected: The dashboard is shown".
        const rawText = stepMatch[2]!
        const { text: withoutExpected, expected } = splitExpected(rawText)
        const { action, testData } = normaliseAction(withoutExpected)

        steps.push({
          order: stepIndex,
          action,
          expectedResult: expected ? canonicaliseExpected(expected) : undefined,
          testData: testData as TestCaseStep['testData'],
          _evidence: { sourceLine: i + 1, verbatim: trimmed },
        })
        continue
      }

      // Continuation of the previous step (indented or unrecognised).
      if (steps.length > 0) {
        const prev = steps[steps.length - 1]!
        const { action, testData } = normaliseAction(trimmed)
        const asExpected = trimmed.match(/^(?:→|=>|=)?\s*(?:expected|verify|ensure|result)\s*[:\s]+(.+)$/i)
        if (asExpected) {
          // Tagged expected result line
          prev.expectedResult = canonicaliseExpected(asExpected[1])
        } else if (!trimmed.startsWith('#') && !trimmed.startsWith('//')) {
          // Append as a continuation of the action text
          prev.action += ' ' + action
        }
        if (testData && !prev.testData) {
          prev.testData = testData as TestCaseStep['testData']
        }
        continue
      }

      // Unrecognised, non-step line that isn't anything above.
      if (!trimmed.startsWith('#')) {
        issues.push({
          severity: 'warning',
          field: 'unknown',
          message: `Line ${i + 1} was not recognised as part of a structured test case: "${trimmed.slice(0, 60)}".`,
          suggestion: 'Start steps with a number followed by a period or closing parenthesis, e.g. "1. Click OK".',
        })
      }
    }

    // No title and no steps means the input was empty, not merely untitled.
    // This is an error regardless of permissive mode: a title can be guessed
    // for, but a document with nothing in it cannot be turned into a case.
    if (!title && steps.length === 0) {
      issues.push({
        severity: 'error',
        field: 'source',
        message: 'The input contained no title and no steps.',
        suggestion: 'Provide at least one numbered step, e.g. "1. Click Login".',
      })
      return { testCase: null, issues }
    }

    // If we never found a title
    if (!title) {
      if (options?.permissive) {
        title = deriveFallbackTitle(steps.map((step) => step.action))
        issues.push({
          severity: 'warning',
          field: 'title',
          message: `No title found; using "${title}" as a generated title.`,
          suggestion: 'Start the document with a title on its own line to choose a specific title.',
        })
      } else {
        issues.push({ severity: 'error', field: 'title', message: 'No title found in the text input.' })
      }
    }

    const testCase =
      title && (options?.permissive || issues.every((i) => i.severity === 'warning'))
        ? {
            metadata,
            title,
            description: undefined,
            preconditions: preconditionBlock.trim() ? [preconditionBlock.trim()] : [],
            steps: steps.map(({ _evidence: _e, ...s }) => s),
            testData: {},
            source: {
              kind: 'txt',
              reference: 'inline text',
              ambiguous: steps.length === 0,
              assumptions: [],
            } satisfies TestCaseSourceInfo,
          }
        : null

    return { testCase: testCase ?? null, issues }
  }
}

/** Give a title-less numbered case a stable, readable title instead of a placeholder. */
function deriveFallbackTitle(actions: string[]): string {
  const firstUrl = actions.map((action) => action.match(/https?:\/\/[^\s)]+/i)?.[0]).find(Boolean)
  if (firstUrl) {
    try {
      const host = new URL(firstUrl).hostname
        .replace(/^www\./i, '')
        .split('.')[0]!
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase())
      if (host) return `${host} manual test`
    } catch {
      // Fall back to a stable generic title for malformed URLs.
    }
  }
  return `Manual test case (${actions.length} steps)`
}

/**
 * Split an inline expected result off a step line.
 *
 * Accepts "Click Login → expected: The dashboard is shown" and the same with
 * "=>" or "=", and a bare "Click Login → The dashboard is shown".
 */
function splitExpected(raw: string): { text: string; expected?: string } {
  const marker = /(?:\s*(?:→|=>)\s*(?:expected\s*:?)?|\s+(?:expected|result)\s*[:\s]\s*|\s+=\s*)/i
  const m = marker.exec(raw)
  if (!m || m.index === undefined) return { text: raw }
  return {
    text: raw.slice(0, m.index).trimEnd(),
    expected: raw.slice(m.index + m[0].length).trim(),
  }
}

function canonicaliseExpected(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const cleaned = raw
    .replace(/^(expected[:\s]*|verify[:\s]*|ensure[:\s]*)/i, '')
    .trim()
  return cleaned.length > 0 ? cleaned : undefined
}
