import { describe, expect, it } from 'vitest'

import type {
  IndexedActionMethod,
  IndexedLocator,
  IndexedTest,
  PlanEntry,
  ReuseReport,
  TestCaseStep,
} from '@tcoe/shared-types'

import { buildEmissionOptions, unconfirmedVerbs } from '../src/plan-emission.ts'
import { emitFrameworkStandard } from '../src/framework-standard-emitter.ts'

function locators(): IndexedLocator[] {
  const mk = (name: string, expression: string): IndexedLocator => ({
    name,
    ownerClass: 'LoginPageLocators',
    file: 'pages/LoginPage/login.locators.ts',
    line: 5,
    expression,
    strategy: 'getByRole',
  })
  return [
    mk('USERNAME', "this.page.getByLabel('Username')"),
    mk('PASSWORD', "this.page.getByLabel('Password')"),
    mk('LOGIN_BUTTON', "this.page.getByRole('button', { name: 'Login' })"),
  ]
}

function actions(): IndexedActionMethod[] {
  const mk = (name: string): IndexedActionMethod => ({
    ownerClass: 'NavigationActions',
    facadeNamespace: 'browser',
    name,
    file: 'src/helper/actions/navigation.actions.ts',
    line: 10,
    signature: `async ${name}(): Promise<void>`,
    parameters: [],
    returnType: 'Promise<void>',
    decorators: [],
    onFacade: true,
  })
  return [mk('navigate'), mk('fill'), mk('type'), mk('click'), mk('expectVisible')]
}

function testCase(): TestCaseStep[] {
  return [
    { order: 1, action: 'Navigate to the login page' },
    { order: 2, action: 'Fill the username field', testData: 'admin' },
    { order: 3, action: 'Fill the password field', testData: 'secret' },
    { order: 4, action: 'Click the Login button', expectedResult: 'The dashboard is shown' },
  ]
}

function plan(over: Partial<PlanEntry>[] = []): PlanEntry[] {
  const base: PlanEntry[] = [
    {
      stepOrder: 1,
      stepAction: 'Navigate to the login page',
      resolution: 'existing-action',
      targetFile: 'src/helper/actions/navigation.actions.ts',
      targetSymbol: 'browser.navigate',
      facadePath: 'browser.navigate',
      evidence: ['confirmed'],
    },
    {
      stepOrder: 2,
      stepAction: 'Fill the username field',
      resolution: 'existing-action',
      targetSymbol: 'browser.fill',
      facadePath: 'browser.fill',
      evidence: ['confirmed'],
    },
    {
      stepOrder: 3,
      stepAction: 'Fill the password field',
      resolution: 'existing-action',
      targetSymbol: 'browser.fill',
      facadePath: 'browser.fill',
      evidence: ['confirmed'],
    },
    {
      stepOrder: 4,
      stepAction: 'Click the Login button',
      resolution: 'new-locator',
      targetSymbol: 'LOGIN_BUTTON',
      evidence: ['no matching action method'],
    },
  ]
  return base.map((p, i) => ({ ...p, ...(over[i] ?? {}) }))
}

const CASE_TITLE = 'Log in and verify the dashboard loads'

function reuseReport(
  decision: 'update-existing' | 'create-new',
  targetTestFile?: string,
): ReuseReport {
  return {
    testCaseTitle: CASE_TITLE,
    decision: { decision, rationale: 'test', evidence: [] },
    duplicates: [],
    stepReuse: [],
    helperMethods: [],
    pageObjects: [],
    locatorModules: [],
    missingFunctionality: [],
    confidence: { score: 0.9, reasons: [] },
    ...(targetTestFile ? { decision: { decision, rationale: 'test', evidence: [], targetTestFile } } : {}),
  }
}

