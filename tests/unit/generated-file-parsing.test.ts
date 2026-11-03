import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseGeneratedFiles } from '../../packages/cli/src/runner'

let repositoryRoot: string

beforeEach(() => {
  repositoryRoot = mkdtempSync(join(tmpdir(), 'tcoe-generated-files-'))
})

afterEach(() => {
  rmSync(repositoryRoot, { recursive: true, force: true })
})

describe('parseGeneratedFiles', () => {
  it('strips a TypeScript fence-language prefix from Windows-style model file headers', () => {
    const response = [
      '```typescript:tests/createSalesOrder.spec.ts',
      "import { test } from '@src/config/fixture'",
      "test('Create Sales Order', async () => { await createSalesOrder() })",
      '```',
      '```typescript:pages/CreateSalesOrder/createSalesOrder.page.ts',
      'export class CreateSalesOrderPage {}',
      '```',
      '```typescript:pages/CreateSalesOrder/createSalesOrder.locators.ts',
      'export class CreateSalesOrderLocators {}',
      '```',
    ].join('\n')

    const changes = parseGeneratedFiles(response, repositoryRoot)

    expect(changes.map((change) => change.path)).toEqual([
      'tests/createSalesOrder.spec.ts',
      'pages/CreateSalesOrder/createSalesOrder.page.ts',
      'pages/CreateSalesOrder/createSalesOrder.locators.ts',
    ])
    expect(changes[0]?.newContent).toContain("test('Create Sales Order'")
  })

  it('keeps ordinary language plus whitespace-separated paths working', () => {
    const changes = parseGeneratedFiles(
      '```typescript tests/createSalesOrder.spec.ts\n' +
      "import { test } from '@src/config/fixture'\ntest('x', () => {})\n```",
      repositoryRoot,
    )

    expect(changes.map((change) => change.path)).toEqual(['tests/createSalesOrder.spec.ts'])
  })
})
