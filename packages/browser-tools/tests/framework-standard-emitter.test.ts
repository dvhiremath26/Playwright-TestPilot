import { expect, test } from 'vitest'

import {
  emitFrameworkStandard,
  emitLocators,
  emitPage,
  emitSpec,
  emitTestData,
  locatorToName,
  stepToMethodName,
  stepToVerb,
  validateEmittedCalls,
} from '../src/framework-standard-emitter.ts'

import type { EmissionOptions, ResolvedStep } from '../src/framework-standard-emitter.ts'

const OPTIONS: EmissionOptions = {
  pageName: 'SalesOrder',
  stem: 'salesOrder',
  describeTitle: 'Sales Order Creation',
  testTitles: ['Create a Sales Order'],
  appName: 'S4',
  dataKeys: { salesOrderId: '4500000001' },
  xrayKey: 'TPA-7',
  environments: ['qa'],
  knownActions: ['navigate', 'fill', 'type', 'clear', 'click', 'hover', 'selectByText', 'check'],
  steps: [
    {
      step: 'Fill the material number field',
      methodSignature: 'enterMaterialNumber',
      locatorName: 'MATERIAL_NUMBER',
      locatorExpression: `this.page.getByLabel('Material Number')`,
      locatorEvidence: {
        locatorExpression: `this.page.getByLabel('Material Number')`,
        how: 'snapshot-ref',
      },
    } satisfies ResolvedStep,
    {
      step: 'Click the Save button',
      methodSignature: 'clickSave',
      locatorName: 'SAVE_BUTTON',
      locatorExpression: `this.page.getByRole('button', { name: 'Save' })`,
      locatorEvidence: {
        locatorExpression: `this.page.getByRole('button', { name: 'Save' })`,
        how: 'accessibility-role',
      },
    } satisfies ResolvedStep,
  ],
}

test('emits all four file layers at the framework-standard paths', () => {
  const files = emitFrameworkStandard(OPTIONS)
  const byLayer = new Map(files.map((f) => [f.layer, f]))

  expect(byLayer.get('locators')?.path).toBe('pages/SalesOrder/salesOrder.locators.ts')
  expect(byLayer.get('page')?.path).toBe('pages/SalesOrder/salesOrder.page.ts')
  expect(byLayer.get('spec')?.path).toBe('tests/salesOrder.spec.ts')
  expect(byLayer.get('test-data')?.path).toBe('test-data/salesOrder/salesOrder.qa.json')
})

