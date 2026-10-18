/**
 * Excel / CSV adapter.
 *
 * Real .xlsx parsing requires a runtime dependency (exceljs).  This adapter
 * uses a CSV-with-header parser as the primary implementation and returns a
 * clear uncertainty when given a binary Excel file that it cannot parse.
 *
 * Column detection is case-insensitive and tolerant of common aliases.
 */

import type {
  TestCaseIssue,
  TestCaseMetadata,
  TestCaseNormalizationResult,
  TestCaseSourceInfo,
  TestCaseStep,
} from '@tcoe/shared-types'

import { TestCaseAdapter, normaliseAction, parsePriority } from './abstract-adapter.ts'
import ExcelJS from 'exceljs'

/** Convert an Excel workbook's selected worksheet to CSV for the shared parser. */
function excelBuffer(buffer: unknown): Parameters<ExcelJS.Workbook['xlsx']['load']>[0] {
  if (!(buffer instanceof ArrayBuffer) && !ArrayBuffer.isView(buffer)) {
    throw new Error('Excel workbook input must be a binary buffer.')
  }
  const bytes = buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  return Uint8Array.from(bytes).buffer as Parameters<ExcelJS.Workbook['xlsx']['load']>[0]
}

// Column name variants recognised by the spreadsheet parser.
const STEP_NAMES = new Set(['step', 'step#', 'stepno', 'step_no', 'number', 'no', 'num', 'idx'])
const PRECONDITION_NAMES = new Set(['precondition', 'precondition', 'precond', 'given', 'setup'])
const ACTION_NAMES = new Set(['action', 'test action', 'testaction', 'instruction', 'step description', 'description'])
const EXPECTED_NAMES = new Set(['expected', 'expected result', 'expectedresult', 'expected outcome', 'result', 'verify', 'assertion'])
const TITLE_NAMES = new Set(['title', 'test title', 'testtitle', 'test case title', 'testcase', 'name', 'test name'])
const APPLICATION_NAMES = new Set(['application', 'app', 'module', 'feature', 'area'])
const STATUS_NAMES = new Set(['status', 'state'])

export type ExcelColumnField = 'title' | 'action' | 'expected' | 'precondition' | 'application' | 'stepIndex' | 'status'
export type ExcelColumnMapping = Partial<Record<ExcelColumnField, number>>

const COLUMN_ALIASES: Record<ExcelColumnField, string[]> = {
  title: [...TITLE_NAMES],
  action: [...ACTION_NAMES],
  expected: [...EXPECTED_NAMES],
  precondition: [...PRECONDITION_NAMES],
  application: [...APPLICATION_NAMES],
  stepIndex: [...STEP_NAMES],
  status: [...STATUS_NAMES],
}

function columnMatchScore(header: string, field: ExcelColumnField): number {
  const normalized = normaliseColumnName(header)
  return COLUMN_ALIASES[field].reduce((score, alias) => {
    const candidate = normaliseColumnName(alias)
    if (normalized === candidate) return Math.max(score, 2)
    if (candidate.length >= 4 && normalized.includes(candidate)) return Math.max(score, 1)
    return score
  }, 0)
}

function columnMatches(header: string, field: ExcelColumnField): boolean {
  return columnMatchScore(header, field) > 0
}

function getWorksheet(workbook: ExcelJS.Workbook, worksheetName?: string): ExcelJS.Worksheet {
  const sheet = worksheetName ? workbook.getWorksheet(worksheetName) : workbook.worksheets[0]
  if (!sheet) {
    const available = workbook.worksheets.map((item) => item.name).join(', ')
    throw new Error(worksheetName
      ? `Worksheet "${worksheetName}" was not found. Available worksheets: ${available || '(none)'}.`
      : 'The workbook contains no worksheets.')
  }
  return sheet
}

export async function workbookColumnHeaders(buffer: unknown, worksheetName?: string): Promise<string[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(excelBuffer(buffer))
  let headers: string[] = []
  getWorksheet(workbook, worksheetName).eachRow({ includeEmpty: false }, (row) => {
    if (headers.length > 0) return
    headers = (row.values as unknown[]).slice(1).map((value) => String(value ?? '').trim())
  })
  return headers
}

