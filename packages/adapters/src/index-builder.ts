/**
 * Adapter registry — the single entry point for adapter discovery.
 *
 * All adapters register themselves here. Callers use `resolve(kind)` to get
 * the right adapter for any input.  The registry also exposes `detect(raw)`
 * which tries each text adapter in order until one succeeds, falling back to
 * 'pasted' for completely unrecognised content.
 */

import type { TestCaseNormalizationResult } from '@tcoe/shared-types'

import { TestCaseAdapter } from './abstract-adapter.ts'
import { ExcelTestCaseAdapter } from './excel.ts'
import { JiraTestCaseAdapter } from './jira.ts'
import { MarkdownTestCaseAdapter } from './markdown.ts'
import { TextTestCaseAdapter } from './text.ts'

export type AdapterKind = 'txt' | 'markdown' | 'excel' | 'jira' | 'pasted'

interface AdapterEntry {
  kind: AdapterKind
  adapter: TestCaseAdapter
  /** Higher score = try first. */
  priority: number
}

const adapters: AdapterEntry[] = [
  { kind: 'jira', adapter: new JiraTestCaseAdapter(), priority: 10 },
  { kind: 'markdown', adapter: new MarkdownTestCaseAdapter(), priority: 8 },
  // Spreadsheet headers are often valid Markdown table text; let the
  // header-aware adapter claim those inputs before the general Markdown parser.
  { kind: 'excel', adapter: new ExcelTestCaseAdapter(), priority: 9 },
  { kind: 'txt', adapter: new TextTestCaseAdapter(), priority: 5 },
]

/** All registered adapter kinds. */
export const registeredKinds: AdapterKind[] = adapters.map((a) => a.kind)

/** Get the adapter for a known kind. */
export function resolve(kind: AdapterKind): TestCaseAdapter {
  const entry = adapters.find((a) => a.kind === kind)
  if (!entry) throw new Error(`Unknown adapter kind: ${kind}`)
  return entry.adapter
}

/**
 * Attempt to detect the best-fit adapter for unknown input.
 *
 * Tries adapters in priority order. Returns 'pasted' if none succeed.
 */
export async function detect(raw: string): Promise<{
  kind: 'pasted' | AdapterKind
  result: TestCaseNormalizationResult
}> {
  // Sort by priority descending.
  const sorted = [...adapters].sort((a, b) => b.priority - a.priority)

  // Collect every adapter that positively identifies this input first, then
  // parse among those. Parsing an adapter that does NOT claim the format before
  // knowing whether any adapter does is what lets the first greedy parser win
  // everything — Jira "parses" arbitrary prose as an issue with no description,
  // and Markdown falls back to a synthesized title.
  const candidates = sorted.filter((entry) => entry.adapter.supports(raw))
  const pool = candidates.length > 0 ? candidates : sorted

  for (const entry of pool) {
    const result = await entry.adapter.parse(raw, { permissive: true })
    if (result.testCase !== null) {
      return { kind: entry.kind, result }
    }
  }

  return {
    kind: 'pasted',
    result: {
      testCase: null,
      issues: [
        {
          severity: 'error',
          field: 'source',
          message: 'Input could not be parsed as a known test case format (TXT, Markdown, Excel/CSV, or Jira).',
          suggestion: 'Provide structured test case content in one of the supported formats.',
        },
      ],
    },
  }
}
