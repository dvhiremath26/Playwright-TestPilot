/**
 * Maps an approved step-to-implementation plan onto the framework-standard emitter.
 *
 * Until this module existed, `emitFrameworkStandard` was never called from the pipeline.
 * The runner asked a model provider to emit file content as fenced code blocks and trusted
 * whatever it returned, so conformance depended on the model reproducing the framework's
 * four-file layering, `@Step` decorators, and `this.actions.*` delegation. This made
 * conformance a matter of the model's discretion instead of a guarantee.
 *
 * This module closes that gap deterministically: given a plan and the framework's indexed
 * facts, it produces emitter options. Steps without verified evidence are surfaced in
 * `needsEvidence` rather than silently emitted with a guessed selector.
 *
 * It does not decide whether a step is reusable — the reuse analyzer did that, and the plan
 * carries the decision. It only translates.
 */

import type {
  IndexedActionMethod,
  IndexedLocator,
  IndexedTest,
  PlanEntry,
  ReuseReport,
  TestCaseStep,
  VerifiedLocator,
} from '@tcoe/shared-types'

import type { EmissionOptions, ResolvedStep } from './framework-standard-emitter.ts'
import { stepToMethodName, stepToVerb } from './framework-standard-emitter.ts'

/** Outcome of translating one manual step into an emitted page method. */
export interface StepEmission {
  stepOrder: number
  methodName: string
  /** Set when a verified locator serves this step. */
  locatorName?: string
  locatorExpression?: string
  /** True when the step has no verified evidence and needs browser confirmation. */
  unresolved: boolean
  unresolvedReason?: string
}

/** Everything `buildEmissionOptions` returns, including what it had to give up on. */
export interface EmissionBuild {
  options: EmissionOptions
  /** The resolved steps, mirroring `options.steps`. */
  steps: ResolvedStep[]
  /** Resolution outcomes, with unresolved reasons attached. */
  resolutions: StepEmission[]
  /** Steps that cannot be emitted with verified evidence. */
  needsEvidence: StepEmission[]
}

export interface EmissionInput {
  plan: PlanEntry[]
  testCase: TestCaseStep[]
  reuseReport?: ReuseReport
  /** Indexed locator constants, used to resolve `new-locator` steps. */
  locators: IndexedLocator[]
  /** Indexed action facade methods, used to confirm action calls. */
  actionMethods: IndexedActionMethod[]
  /** All existing tests, for the Xray key lookup. */
  existingTests?: IndexedTest[]
  pageName?: string
  /** File stem for the new test, e.g. `loginFlow`. Derived from the plan target when omitted. */
  stem?: string
  environments?: string[]
  /** Known `ConfigManager` app key. Emitted as a TODO when absent. */
  appName?: string
}

/** Strip any `namespace.` prefix from a symbol name. */
function bareName(symbol: string): string {
  return symbol.includes('.') ? symbol.slice(symbol.lastIndexOf('.') + 1) : symbol
}

/**
 * Derive a camelCase file stem from a source string.
 *
 * Handles both shapes the target filename arrives in: a phrase (`sales order
 * creation`) and an already-camelCase word (`loginFlow`). Lowercasing the first
 * word is only correct for the phrase form — applied to `loginFlow` it would
 * flatten it to `loginflow`, which then loses its capital to the page-name
 * derivation downstream.
 */
function slugStem(input: string): string {
  const flat = input
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (flat.length === 0) return 'newTest'
  if (flat.length === 1) {
    // Already a single word: only lowercase it when it is not camelCase,
    // so `loginFlow` keeps the capital the author wrote.
    const only = flat[0]!
    return /[A-Z]/.test(only.slice(1)) ? only : only.toLowerCase()
  }
  return flat
    .slice(0, 5)
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('')
}