export function ambiguousExcelColumns(headers: string[]): ExcelColumnField[] {
  const fields = Object.keys(COLUMN_ALIASES) as ExcelColumnField[]
  const ambiguous = new Set<ExcelColumnField>()
  for (const header of headers) {
    const scores = fields.map((field) => ({ field, score: columnMatchScore(header, field) })).filter((item) => item.score > 0)
    const best = Math.max(0, ...scores.map((item) => item.score))
    const winners = scores.filter((item) => item.score === best)
    if (winners.length > 1) for (const winner of winners) ambiguous.add(winner.field)
  }
  for (const field of fields) {
    const matches = headers.filter((header) => columnMatches(header, field)).length
    if (matches > 1 || (field === 'action' && matches === 0)) ambiguous.add(field)
  }
  return [...ambiguous]
}

export async function workbookToCsv(buffer: unknown, worksheetName?: string, mapping: ExcelColumnMapping = {}): Promise<string> {
  const selectedColumns = Object.values(mapping).filter((index): index is number => index !== undefined)
  if (new Set(selectedColumns).size !== selectedColumns.length) {
    throw new Error('Each mapped Excel field must use a different column. Select the correct field or skip the optional mapping.')
  }
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(excelBuffer(buffer))
  const sheet = getWorksheet(workbook, worksheetName)
  const rows: string[] = []
  let headerSeen = false
  const canonical: Record<ExcelColumnField, string> = {
    title: 'Test Case Title', action: 'Action', expected: 'Expected Result', precondition: 'Precondition',
    application: 'Application', stepIndex: 'Step Number', status: 'Status',
  }
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as Array<unknown>
    const cells = values.slice(1).map((value, index) => {
      const text = value instanceof Date ? value.toISOString() : String(value ?? '')
      let cell = text
      if (!headerSeen) {
        const selectedField = (Object.keys(mapping) as ExcelColumnField[]).find((field) => mapping[field] === index + 1)
        if (selectedField) cell = canonical[selectedField]
        else if ((Object.keys(mapping) as ExcelColumnField[]).some((field) => mapping[field] !== undefined && columnMatches(text, field))) {
          cell = `Column ${index + 1}`
        }
      }
      return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
    })
    rows.push(cells.join(','))
    headerSeen = true
  })
  return rows.join('\n')
}

export async function workbookWorksheetNames(buffer: unknown): Promise<string[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(excelBuffer(buffer))
  return workbook.worksheets.map((sheet) => sheet.name)
}

// Column name variants we recognise (lower-cased for comparison).
function normaliseColumnName(col: string): string {
  return col.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function matchColumn(name: string, variants: Set<string>): boolean {
  const norm = normaliseColumnName(name)
  return [...variants].some((variant) => {
    const alias = normaliseColumnName(variant)
    return norm === alias || norm.includes(alias)
  })
}

interface ParsedRow {
  [key: string]: string
}

interface ColumnMap {
  stepIndex: number
  precondition: number
  action: number
  expected: number
  title: number
  application: number
  status: number
  [key: string]: number
}

/** Parse a CSV string with a header row.  Returns rows and a column map. */
function parseCsvWithHeader(csv: string): { rows: ParsedRow[]; cols: ColumnMap; rawHeaders: string[] } {
  const rawLines = csv.split(/\r?\n/).filter((l) => l.trim())
  if (rawLines.length < 2) return { rows: [], cols: { stepIndex: -1, precondition: -1, action: -1, expected: -1, title: -1, application: -1, status: -1 }, rawHeaders: [] }

  // Split on comma, respecting quoted fields.
  const splitRow = (line: string): string[] => {
    const cells: string[] = []
    let cur = ''
    let inQuote = false
    for (const ch of line) {
      if (ch === '"') {
        inQuote = !inQuote
      } else if (ch === ',' && !inQuote) {
        cells.push(cur.trim())
        cur = ''
      } else {
        cur += ch
      }
    }
    cells.push(cur.trim())
    return cells
  }

  const headers = splitRow(rawLines[0]!)
  const rows: ParsedRow[] = []
  for (let i = 1; i < rawLines.length; i++) {
    const cells = splitRow(rawLines[i]!)
    const row: ParsedRow = {}
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = cells[j] ?? ''
    }
    rows.push(row)
  }

  const findCol = (variants: Set<string>): number => {
    for (let i = 0; i < headers.length; i++) {
      if (matchColumn(headers[i]!, variants)) return i
    }
    return -1
  }

  const cols: ColumnMap = {
    stepIndex: findCol(STEP_NAMES),
    precondition: findCol(PRECONDITION_NAMES),
    action: findCol(ACTION_NAMES),
    expected: findCol(EXPECTED_NAMES),
    title: findCol(TITLE_NAMES),
    application: findCol(APPLICATION_NAMES),
    status: findCol(STATUS_NAMES),
  }

  return { rows, cols, rawHeaders: headers }
}

