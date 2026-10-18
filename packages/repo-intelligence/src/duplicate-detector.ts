/**
 * Duplicate test detection.
 *
 * Compares an incoming manual test case against every indexed test in the
 * framework and produces ranked {@link DuplicateFinding} entries with concrete
 * evidence — never a bare similarity number.
 *
 * Fully deterministic. No model calls.
 */

import type {
  DuplicateFinding,
  DuplicateVerdict,
  FrameworkFacts,
  IndexedTest,
  TestCase,
} from '@tcoe/shared-types'

/** Split text into comparable tokens. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t))
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'should',
  'shall', 'will', 'then', 'when', 'after', 'before', 'user', 'test',
])

/** Jaccard similarity of two token sets. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection++
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/** Longest common subsequence length ratio over two token arrays. */
function lcsRatio(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const rows = a.length + 1
  const cols = b.length + 1
  const dp: number[] = new Array<number>(rows * cols).fill(0)

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const ai = a[i - 1]!
      const bj = b[j - 1]!
      dp[i * cols + j] =
        ai === bj
          ? dp[(i - 1) * cols + (j - 1)]! + 1
          : Math.max(dp[(i - 1) * cols + j]!, dp[i * cols + (j - 1)]!)
    }
  }
  return dp[rows * cols - 1]! / Math.max(a.length, b.length)
}

/** Normalise an Xray key for comparison: "tpa-5" === "TPA-5". */
function normaliseKey(key: string | undefined): string | undefined {
  if (!key) return undefined
  return key.toUpperCase().trim()
}

function verdictFor(similarity: number, sharedXray: boolean, distinctOutcomes: boolean): DuplicateVerdict {
  if (sharedXray && similarity >= 0.6) return 'exact-duplicate'
  if (similarity >= 0.75) return 'exact-duplicate'
  if (similarity >= 0.55) return 'likely-duplicate'
  if (similarity >= 0.35) {
    return distinctOutcomes ? 'shared-workflow-different-outcome' : 'related-but-different'
  }
  return 'no-overlap'
}

/**
 * Compare one manual test case against all indexed tests.
 *
 * Returns findings sorted by similarity, highest first. Only findings with a
 * verdict other than 'no-overlap' are returned, so callers can present the
 * result without filtering noise.
 */
export function detectDuplicates(testCase: TestCase, facts: FrameworkFacts): DuplicateFinding[] {
  const incomingTokens = new Set(tokenize(testCase.title))
  const incomingSteps = testCase.steps.map((s) => s.action)
  const incomingXray = normaliseKey(testCase.metadata.xrayKey)
  const incomingOutcomes = new Set(
    testCase.steps.map((s) => s.expectedResult).filter((e): e is string => Boolean(e)).map((e) => tokenize(e).join(' ')),
  )

  const findings: DuplicateFinding[] = []

  for (const existing of facts.tests) {
    const existingTokens = new Set(tokenize(existing.title))
    const titleSimilarity = jaccard(incomingTokens, existingTokens)

    const existingSteps = existing.referencedSymbols.length
      ? []
      : tokenize(existing.title)
    const stepSimilarity =
      existingSteps.length > 0
        ? lcsRatio(incomingSteps.map((s) => tokenize(s).join(' ')).filter(Boolean), existingSteps)
        : 0

    // Title similarity is the primary signal; step similarity supplements it.
    const combined = titleSimilarity * 0.6 + stepSimilarity * 0.4

    const existingXray = normaliseKey(existing.xrayKey)
    const sharedXray = Boolean(incomingXray && existingXray && incomingXray === existingXray)

    // Do the existing and incoming tests assert different outcomes?
    const existingOutcomes = new Set(
      existing.fullTitle.split(/\s+/).map((w) => w.toLowerCase()).filter((w) => w.length > 3),
    )
    const distinctOutcomes =
      incomingOutcomes.size > 0 &&
      [...incomingOutcomes].some((outcome) => !existingOutcomes.has(outcome))

    const verdict = verdictFor(combined, sharedXray, distinctOutcomes)
    if (verdict === 'no-overlap') continue

    const evidence: string[] = []
    if (sharedXray) {
      evidence.push(`Both tests carry the same Xray key (${incomingXray}).`)
    }
    const sharedTokens = [...incomingTokens].filter((t) => existingTokens.has(t))
    if (sharedTokens.length > 0) {
      evidence.push(`Titles share ${sharedTokens.length} distinctive term(s): ${sharedTokens.slice(0, 8).join(', ')}.`)
    }
    if (stepSimilarity > 0.2) {
      evidence.push(`Step sequences are ${(stepSimilarity * 100).toFixed(0)}% similar by longest-common-subsequence over step text.`)
    }
    if (distinctOutcomes && verdict === 'shared-workflow-different-outcome') {
      evidence.push('The two tests drive the same workflow but assert different expected outcomes.')
    }

    const recommendation =
      verdict === 'exact-duplicate'
        ? 'Treat this as an existing test — update it rather than creating a new one.'
        : verdict === 'likely-duplicate'
          ? 'Review the existing test before creating a new one; it may already cover this case.'
          : verdict === 'shared-workflow-different-outcome'
            ? 'Extend the existing test with the additional scenario rather than duplicating the workflow.'
            : 'Related but not a duplicate — a new test is appropriate.'

    findings.push({
      verdict,
      existingTest: {
        title: existing.title,
        file: existing.file,
        line: existing.line,
        xrayKey: existing.xrayKey,
      },
      evidence,
      similarity: Math.round(combined * 100) / 100,
      recommendation,
    })
  }

  return findings.sort((a, b) => b.similarity - a.similarity)
}