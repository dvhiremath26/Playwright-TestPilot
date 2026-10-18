/**
 * Reuse analysis.
 *
 * For each step of a manual test case, finds the closest existing framework
 * method, locator, and page object — and states plainly when nothing plausibly
 * matches.
 *
 * Fully deterministic. No model calls. A wrong reuse claim is worse than no
 * claim, so weak matches are returned as low-confidence inference.
 */

import type {
  CandidateLocator,
  CandidateMethod,
  FrameworkFacts,
  IndexedActionMethod,
  IndexedLocator,
  ReuseReport,
  StepReusePlan,
  TestCase,
  TestCaseDecision,
} from '@tcoe/shared-types'

import { detectDuplicates } from './duplicate-detector.ts'

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'should',
  'shall', 'will', 'then', 'when', 'after', 'before', 'user', 'test', 'page',
  'field', 'button', 'value', 'element', 'screen',
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t))
}

/** Split camelCase / PascalCase into lowercase words. */
function splitIdentifier(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0)
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const t of a) if (b.has(t)) intersection++
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/** Words that indicate a weak, generic match we should not claim as reuse. */
const GENERIC_TOKENS = new Set(['click', 'fill', 'type', 'select', 'navigate', 'verify', 'expect', 'open'])

export interface ScoredMethod {
  method: IndexedActionMethod
  score: number
  reason: string
}

/**
 * A manual step and a framework method rarely share words. "Enter the material
 * description" and `textbox.fill` have zero token overlap, so pure lexical
 * matching scores every SAP step at zero. This map carries the intent the
 * author obviously meant, so a method can match on the action it performs.
 */
const INTENT_ALIASES: Record<string, string[]> = {
  // Input verbs. Deliberately no keyboard-key synonyms here — otherwise
  // "Enter the material number" matches both `fill` and `pressEnter`.
  fill: ['enter', 'type', 'input'],
  click: ['select', 'choose', 'tap'],
  press: ['key', 'press'],
  check: ['tick'],
  uncheck: ['untick'],
  checkuncheck: ['toggle', 'check', 'uncheck'],
  select: ['choose', 'pick', 'select', 'option'],
  search: ['filter', 'find', 'search'],
  upload: ['attach', 'upload', 'import', 'file'],
  download: ['export'],
  wait: ['wait', 'pause', 'delay'],
  navigate: ['goto', 'open', 'launch', 'launchpad'],
  expectvisible: ['visible', 'shows', 'displayed', 'appears', 'assert'],
  expecttext: ['text', 'message', 'label', 'display', 'read'],
  expectchecked: ['checked', 'tick'],
  expectenabled: ['enabled', 'clickable', 'active'],
  expectvalue: ['value', 'contains', 'equals', 'matches'],
}

/**
 * Intent matching runs over every segment of the method name, not just the
 * joined lower-case form. Without that, compound methods are never recognised
 * by any intent at all: `pressEnter` yields the segments `press` and `enter`,
 * so `press` would never be tested against its own aliases. Matching segments
 * individually is what lets `checkUncheck` reach the `toggle` alias while still
 * letting a plain `fill` match on `enter`.
 */
function intentScore(stepTokens: string[], methodKeys: string[]): number {
  for (const [intent, aliases] of Object.entries(INTENT_ALIASES)) {
    if (!methodKeys.includes(intent)) continue
    if (stepTokens.some((token) => aliases.some((alias) => token.startsWith(alias)))) return 0.6
  }
  return 0
}