/**
 * Derive the bare page noun from a stem.
 *
 * The emitter appends its own `Page` suffix when building the class name, so
 * this must return just the noun — `salesOrder` becomes `SalesOrder`, not
 * `SalesOrderPage`, or the class would read `SalesOrderPagePage`.
 */
function pageNameFromStem(stem: string): string {
  const base = stem.replace(/Page$/, '')
  return base
    .split(/(?=[A-Z])/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join('')
}

function indexSteps(testCase: TestCaseStep[]): Map<number, TestCaseStep> {
  const out = new Map<number, TestCaseStep>()
  for (const s of testCase) out.set(s.order, s)
  return out
}

/** Original text of a step, by order. */
function stepText(steps: Map<number, TestCaseStep>, entry: PlanEntry): string {
  const s = steps.get(entry.stepOrder)
  if (!s) return entry.stepAction
  return `${s.action}${s.expectedResult ? ' — expected: ' + s.expectedResult : ''}`
}

/**
 * Just the action half of a step.
 *
 * The method name is derived from this rather than from `stepText`, so the
 * expected result stays in the `@Step` log message instead of leaking into the
 * signature as `clickLoginButtonExpected`.
 */
function stepActionText(steps: Map<number, TestCaseStep>, entry: PlanEntry): string {
  return steps.get(entry.stepOrder)?.action ?? entry.stepAction
}

/** Pick the best-matching indexed locator constant for an unresolved step. */
function matchLocator(locators: IndexedLocator[], entry: PlanEntry): IndexedLocator | undefined {
  if (entry.targetSymbol) {
    const exact = locators.find((l) => l.name.toLowerCase() === entry.targetSymbol!.toLowerCase())
    if (exact) return exact
  }
  const step = entry.stepAction.toLowerCase()
  return locators
    .map((l) => {
      const name = l.name.toLowerCase()
      return { l, score: name.includes(step) ? 2 : 0 }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.l
}

/** Resolve the Xray key of an existing test when the case is an update, not a create. */
function existingXrayKey(
  reuseReport: ReuseReport | undefined,
  plan: PlanEntry[],
  existingTests: IndexedTest[],
): string | undefined {
  if (reuseReport?.decision.decision !== 'update-existing') return undefined
  const target = reuseReport.decision.targetTestFile ?? plan[0]?.targetFile
  if (!target) return undefined
  return existingTests.find((t) => t.file === target)?.xrayKey
}

/**
 * Turn an approved plan into emitter options.
 *
 * Check `needsEvidence` before treating the output as complete: a step listed there emits a
 * TODO comment rather than a working locator, so it still needs browser evidence.
 */
export function buildEmissionOptions(input: EmissionInput): EmissionBuild {
  const { plan, testCase, reuseReport, locators, actionMethods } = input
  const stepsByOrder = indexSteps(testCase)

  const targetSpec = plan[0]?.targetFile ?? 'tests/new.spec.ts'
  const stem = input.stem ?? slugStem(targetSpec.replace(/^.*[\\/]/, '').replace(/\.spec\.ts$/, ''))
  const pageName = input.pageName ?? pageNameFromStem(stem)

  const steps: ResolvedStep[] = []
  const resolutions: StepEmission[] = []

  for (const entry of plan) {
    // Steps already served by an existing method or locator need no new page code.
    if (entry.resolution === 'existing-action' || entry.resolution === 'existing-method' ||
        entry.resolution === 'existing-locator' || entry.resolution === 'existing-page-object') {
      continue
    }

    const text = stepText(stepsByOrder, entry)
    const methodName = stepToMethodName(stepActionText(stepsByOrder, entry))

    if (entry.resolution === 'new-locator') {
      if (entry.verifiedLocator) {
        const observed = entry.verifiedLocator
        steps.push({
          step: text,
          methodSignature: methodName,
          locatorName: locatorNameFromObserved(observed),
          locatorExpression: observed.expression,
          locatorEvidence: { locatorExpression: observed.expression, how: 'snapshot-ref' },
        })
        resolutions.push({
          stepOrder: entry.stepOrder,
          methodName,
          locatorName: locatorNameFromObserved(observed),
          locatorExpression: observed.expression,
          unresolved: false,
        })
        continue
      }
      const found = matchLocator(locators, entry)
      if (found) {
        steps.push({
          step: text,
          methodSignature: methodName,
          locatorName: found.name,
          locatorExpression: found.expression,
          locatorEvidence: { locatorExpression: found.expression, how: 'accessibility-role' },
        })
        resolutions.push({
          stepOrder: entry.stepOrder,
          methodName,
          locatorName: found.name,
          locatorExpression: found.expression,
          unresolved: false,
        })
      } else {
        resolutions.push({
          stepOrder: entry.stepOrder,
          methodName,
          unresolved: true,
          unresolvedReason: entry.unresolvedReason ?? `No verified locator for step ${entry.stepOrder}`,
        })
      }
      continue
    }

    // A `new-method` step has no verified locator, so nothing can be emitted for it.
    // Recording it as resolved would emit a page method with a guessed selector.
    if (entry.resolution === 'new-method') {
      resolutions.push({
        stepOrder: entry.stepOrder,
        methodName,
        unresolved: true,
        unresolvedReason:
          entry.unresolvedReason ?? `Step ${entry.stepOrder} needs a verified locator before it can be emitted`,
      })
      continue
    }

    // `assertion` steps cannot be emitted with verified evidence.
    if (entry.resolution === 'assertion') {
      resolutions.push({
        stepOrder: entry.stepOrder,
        methodName,
        unresolved: true,
        unresolvedReason: `Assertion step ${entry.stepOrder} needs a business-result check, not a locator`,
      })
      continue
    }

    // Any other resolution is unresolved and was never verified against the framework.
    resolutions.push({
      stepOrder: entry.stepOrder,
      methodName,
      unresolved: true,
      unresolvedReason: entry.unresolvedReason ?? `Step ${entry.stepOrder} is unresolved (${entry.resolution})`,
    })
  }

  const title = reuseReport?.testCaseTitle || plan[0]?.stepAction || stem
  const options: EmissionOptions = {
    pageName,
    stem,
    describeTitle: title,
    testTitles: [title],
    steps,
    xrayKey: existingXrayKey(reuseReport, plan, input.existingTests ?? []),
    environments: input.environments ?? ['qa'],
    appName: input.appName,
    knownActions: actionMethods.map((m) => m.name),
    // The emitter compares these against the verb it emits per step, so report the
    // verbs it would actually call rather than raw facade paths.
    unconfirmedActions: unconfirmedVerbs(input).map((verb) => stepToVerb(verb)),
  }

  return { options, steps, resolutions, needsEvidence: resolutions.filter((r) => r.unresolved) }
}

function locatorNameFromObserved(locator: VerifiedLocator): string {
  const stem = (locator.name || locator.role || `element${locator.ref}`)
    .replace(/[^a-zA-Z0-9]+(.)?/g, (_match, next: string | undefined) => next ? next.toUpperCase() : '')
    .replace(/^[^a-zA-Z]+/, '')
  const candidate = stem ? `${stem[0]!.toUpperCase()}${stem.slice(1)}` : 'ObservedElement'
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(candidate) ? candidate : 'ObservedElement'
}

/**
 * Names of methods the plan calls that are not on the indexed facade.
 * An empty list means every referenced call is confirmed against the framework.
 */
export function unconfirmedVerbs(input: EmissionInput): string[] {
  const known = new Set(input.actionMethods.map((m) => m.name.toLowerCase()))
  const missing = new Set<string>()
  for (const entry of input.plan) {
    const sym = entry.facadePath ?? entry.targetSymbol
    if (!sym) continue
    const bare = bareName(sym).toLowerCase()
    if (bare && !known.has(bare)) missing.add(bare)
  }
  return [...missing]
}