test('page class extends BasePage and delegates to this.actions, matching login.page.ts', () => {
  const page = emitPage(OPTIONS)
  expect(page.content).toMatch(/export class SalesOrderPage extends BasePage \{/)
  expect(page.content).toMatch(/readonly locators: SalesOrderLocators/)
  expect(page.content).toMatch(/new SalesOrderLocators\(page\)/)
  expect(page.content).toMatch(/@Step\(/)
  expect(page.content).toMatch(/this\.actions\.fill\(this\.locators\.MATERIAL_NUMBER\)/)
  expect(page.content).toMatch(/this\.actions\.click\(this\.locators\.SAVE_BUTTON\)/)

  // Locators must never be constructed or referenced in the spec.
  const spec = emitSpec(OPTIONS)
  expect(spec.content).not.toMatch(/getByRole|getByLabel|getByPlaceholder/)
  expect(spec.content).not.toMatch(/this\.actions\./)
})

test('locator class uses a SCREAMING_SNAKE constant per control, like login.locators.ts', () => {
  const loc = emitLocators(OPTIONS)
  expect(loc.content).toMatch(/constructor\(private readonly page: Page\) \{\}/)
  expect(loc.content).toMatch(/readonly MATERIAL_NUMBER = this\.page\.getByLabel\('Material Number'\)/)
  expect(loc.content).toMatch(/readonly SAVE_BUTTON = this\.page\.getByRole\('button', \{ name: 'Save' \}\)/)
})

test('assumed locators are marked so a reviewer can see they were not observed', () => {
  const assumed: EmissionOptions = {
    ...OPTIONS,
    steps: [
      {
        step: 'Click the Cancel button',
        methodSignature: 'clickCancel',
        locatorName: 'CANCEL_BUTTON',
        locatorExpression: `this.page.getByRole('button', { name: 'Cancel' })`,
      },
    ],
  }
  const loc = emitLocators(assumed)
  expect(loc.content).toMatch(/ASSUMED/)
})

test('spec follows the tests/example.spec.ts idiom including fixture import and xray', () => {
  const spec = emitSpec(OPTIONS)
  expect(spec.content).toMatch(/import \{ test \} from '@src\/config\/fixture'/)
  expect(spec.content).toMatch(/import \{ xray \} from '@src\/utils\/xray\/xray'/)
  expect(spec.content).toMatch(/import \{ SalesOrderPage \} from '@pages\/SalesOrder\/salesOrder\.page'/)
  expect(spec.content).toMatch(/import \{ DataLoader \} from '@src\/utils\/testData\/dataLoader'/)
  expect(spec.content).toMatch(/import \{ ConfigManager \} from '@src\/config\/configManager'/)
  expect(spec.content).toMatch(/test\.describe\(`Sales Order Creation`/)
  expect(spec.content).toMatch(/DataLoader\.get\('salesOrder'\)/)
  expect(spec.content).toMatch(/xray\('TPA-7'\)/)
  expect(spec.content).toMatch(/ConfigManager\.getAppBaseUrl\('S4'\)/)
  expect(spec.content).toMatch(/await salesOrder\.enterMaterialNumber\(\)/)
  expect(spec.content).toMatch(/await salesOrder\.clickSave\(\)/)
})

test('omitting appName leaves a TODO instead of inventing an AppName', () => {
  const spec = emitSpec({ ...OPTIONS, appName: undefined })
  expect(spec.content).not.toMatch(/ConfigManager\.getAppBaseUrl\('SalesOrder'\)/)
  expect(spec.content).not.toMatch(/import \{ ConfigManager \}/)
  expect(spec.content).toMatch(/TODO: navigate to the app URL/)
})

test('a malformed xray key is dropped rather than emitted as a crash at runtime', () => {
  const spec = emitSpec({ ...OPTIONS, xrayKey: 'not-a-key' })
  expect(spec.content).not.toMatch(/xray\(/)
  expect(spec.content).not.toMatch(/@src\/utils\/xray\/xray/)
})

test('test data lands at DataLoader\'s expected path with placeholders only', () => {
  const [file] = emitTestData(OPTIONS)
  expect(file?.path).toBe('test-data/salesOrder/salesOrder.qa.json')
  expect(JSON.parse(file?.content ?? '{}').salesOrderId).toBe('4500000001')
})

test('emitted action calls are validated against the known Actions facade', () => {
  const allKnown = validateEmittedCalls(OPTIONS)
  expect(allKnown.map((r) => r.status)).toEqual(['confirmed', 'confirmed'])

  const unknown: EmissionOptions = { ...OPTIONS, knownActions: ['fill'] }
  const results = validateEmittedCalls(unknown)
  expect(results.some((r) => r.status === 'unconfirmed')).toBe(true)
})

test('unconfirmed actions are flagged inside the emitted page class', () => {
  const page = emitPage({ ...OPTIONS, knownActions: ['fill'] })
  expect(page.content).toMatch(/was not confirmed in the framework's Actions facade/)
})

test('stepToMethodName produces camelCase verbs in the framework style', () => {
  expect(stepToMethodName('Fill the material number')).toBe('fillMaterialNumber')
  expect(stepToMethodName('Click the Save button')).toBe('clickSaveButton')
  expect(stepToMethodName('!!!')).toBe('performStep')
})

test('stepToVerb maps intents onto existing framework actions', () => {
  expect(stepToVerb('Fill the quantity')).toBe('fill')
  expect(stepToVerb('Click the Save button')).toBe('click')
  expect(stepToVerb('Hover the row')).toBe('hover')
  expect(stepToVerb('Verify the message')).toBe('isVisible')
  expect(stepToVerb('Do something obscure')).toBe('click')
})

test('locatorToName derives SCREAMING_SNAKE names from locator expressions', () => {
  expect(locatorToName(`this.page.getByRole('button', { name: 'Save' })`, 'x')).toBe('BUTTON_SAVE')
  expect(locatorToName(`this.page.getByPlaceholder('Username')`, 'x')).toBe('USERNAME')
  expect(locatorToName(`this.page.locator('.x')`, 'SalesOrder')).toBe('SALES_ORDER')
})