export function scoreMethods(
  stepAction: string,
  stepExpected: string | undefined,
  methods: IndexedActionMethod[],
): ScoredMethod[] {
  const stepTokens = new Set(tokenize(stepAction))
  const expectedTokens = new Set(tokenize(stepExpected ?? ''))
  const allStepTokens = new Set([...stepTokens, ...expectedTokens])

  const scored: ScoredMethod[] = []

  for (const method of methods) {
    const methodNameParts = splitIdentifier(method.name)
    const methodTokens = new Set(methodNameParts.filter((t) => t.length > 2))
    const namespaceTokens = new Set(
      method.facadeNamespace ? splitIdentifier(method.facadeNamespace) : [],
    )
    const classTokens = new Set(splitIdentifier(method.ownerClass).filter((t) => t.length > 2))

    const nameSimilarity = jaccard(stepTokens, methodTokens)
    const namespaceSimilarity = jaccard(stepTokens, namespaceTokens)
    const classSimilarity = jaccard(stepTokens, classTokens)
    const expectedSimilarity = jaccard(expectedTokens, methodTokens)
    // Keys are the joined lower-case name plus each segment, so both
    // `expectVisible` and plain `visible` resolve to their intent.
    const methodKeys = [method.name.toLowerCase(), ...methodNameParts]
    const intent = intentScore([...allStepTokens], methodKeys)

    // Base score: method name is the strongest signal, and intent carries the
    // weight of a name match when the author used different words.
    let score = nameSimilarity * 0.5 + namespaceSimilarity * 0.2 + classSimilarity * 0.15
    if (intent > 0 && intent > nameSimilarity) score += intent * 0.5

    // Parameter agreement — a method taking exactly one string fits "fill X".
    if (method.parameters.length > 0 && method.parameters.length <= 3) {
      score += 0.1
    }

    // Expected-result agreement: "expect visible" should map to expect* methods.
    if (expectedSimilarity > 0.3) score += 0.15

    // Facade methods are directly callable, so they are preferred over group methods.
    if (method.onFacade) score += 0.05

    // Penalise matches that rest only on a generic word. Intent-based matches
    // are exempt — "enter" pointing at `fill` is a real signal, not a generic
    // collision.
    const matchedTokens = [...stepTokens].filter((t) => methodTokens.has(t))
    const onlyGeneric =
      matchedTokens.length > 0 &&
      matchedTokens.every((t) => GENERIC_TOKENS.has(t)) &&
      intent === 0
    if (onlyGeneric) score *= 0.4

    if (score <= 0.05) continue

    // Build a concrete reason from the actual matched tokens.
    const reasonParts: string[] = []
    if (intent > 0) {
      reasonParts.push(`the step's intent maps to method name "${method.name}"`)
    }
    if (nameSimilarity > 0) {
      reasonParts.push(`method name "${method.name}" shares term(s) ${matchedTokens.slice(0, 4).join(', ')} with the step`)
    }
    if (namespaceSimilarity > 0 && method.facadeNamespace) {
      reasonParts.push(`namespace "${method.facadeNamespace}" matches the step vocabulary`)
    }
    if (expectedSimilarity > 0.3) {
      reasonParts.push(`expected result aligns with this method's intent`)
    }
    if (method.parameters.length > 0 && method.parameters.length <= 3) {
      reasonParts.push(`parameter count (${method.parameters.length}) is compatible with the step`)
    }

    scored.push({
      method,
      score: Math.round(Math.min(score, 1) * 100) / 100,
      reason: reasonParts.join('; ') || 'partial token overlap between step text and method name',
    })
  }

  return scored.sort((a, b) => b.score - a.score)
}

export function scoreLocators(
  stepAction: string,
  locators: IndexedLocator[],
): { locator: IndexedLocator; score: number; reason: string }[] {
  const stepTokens = new Set(tokenize(stepAction))
  const scored: { locator: IndexedLocator; score: number; reason: string }[] = []

  for (const locator of locators) {
    const nameTokens = new Set(splitIdentifier(locator.name).filter((t) => t.length > 2))
    const ownerTokens = new Set(splitIdentifier(locator.ownerClass).filter((t) => t.length > 2))
    const nameSim = jaccard(stepTokens, nameTokens)
    const ownerSim = jaccard(stepTokens, ownerTokens)

    let score = nameSim * 0.7 + ownerSim * 0.3
    if (score <= 0.05) continue

    const matched = [...stepTokens].filter((t) => nameTokens.has(t))
    scored.push({
      locator,
      score: Math.round(score * 100) / 100,
      reason:
        matched.length > 0
          ? `locator name "${locator.name}" shares term(s) ${matched.slice(0, 4).join(', ')} with the step`
          : `locator class "${locator.ownerClass}" is relevant to the step vocabulary`,
    })
  }

  return scored.sort((a, b) => b.score - a.score)
}

/** A match at or above this score is treated as plausible reuse. */
export const REUSE_SCORE_THRESHOLD = 0.45

function toCandidateMethod(scored: ScoredMethod): CandidateMethod {
  return {
    qualifiedName: scored.method.facadeNamespace
      ? `${scored.method.facadeNamespace}.${scored.method.name}`
      : `${scored.method.ownerClass}.${scored.method.name}`,
    file: scored.method.file,
    line: scored.method.line,
    signature: scored.method.signature,
    matchReason: scored.reason,
    confidence: scored.score,
  }
}

function toCandidateLocator(entry: { locator: IndexedLocator; score: number; reason: string }): CandidateLocator {
  return {
    name: entry.locator.name,
    ownerClass: entry.locator.ownerClass,
    file: entry.locator.file,
    line: entry.locator.line,
    expression: entry.locator.expression,
    matchReason: entry.reason,
    confidence: entry.score,
  }
}

