import { describe, expect, it } from 'vitest'
import { rewriteHardcodedManualData } from '../../packages/cli/src/runner'
import type { FileChange } from '../../packages/shared-types/src/agent'

const data = {
  moduleName: 'createSalesOrder',
  cases: [{ caseKey: 'createSalesOrder01', title: 'Create Sales Order', values: { transactionCode: 'VA01' } }],
  sharedFlow: false,
  targetPath: 'test-data/createSalesOrder.json',
}

function spec(content: string): FileChange[] {
  return [{
    path: 'tests/createSalesOrder.spec.ts',
    kind: 'create',
    newContent: content,
    reason: 'test fixture',
    evidence: [],
  }]
}

describe('rewriteHardcodedManualData', () => {
  it('wires hardcoded inputs to the matching direct DataLoader case row', () => {
    const input = spec([
      "import { DataLoader } from '@src/utils/testData/dataLoader'",
      "const testData = DataLoader.get('createSalesOrder')",
      "test('Create Sales Order', async ({ page }) => {",
      "  await page.fill('VA01')",
      '})',
    ].join('\n'))

    const rewritten = rewriteHardcodedManualData(input, data)[0]!.newContent!
    expect(rewritten).toContain("await page.fill(testData['createSalesOrder01'].transactionCode)")
    expect(rewritten).not.toContain("page.fill('VA01')")
  })

  it('uses the already selected row when the spec binds one case directly', () => {
    const input = spec([
      "import { DataLoader } from '@src/utils/testData/dataLoader'",
      "const orderData = DataLoader.get('createSalesOrder')['createSalesOrder01']",
      "test('Create Sales Order', async ({ page }) => {",
      "  await page.fill('VA01')",
      '})',
    ].join('\n'))

    const rewritten = rewriteHardcodedManualData(input, data)[0]!.newContent!
    expect(rewritten).toContain('await page.fill(orderData.transactionCode)')
  })

  it('uses the direct JSON import when that fallback is active', () => {
    const input = spec([
      "import createSalesOrderJson from '../test-data/createSalesOrder.json'",
      "test('Create Sales Order', async ({ page }) => {",
      "  await page.fill('VA01')",
      '})',
    ].join('\n'))

    const rewritten = rewriteHardcodedManualData(input, data)[0]!.newContent!
    expect(rewritten).toContain("await page.fill(createSalesOrderJson['createSalesOrder01'].transactionCode)")
  })

  it('keeps unrelated literals and test titles unchanged', () => {
    const input = spec([
      "import { DataLoader } from '@src/utils/testData/dataLoader'",
      "const testData = DataLoader.get('createSalesOrder')",
      "test('Create Sales Order', async ({ page }) => {",
      "  await page.fill('VA02')",
      '})',
    ].join('\n'))

    const rewritten = rewriteHardcodedManualData(input, data)[0]!.newContent!
    expect(rewritten).toContain("test('Create Sales Order'")
    expect(rewritten).toContain("page.fill('VA02')")
  })
})