describe('buildEmissionOptions', () => {
  it('skips steps already served by an existing action and emits only the gap', () => {
    const build = buildEmissionOptions({
      plan: plan(),
      testCase: testCase(),
      reuseReport: reuseReport('create-new'),
      locators: locators(),
      actionMethods: actions(),
    })

    // Only step 4 (new-locator) needs new page code; steps 1-3 reuse existing actions.
    expect(build.options.steps).toHaveLength(1)
    expect(build.options.steps[0]!.locatorName).toBe('LOGIN_BUTTON')
    expect(build.needsEvidence).toHaveLength(0)
  })

  it('emits only a new-method step when every step is a gap', () => {
    const p = plan().map<PlanEntry>((e) => ({
      ...e,
      resolution: 'new-method',
      targetSymbol: undefined,
      facadePath: undefined,
      evidence: ['no candidate above threshold'],
    }))
    const build = buildEmissionOptions({
      plan: p,
      testCase: testCase(),
      reuseReport: reuseReport('create-new'),
      locators: locators(),
      actionMethods: actions(),
    })

    // A `new-method` step has no verified locator, so it is recorded as unresolved and
    // emits no page code — the TODO belongs in the spec, not in a guessed selector.
    expect(build.options.steps).toHaveLength(0)
    expect(build.needsEvidence).toHaveLength(4)
    expect(build.needsEvidence.map((r) => r.stepOrder)).toEqual([1, 2, 3, 4])
    expect(build.needsEvidence[2]!.locatorName).toBeUndefined()
  })

  it('flags a new-locator step with no matching indexed locator as needing evidence', () => {
    const build = buildEmissionOptions({
      plan: plan(),
      testCase: testCase(),
      reuseReport: reuseReport('create-new'),
      locators: locators().filter((l) => l.name !== 'LOGIN_BUTTON'),
      actionMethods: actions(),
    })

    expect(build.options.steps).toHaveLength(0)
    expect(build.needsEvidence).toHaveLength(1)
    expect(build.needsEvidence[0]!.locatorExpression).toBeUndefined()
    expect(build.needsEvidence[0]!.unresolvedReason).toMatch(/No verified locator/)
  })

  it('resolves a new-locator step against an existing indexed locator', () => {
    const build = buildEmissionOptions({
      plan: plan(),
      testCase: testCase(),
      reuseReport: reuseReport('create-new'),
      locators: locators(),
      actionMethods: actions(),
    })

    const resolved = build.options.steps[0]!
    expect(resolved.locatorName).toBe('LOGIN_BUTTON')
    expect(resolved.locatorExpression).toMatch(/getByRole/)
    expect(resolved.locatorEvidence?.how).toBe('accessibility-role')
  })

  it('emits a locator selected by the reviewer from an observed browser ref', () => {
    const p = plan().map((entry) => entry.stepOrder === 4
      ? {
          ...entry,
          verifiedLocator: {
            ref: 'e15',
            role: 'button',
            name: 'Log in',
            expression: "getByRole('button', { name: 'Log in' })",
            backend: 'Playwright CLI',
            observedAt: '2026-10-18T00:00:00.000Z',
          },
        }
      : entry)
    const build = buildEmissionOptions({
      plan: p,
      testCase: testCase(),
      reuseReport: reuseReport('create-new'),
      locators: [],
      actionMethods: actions(),
    })
    expect(build.options.steps[0]?.locatorExpression).toContain("getByRole('button'")
    expect(build.options.steps[0]?.locatorEvidence?.how).toBe('snapshot-ref')
    expect(build.needsEvidence).toHaveLength(0)
  })

  it('surfaces a missing action method via unconfirmedVerbs', () => {
    // Give the plan an explicit facade reference so there is something to confirm.
    const input = {
      plan: plan([{ facadePath: 'browser.login_button', targetSymbol: 'LOGIN_BUTTON' }]),
      testCase: testCase(),
      locators: locators(),
      actionMethods: actions(),
    }

    // 'login_button' is not a method on the indexed facade, so it is reported as missing.
    expect(unconfirmedVerbs(input)).toEqual(['login_button'])

    // Add the real method to the facade and it is confirmed.
    const known = { ...input, actionMethods: [...actions(), { ...actions()[0]!, name: 'login_button' }] }
    expect(unconfirmedVerbs(known)).toEqual([])
  })

  it('sets the Xray key only when updating an existing test', () => {
    const existing: IndexedTest[] = [
      {
        title: 'Login Test',
        fullTitle: 'Logout Tests › Login Test',
        file: 'tests/login.spec.ts',
        line: 12,
        xrayKey: 'TPA-5',
        tags: [],
        annotations: [],
        referencedSymbols: [],
        fixtures: [],
        hasAssertion: true,
      },
    ]

    const create = buildEmissionOptions({
      plan: plan(),
      testCase: testCase(),
      reuseReport: reuseReport('create-new'),
      locators: locators(),
      actionMethods: actions(),
      existingTests: existing,
    })
    expect(create.options.xrayKey).toBeUndefined()

    const update = buildEmissionOptions({
      plan: plan(),
      testCase: testCase(),
      reuseReport: reuseReport('update-existing', 'tests/login.spec.ts'),
      locators: locators(),
      actionMethods: actions(),
      existingTests: existing,
    })
    expect(update.options.xrayKey).toBe('TPA-5')
  })

  it('derives pageName and stem from the plan target file', () => {
    const p = plan().map((e, i) => (i === 0 ? { ...e, targetFile: 'tests/loginFlow.spec.ts' } : e))
    const build = buildEmissionOptions({
      plan: p,
      testCase: testCase(),
      reuseReport: reuseReport('create-new'),
      locators: locators(),
      actionMethods: actions(),
    })

    expect(build.options.stem).toBe('loginFlow')
    // `pageName` is the bare noun: the emitter appends `Page` to build the class.
    expect(build.options.pageName).toBe('LoginFlow')
    expect(build.options.describeTitle).toBe(CASE_TITLE)
  })

  it('derives a camelCase stem from a spaced filename without losing capitals', () => {
    const p = plan().map((e, i) => (i === 0 ? { ...e, targetFile: 'tests/login flow.spec.ts' } : e))
    const build = buildEmissionOptions({
      plan: p,
      testCase: testCase(),
      reuseReport: reuseReport('create-new'),
      locators: locators(),
      actionMethods: actions(),
    })

    expect(build.options.stem).toBe('loginFlow')
    expect(build.options.pageName).toBe('LoginFlow')
  })

  it('lowercases an all-lowercase single-word stem', () => {
    const p = plan().map((e, i) => (i === 0 ? { ...e, targetFile: 'tests/login.spec.ts' } : e))
    const build = buildEmissionOptions({
      plan: p,
      testCase: testCase(),
      reuseReport: reuseReport('create-new'),
      locators: locators(),
      actionMethods: actions(),
    })

    expect(build.options.stem).toBe('login')
    expect(build.options.pageName).toBe('Login')
  })

  it('does not double-suffix a stem that already ends in Page', () => {
    const p = plan().map((e, i) => (i === 0 ? { ...e, targetFile: 'tests/salesOrderPage.spec.ts' } : e))
    const build = buildEmissionOptions({
      plan: p,
      testCase: testCase(),
      reuseReport: reuseReport('create-new'),
      locators: locators(),
      actionMethods: actions(),
    })

    // `salesOrderPage` -> noun `SalesOrder`, so the class is `SalesOrderPage`.
    expect(build.options.pageName).toBe('SalesOrder')
  })

  it('feeds cleanly into emitFrameworkStandard', () => {
    // The target file drives the stem, and the stem drives the page class name.
    const build = buildEmissionOptions({
      plan: plan([{ targetFile: 'tests/login.spec.ts' }]),
      testCase: testCase(),
      reuseReport: reuseReport('create-new'),
      locators: locators(),
      actionMethods: actions(),
      appName: 'S4',
    })

    const files = emitFrameworkStandard(build.options)
    expect(files.map((f) => f.layer).sort()).toEqual(['locators', 'page', 'spec', 'test-data'])
    expect(files.find((f) => f.layer === 'page')!.content).toContain('class LoginPage extends BasePage')
    expect(files.find((f) => f.layer === 'spec')!.content).toContain("@src/config/fixture")
  })

  it('keeps the expected result out of the method name', () => {
    const build = buildEmissionOptions({
      plan: plan(),
      testCase: testCase(),
      reuseReport: reuseReport('create-new'),
      locators: locators(),
      actionMethods: actions(),
      appName: 'S4',
    })

    const page = emitFrameworkStandard(build.options).find((f) => f.layer === 'page')!.content
    // The expected result belongs in the @Step log message, not the signature.
    expect(page).toContain('async clickLoginButton()')
    expect(page).not.toMatch(/click\w*Expected/)
    // …but it is still recorded for the reviewer in the @Step annotation.
    expect(page).toContain('The dashboard is shown')
  })
})