/** Page object class name tokens relevant to a step. */
function relevantPageObjects(stepAction: string, facts: FrameworkFacts): string[] {
  const stepTokens = new Set(tokenize(stepAction))
  return facts.pageObjects
    .map((po) => ({ po, score: jaccard(stepTokens, new Set(splitIdentifier(po).filter((t) => t.length > 2))) }))
    .filter((e) => e.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((e) => e.po)
}

/**
 * Decide what to do with the test case as a whole.
 *
 * The decision is derived only from duplicate evidence, never from a model.
 */
export function decide(testCase: TestCase, facts: FrameworkFacts): TestCaseDecision & { duplicates: ReturnType<typeof detectDuplicates> } {
  const duplicates = detectDuplicates(testCase, facts)
  const top = duplicates[0]

  if (!top) {
    return {
      decision: 'create-new',
      rationale:
        'No existing test in the framework overlaps with this test case. There is nothing to reuse or update.',
      evidence: [`Compared ${facts.tests.length} indexed test(s); none exceeded the overlap threshold.`],
      duplicates,
    }
  }

  const evidence = [
    `Closest existing test: "${top.existingTest.title}" at ${top.existingTest.file}:${top.existingTest.line}`,
    ...top.evidence,
  ]

  switch (top.verdict) {
    case 'exact-duplicate':
      return {
        decision: 'update-existing',
        rationale: 'An existing test already covers this scenario. It should be updated, not duplicated.',
        evidence,
        targetTestFile: top.existingTest.file,
        duplicates,
      }
    case 'likely-duplicate':
      return {
        decision: 'needs-clarification',
        rationale:
          'An existing test is similar enough that creating a new one risks duplication. A human must decide whether to update it or add a distinct case.',
        evidence,
        targetTestFile: top.existingTest.file,
        duplicates,
      }
    case 'shared-workflow-different-outcome':
      return {
        decision: 'update-existing',
        rationale:
          'An existing test drives the same workflow but asserts a different outcome. Extend it rather than repeating the workflow.',
        evidence,
        targetTestFile: top.existingTest.file,
        duplicates,
      }
    default:
      return {
        decision: 'create-new',
        rationale: 'The closest existing test is only loosely related; a new test is appropriate.',
        evidence,
        targetTestFile: top.existingTest.file,
        duplicates,
      }
  }
}

/**
 * Build the full reuse report for a manual test case against the framework.
 */
export function buildReuseReport(testCase: TestCase, facts: FrameworkFacts): ReuseReport {
  const { duplicates, ...decision } = decide(testCase, facts)

  const stepReuse: StepReusePlan[] = testCase.steps.map((step) => {
    const scored = scoreMethods(step.action, step.expectedResult, facts.actionMethods)
    const locators = scoreLocators(step.action, facts.locators)

    return {
      stepOrder: step.order,
      candidateMethods: scored.slice(0, 5).map(toCandidateMethod),
      candidateLocators: locators.slice(0, 5).map(toCandidateLocator),
      candidatePageObjects: relevantPageObjects(step.action, facts),
    }
  })

  // Aggregate helper methods: methods matching at least one step above threshold.
  const helperQualified = new Map<string, CandidateMethod>()
  for (const plan of stepReuse) {
    for (const candidate of plan.candidateMethods) {
      if (candidate.confidence >= REUSE_SCORE_THRESHOLD) {
        const existing = helperQualified.get(candidate.qualifiedName)
        if (!existing || existing.confidence < candidate.confidence) {
          helperQualified.set(candidate.qualifiedName, candidate)
        }
      }
    }
  }

  const pageObjects: CandidateMethod[] = facts.pageObjects.map((po) => ({
    qualifiedName: po,
    file: facts.tests.find((t) => t.referencedSymbols.includes(po))?.file ?? '',
    line: 0,
    signature: '',
    matchReason: 'Discovered as a page-object class in the framework',
    confidence: 0.5,
  }))

  const locatorModules: CandidateMethod[] = facts.locatorClasses.map((cls) => ({
    qualifiedName: cls,
    file: facts.locators.find((l) => l.ownerClass === cls)?.file ?? '',
    line: facts.locators.find((l) => l.ownerClass === cls)?.line ?? 0,
    signature: '',
    matchReason: 'Discovered as a locator class in the framework',
    confidence: 0.5,
  }))

  // Missing functionality: steps with no candidate above threshold.
  const missing: string[] = []
  for (const plan of stepReuse) {
    const best = plan.candidateMethods[0]
    const step = testCase.steps.find((s) => s.order === plan.stepOrder)
    if (!best || best.confidence < REUSE_SCORE_THRESHOLD) {
      missing.push(
        `Step ${plan.stepOrder}: "${step?.action ?? 'unknown action'}" — no indexed action method plausibly covers this step.`,
      )
    }
  }

  const reusableSteps = stepReuse.filter(
    (p) => (p.candidateMethods[0]?.confidence ?? 0) >= REUSE_SCORE_THRESHOLD,
  ).length
  const coverage = stepReuse.length === 0 ? 0 : reusableSteps / stepReuse.length

  const confidenceReasons = [
    `${reusableSteps} of ${stepReuse.length} step(s) have a plausible existing method above the ${REUSE_SCORE_THRESHOLD} score threshold.`,
  ]
  if (duplicates.length > 0) {
    confidenceReasons.push(
      `${duplicates.length} existing test(s) overlap with this case; the top match scored ${duplicates[0]?.similarity}.`,
    )
  }
  if (missing.length > 0) {
    confidenceReasons.push(`${missing.length} step(s) require new framework code.`)
  }

  return {
    testCaseTitle: testCase.title,
    decision,
    duplicates,
    stepReuse,
    helperMethods: [...helperQualified.values()],
    pageObjects,
    locatorModules,
    missingFunctionality: missing,
    confidence: {
      score: Math.round(coverage * 100) / 100,
      reasons: confidenceReasons,
    },
  }
}