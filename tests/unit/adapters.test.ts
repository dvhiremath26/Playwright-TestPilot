import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'

import { detect, resolve, workbookToCsv, workbookWorksheetNames, workbookColumnHeaders, ambiguousExcelColumns } from '@tcoe/adapters'
import { hasBlockingIssues } from '@tcoe/shared-types'
import type { TestCase } from '@tcoe/shared-types'

/**
 * These cases exercise the text adapter directly. `detect()` prefers Markdown
 * over text, and the two formats differ in how a title and an expected result
 * are written, so testing the shape each adapter really accepts is the point.
 */
const TEXT_CASE = `Log in with a valid user
Precondition: A test user exists in QA

1. Navigate to the login page → expected: The login form is visible
2. Enter the username | admin
3. Enter the password → expected: The value is masked
4. Click Login → expected: The dashboard is shown
`

async function normaliseText(raw: string): Promise<TestCase> {
  const { result } = await detect(raw)
  const tc = result.testCase
  expect(tc).not.toBeNull()
  expect(hasBlockingIssues(result.issues)).toBe(false)
  return tc!
}

describe('text adapter', () => {
  it('extracts the title from the first line', async () => {
    const tc = await normaliseText(TEXT_CASE)
    expect(tc.title).toBe('Log in with a valid user')
  })

  it('extracts every numbered step in order', async () => {
    const tc = await normaliseText(TEXT_CASE)
    expect(tc.steps).toHaveLength(4)
    expect(tc.steps.map((s) => s.order)).toEqual([1, 2, 3, 4])
    expect(tc.steps[0]!.action).toBe('Navigate to the login page')
  })

  it('captures the expected result for a step', async () => {
    const tc = await normaliseText(TEXT_CASE)
    expect(tc.steps[0]!.expectedResult).toBe('The login form is visible')
    expect(tc.steps[1]!.expectedResult).toBeUndefined()
    expect(tc.steps[3]!.expectedResult).toBe('The dashboard is shown')
  })

  it('captures |test data| on a step', async () => {
    const tc = await normaliseText(TEXT_CASE)
    expect(tc.steps[1]!.testData).toBe('admin')
  })

  it('captures preconditions separately from steps', async () => {
    const tc = await normaliseText(TEXT_CASE)
    expect(tc.preconditions.length).toBeGreaterThan(0)
    expect(tc.preconditions.join(' ')).toContain('test user')
    // A precondition must never become a step.
    expect(tc.steps.some((s) => /test user exists/i.test(s.action))).toBe(false)
  })

  it('warns rather than failing when step numbers are non-consecutive', async () => {
    const { result } = await detect('Login case\n\n1. Open the page\n3. Click Login\n')
    const tc = result.testCase
    expect(tc).not.toBeNull()
    // Preserved as written, not renumbered.
    expect(tc!.steps.map((s) => s.order)).toEqual([1, 2])
    expect(result.issues.some((i) => i.severity === 'warning' && /non-consecutive/i.test(i.message))).toBe(
      true,
    )
  })

  it('records the source so the reviewer knows where the case came from', async () => {
    const tc = await normaliseText(TEXT_CASE)
    expect(tc.source.kind).toBe('txt')
    expect(Array.isArray(tc.source.assumptions)).toBe(true)
  })
})

describe('markdown adapter', () => {
  const MD_CASE = `# Log in with a valid user

## Steps

1. Navigate to the login page
2. Enter the username
   |test data| admin
3. Click Login
`

  it('reads the title from the heading', async () => {
    const { result } = await detect(MD_CASE)
    expect(result.testCase!.title).toBe('Log in with a valid user')
  })

  it('reads numbered steps and their test data', async () => {
    const { result } = await detect(MD_CASE)
    const steps = result.testCase!.steps
    expect(steps.map((s) => s.order)).toEqual([1, 2, 3])
    expect(steps[1]!.action).toBe('Enter the username')
    expect(steps[1]!.testData).toBe('admin')
  })
})

describe('Excel workbook adapter', () => {
  it('reads a selected worksheet from a binary xlsx workbook', async () => {
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Cover').addRow(['Notes'])
    const cases = workbook.addWorksheet('Cases')
    cases.addRow(['Test Case Title', 'Step Number', 'Action', 'Expected Result'])
    cases.addRow(['Create order', 1, 'Open the order page', 'Order page is visible'])
    const buffer = await workbook.xlsx.writeBuffer()

    expect(await workbookWorksheetNames(buffer)).toEqual(['Cover', 'Cases'])
    const csv = await workbookToCsv(buffer, 'Cases')
    const detected = await detect(csv)
    expect(detected.kind).toBe('excel')
    const { result } = detected
    expect(result.testCase?.title).toContain('Create order')
    expect(result.testCase?.steps[0]?.action).toBe('Open the order page')
    expect(result.testCase?.steps[0]?.expectedResult).toBe('Order page is visible')
  })

  it('reports an unavailable worksheet by name', async () => {
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Cases').addRow(['Test Case Title'])
    const buffer = await workbook.xlsx.writeBuffer()
    await expect(workbookToCsv(buffer, 'Missing')).rejects.toThrow(/Available worksheets: Cases/)
  })

  it('accepts explicit column mapping when workbook headers are custom', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Cases')
    sheet.addRow(['Scenario', 'Sequence', 'What to do', 'What should happen'])
    sheet.addRow(['Create order', 1, 'Open the order page', 'Order page is visible'])
    const buffer = await workbook.xlsx.writeBuffer()
    const headers = await workbookColumnHeaders(buffer, 'Cases')
    expect(ambiguousExcelColumns(headers)).toContain('action')
    const csv = await workbookToCsv(buffer, 'Cases', { title: 1, stepIndex: 2, action: 3, expected: 4 })
    const { result } = await detect(csv)
    expect(result.testCase?.title).toBe('Create order')
    expect(result.testCase?.steps[0]?.expectedResult).toBe('Order page is visible')
  })
})

describe('input rejection', () => {
  it('returns no test case for whitespace-only input', async () => {
    const { result } = await detect('   \n  \n')
    expect(result.testCase).toBeNull()
    expect(result.issues.length).toBeGreaterThan(0)
  })

  it('never silently swallows a problem', async () => {
    const { result } = await detect('')
    expect(result.issues.length).toBeGreaterThan(0)
    for (const issue of result.issues) {
      expect(issue.message.trim().length).toBeGreaterThan(10)
      expect(issue.severity === 'error' || issue.severity === 'warning').toBe(true)
    }
  })

  it('resolve() returns an adapter for each registered kind', () => {
    for (const kind of ['txt', 'markdown', 'excel', 'jira'] as const) {
      expect(resolve(kind)).toBeDefined()
    }
  })
})