export class ExcelTestCaseAdapter extends TestCaseAdapter {
  constructor() {
    super('excel')
  }

  /**
   * A CSV is only claimed when its header row names a real column. Treating
   * "any line with a comma" as a spreadsheet header lets prose and plain-text
   * test cases through, because they routinely contain commas.
   */
  override supports(raw: string): boolean {
    const firstBytes = raw.slice(0, 4)
    if (firstBytes.charCodeAt(0) === 0x50 && firstBytes.charCodeAt(1) === 0x4b) return true

    const header = raw.split(/\r?\n/).find((line) => line.trim().length > 0)
    if (!header) return false

    const cells = header
      .split(',')
      .map((cell) => cell.trim().toLowerCase())
      .filter((cell) => cell.length > 0)
    if (cells.length < 2) return false

    const known = [...STEP_NAMES, ...ACTION_NAMES, ...EXPECTED_NAMES, ...TITLE_NAMES, ...PRECONDITION_NAMES]
    return cells.some((cell) => known.some((variant) => cell === variant || cell === variant.replace(/[^a-z0-9]/g, '')))
  }

  async parse(
    raw: string,
    options?: { permissive?: boolean },
  ): Promise<TestCaseNormalizationResult> {
    const issues: TestCaseIssue[] = []

    // Detect binary Excel format markers (PK.. header for .xlsx, BIFF for .xls).
    const firstBytes = raw.slice(0, 8)
    if (
      firstBytes.charCodeAt(0) === 0x50 && // P
      firstBytes.charCodeAt(1) === 0x4b && // K
      firstBytes.charCodeAt(2) === 0x03    // (xlsx is a zip)
    ) {
      return {
        testCase: null,
        issues: [
          {
            severity: 'error',
            field: 'source',
            message:
              'Input appears to be a binary .xlsx file. TCOE TestPilot cannot parse .xlsx natively.',
            suggestion:
              'Save the spreadsheet as a CSV file and paste the CSV content instead. Ensure all columns are preserved and no data is truncated.',
          },
        ],
      }
    }

    if (firstBytes.charCodeAt(0) === 0xd0 && firstBytes.charCodeAt(1) === 0xcf) {
      return {
        testCase: null,
        issues: [
          {
            severity: 'error',
            field: 'source',
            message:
              'Input appears to be a binary .xls (Excel 97–2003) file. This format is not supported.',
            suggestion: 'Save the spreadsheet as .xlsx or .csv and paste the content.',
          },
        ],
      }
    }

    // Treat everything else as CSV.
    const { rows, cols, rawHeaders } = parseCsvWithHeader(raw)

    if (rows.length === 0) {
      return {
        testCase: null,
        issues: [{ severity: 'error', field: 'source', message: 'No data rows found in the CSV input.' }],
      }
    }

    if (rawHeaders.length === 0) {
      return {
        testCase: null,
        issues: [{ severity: 'error', field: 'source', message: 'No header row found. The first row must contain column names.' }],
      }
    }

    const uncertainties: string[] = []
    const headerNote = rawHeaders.join(', ')
    if (cols.action === -1) {
      uncertainties.push(
        `No action/step column found among [${headerNote}]. Steps may not be extracted correctly.`,
      )
    }

    const titleCol = cols.title >= 0 ? cols.title : rawHeaders.indexOf(rawHeaders.find((h) => matchColumn(h, TITLE_NAMES)) ?? '')
    const appCol = cols.application >= 0 ? cols.application : -1
    const statusCol = cols.status >= 0 ? cols.status : -1
    const preCol = cols.precondition >= 0 ? cols.precondition : -1

    // Group rows into test cases by title column (when present).
    const cases: Map<string, ParsedRow[]> = new Map()
    for (const row of rows) {
      const key = titleCol >= 0 ? (row[rawHeaders[titleCol]!] ?? '(untitled)') : '(single case)'
      if (!cases.has(key)) cases.set(key, [])
      cases.get(key)!.push(row)
    }

    // For MVP: produce a single test case from the first group.
    const firstKey = [...cases.keys()][0]!
    const caseRows = cases.get(firstKey)!

    const metadata: TestCaseMetadata = { tags: [] }
    const preconditions: string[] = []
    const steps: TestCaseStep[] = []
    let stepOrder = 0
    let explicitTitle = false

    for (const row of caseRows) {
      const titleCell = titleCol >= 0 ? row[rawHeaders[titleCol]!] : undefined
      if (titleCell && titleCell.trim() && !explicitTitle) {
        metadata.tags.push(`@${titleCell.trim().replace(/[^a-zA-Z0-9-_]/g, '_')}`)
        explicitTitle = true
      }

      if (appCol >= 0) {
        const app = row[rawHeaders[appCol]!]
        if (app?.trim()) metadata.application = app.trim()
      }

      if (preCol >= 0) {
        const pre = row[rawHeaders[preCol]!]
        if (pre?.trim()) preconditions.push(pre.trim())
      }

      if (statusCol >= 0) {
        const status = row[rawHeaders[statusCol]!]
        if (status?.toLowerCase().includes('pass')) metadata.tags.push('@passed')
        if (status?.toLowerCase().includes('fail')) metadata.tags.push('@failed')
      }

      const actionCell =
        cols.action >= 0 ? row[rawHeaders[cols.action]!] :
        rawHeaders[0] !== undefined ? row[rawHeaders[0]!] : undefined

      if (actionCell?.trim()) {
        stepOrder++
        const { action, testData } = normaliseAction(actionCell)

        const expectedCell = cols.expected >= 0 ? row[rawHeaders[cols.expected]!] : undefined
        const expectedRaw = expectedCell?.trim()

        steps.push({
          order: stepOrder,
          action,
          expectedResult: expectedRaw
            ? expectedRaw.replace(/^(expected[:\s]*|verify[:\s]*)/i, '').trim()
            : undefined,
          testData: testData as TestCaseStep['testData'],
        })
      }
    }

    const title = explicitTitle ? [...cases.keys()][0]! : '(untitled spreadsheet)'
    if (!explicitTitle) {
      issues.push({
        severity: 'warning',
        field: 'title',
        message: 'No title column detected. Using the first column value or "(untitled spreadsheet)" as title.',
      })
    }

    if (steps.length === 0) {
      issues.push({
        severity: 'warning',
        field: 'steps',
        message: `No step rows could be extracted. Check that the first row is a header and subsequent rows contain step descriptions.`,
      })
    }

    const testCase =
      title
        ? {
            metadata,
            title,
            preconditions,
            steps,
            testData: {},
            source: {
              kind: 'excel',
              reference: 'inline spreadsheet',
              ambiguous: steps.length === 0,
              assumptions: [...uncertainties],
            } satisfies TestCaseSourceInfo,
          }
        : null

    return { testCase, issues }
  }
}
