import { describe, expect, it } from 'vitest'
import { isObservedLocatorExpression, rewriteObservedFrameLocators } from '../../packages/cli/src/runner'
import type { FileChange, VerifiedLocator } from '../../packages/shared-types/src/agent'

const observedAt = '2026-11-03T00:00:00.000Z'

function observed(expression: string, role: string, name: string, stepOrder: number): VerifiedLocator {
  return {
    ref: `step-${stepOrder}`,
    expression,
    role,
    name,
    backend: 'Playwright CLI DOM inspection',
    observedAt,
    stepOrder,
    pageUrl: 'https://sap.example.test/sales-order',
  }
}

function locatorFile(content: string): FileChange[] {
  return [{
    path: 'pages/CreateSalesOrder/createSalesOrder.locators.ts',
    kind: 'create',
    newContent: content,
    reason: 'test fixture',
    evidence: [],
  }]
}

describe('rewriteObservedFrameLocators', () => {
  it('replaces a guessed frame scope and near-match accessible names with the observed frame locator', () => {
    const input = locatorFile([
      'export class CreateSalesOrderLocators {',
      '  readonly ORDER_TYPE = this.page.getByRole("textbox", { name: "Order Type Required" });',
      '  readonly CONTINUE = this.page.getByRole("button", { name: "Continue Emphasized" });',
      '}',
    ].join('\n'))
    const candidates = [
      observed('this.page.frameLocator("iframe[name=\\"sap-frame\\"]").getByRole("textbox", { name: "Order Type", exact: true })', 'textbox', 'Order Type', 10),
      observed('this.page.frameLocator("iframe[name=\\"sap-frame\\"]").getByRole("button", { name: "Continue", exact: true })', 'button', 'Continue', 11),
    ]

    const rewritten = rewriteObservedFrameLocators(input, candidates)[0]!.newContent!
    expect(rewritten).toContain('frameLocator("iframe[name=\\"sap-frame\\"]").getByRole("textbox", { name: "Order Type", exact: true })')
    expect(rewritten).toContain('frameLocator("iframe[name=\\"sap-frame\\"]").getByRole("button", { name: "Continue", exact: true })')
    expect(rewritten).not.toContain('Order Type Required')
    expect(rewritten).not.toContain('Continue Emphasized')
  })

  it('does not choose between equally similar observed controls', () => {
    const input = locatorFile('export class XLocators {\n  readonly VALUE = this.page.getByRole("textbox", { name: "Value" });\n}')
    const candidates = [
      observed('this.page.frameLocator("iframe#a").getByRole("textbox", { name: "Value", exact: true })', 'textbox', 'Value', 1),
      observed('this.page.frameLocator("iframe#b").getByRole("textbox", { name: "Value", exact: true })', 'textbox', 'Value', 2),
    ]

    const rewritten = rewriteObservedFrameLocators(input, candidates)[0]!.newContent!
    expect(rewritten).toContain('this.page.getByRole("textbox", { name: "Value" })')
  })

  it('replaces a frame selector that changed during replay with the observed frame locator', () => {
    const input = locatorFile([
      'export class CreateSalesOrderLocators {',
      '  readonly CONTINUE = this.page.frameLocator(\'iframe[name="__container159-iframe"]\').getByRole("button", { name: "Continue Emphasized" });',
      '}',
    ].join('\n'))
    const candidates = [
      observed('this.page.frameLocator(\'iframe[name="__container155-iframe"]\').getByRole("button", { name: "Continue", exact: true })', 'button', 'Continue', 5),
    ]

    const rewritten = rewriteObservedFrameLocators(input, candidates)[0]!.newContent!
    expect(rewritten).toContain('frameLocator(\'iframe[name="__container155-iframe"]\').getByRole("button", { name: "Continue", exact: true })')
    expect(rewritten).not.toContain('__container159-iframe')
    expect(rewritten).not.toContain('Continue Emphasized')
  })

  it('corrects an altered accessible name when the generated frame scope is already correct', () => {
    const input = locatorFile([
      'export class CreateSalesOrderLocators {',
      '  readonly CONTINUE = this.page.frameLocator(\'iframe[name="__container155-iframe"]\') .getByRole("button", { name: "Continue Emphasized" });',
      '}',
    ].join('\n'))
    const candidates = [
      observed('this.page.frameLocator(\'iframe[name="__container155-iframe"]\').getByRole("button", { name: "Continue", exact: true })', 'button', 'Continue', 5),
    ]

    const rewritten = rewriteObservedFrameLocators(input, candidates)[0]!.newContent!
    expect(rewritten).toContain('frameLocator(\'iframe[name="__container155-iframe"]\').getByRole("button", { name: "Continue", exact: true })')
    expect(rewritten).not.toContain('Continue Emphasized')
  })

  it('normalizes a contentFrame chain and prefers a unique observed data-help-id locator', () => {
    const input = locatorFile([
      'export class CreateSalesOrderLocators {',
      '  readonly ORDER_TYPE = this.page.locator(\'iframe[name="__container164-iframe"]\') .contentFrame() .getByRole("textbox", { name: "Order Type Required" });',
      '}',
    ].join('\n'))
    const candidates = [
      observed('this.page.frameLocator(\'iframe[name="__container155-iframe"]\').locator(\'[data-help-id="S4OrderType"]\')', 'textbox', 'Order Type', 10),
    ]

    const rewritten = rewriteObservedFrameLocators(input, candidates)[0]!.newContent!
    expect(rewritten).toContain('frameLocator(\'iframe[name="__container155-iframe"]\').locator(\'[data-help-id="S4OrderType"]\')')
    expect(rewritten).not.toContain('__container164-iframe')
    expect(rewritten).not.toContain('Order Type Required')
  })

  it('prefers a matching control in the same frame when accessible names repeat across frames', () => {
    const input = locatorFile([
      'export class CreateSalesOrderLocators {',
      '  readonly CONTINUE = this.page.locator(\'iframe[name="__container155-iframe"]\') .contentFrame() .getByRole("button", { name: "Continue Emphasized" });',
      '}',
    ].join('\n'))
    const candidates = [
      observed('this.page.frameLocator(\'iframe[name="__container155-iframe"]\').getByRole("button", { name: "Continue", exact: true })', 'button', 'Continue', 5),
      observed('this.page.frameLocator(\'iframe[name="login-frame"]\').getByRole("button", { name: "Continue", exact: true })', 'button', 'Continue', 2),
    ]

    const rewritten = rewriteObservedFrameLocators(input, candidates)[0]!.newContent!
    expect(rewritten).toContain('frameLocator(\'iframe[name="__container155-iframe"]\').getByRole("button", { name: "Continue", exact: true })')
    expect(rewritten).not.toContain('login-frame')
  })

  it('keeps the generated iframe wrapper when only the child control was observed', () => {
    const input = locatorFile([
      'export class CreateSalesOrderLocators {',
      '  readonly CONTINUE = this.page.locator(\'iframe[name="__container159-iframe"]\') .contentFrame() .getByRole("button", { name: "Continue Emphasized" });',
      '}',
    ].join('\n'))
    const candidates = [
      observed('this.page.getByRole("button", { name: "Continue", exact: true })', 'button', 'Continue', 14),
    ]

    const rewritten = rewriteObservedFrameLocators(input, candidates)[0]!.newContent!
    const observedScopedControl = 'locator(\'iframe[name="__container159-iframe"]\') .contentFrame().getByRole("button", { name: "Continue", exact: true })'
    expect(rewritten).toContain(observedScopedControl)
    expect(rewritten).not.toContain('Continue Emphasized')
    expect(isObservedLocatorExpression(
      'frameLocator("iframe[name=\\"__container159-iframe\\"]").getByRole("button", { name: "Continue", exact: true })',
      new Set(['getByRole("button",{name:"Continue",exact:true})']),
    )).toBe(true)
  })

  it('removes an unused guessed iframe locator after observed controls have been rebound', () => {
    const input = locatorFile([
      'export class XLocators {',
      '  readonly FRAME = this.page.locator(\'iframe[name="__guessed"]\');',
      '  readonly FIELD = this.page.getByRole("textbox", { name: "Order Type Required" });',
      '}',
    ].join('\n'))
    const candidates = [
      observed('this.page.frameLocator("iframe[name=\\"real-frame\\"]").getByRole("textbox", { name: "Order Type", exact: true })', 'textbox', 'Order Type', 10),
    ]

    const rewritten = rewriteObservedFrameLocators(input, candidates)[0]!.newContent!
    expect(rewritten).not.toContain('__guessed')
    expect(rewritten).toContain('frameLocator("iframe[name=\\"real-frame\\"]").getByRole("textbox", { name: "Order Type", exact: true })')
  })
})
