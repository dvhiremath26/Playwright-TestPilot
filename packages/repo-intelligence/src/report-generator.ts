/**
 * Top-level framework analysis.
 *
 * `analyzeFramework` is the single deterministic entry point the agent calls:
 * scan the repository, analyze it, detect duplicates and reuse for an incoming
 * manual test case, and produce the discovery report with real staleness data.
 *
 * No model calls anywhere in this module — the whole pipeline is reproducible
 * from source alone.
 */

import { join } from 'node:path'

import type { AnalysisResult } from './analyzer.ts'
import type { ScanResult, ScannedFile } from './scanner.ts'
import type {
  FrameworkFacts,
  ReuseReport,
  TestCase,
} from '@tcoe/shared-types'
import type { FrameworkDiscoveryReport } from './analyzer-report-types.ts'

import { FrameworkAnalyzer } from './analyzer.ts'
import { generateDiscoveryReport } from './analyzer-report.ts'
import { RepositoryScanner } from './scanner.ts'
import { Workspace } from './workspace.ts'
import { buildReuseReport } from './reuse-analyzer.ts'
import { checkStaleness, saveIndex, INDEX_FILE_NAME } from './staleness.ts'
import type { StalenessResult } from './staleness.ts'
import { fingerprint } from './fingerprint.ts'

// ScanResult and ScannedFile are re-exported by ./scanner; re-exporting them
// here as well would make the barrel export in ./index ambiguous.
export type { AnalysisResult }

/** The complete analysis result handed back to the agent. */
export interface FrameworkAnalysisResult {
  facts: FrameworkFacts
  analysis: AnalysisResult
  scan: ScanResult
  report: FrameworkDiscoveryReport
  /** Present only when a test case was supplied. */
  reuse?: ReuseReport
  staleness: StalenessResult
}

export interface AnalyzeFrameworkOptions {
  /** The repository root to analyze. */
  repositoryRoot: string
  /** The incoming manual test case, when the task has one. */
  testCase?: TestCase
  /**
   * Directory the framework index may be written to. It must resolve inside
   * the repository root; this is verified before anything is written.
   * Omit to skip persistence and staleness entirely.
   */
  indexDir?: string
  /** When false, the index is not written (read-only analysis). */
  persistIndex?: boolean
}

/** Adapt ScannedFile to the fingerprint shape the staleness check expects. */
function toIndexEntry(file: ScannedFile): { relativePath: string; fingerprint: string } {
  return { relativePath: file.relativePath, fingerprint: fingerprint(file.content) }
}

/**
 * Analyze the framework and, when a test case is supplied, assess reuse.
 */
export function analyzeFramework(
  options: AnalyzeFrameworkOptions,
): FrameworkAnalysisResult {
  const { repositoryRoot, testCase, indexDir, persistIndex = true } = options

  const workspace = new Workspace(repositoryRoot)
  const scanner = new RepositoryScanner(workspace)
  const scan = scanner.scan()

  const analyzer = new FrameworkAnalyzer(workspace)
  const analysis = analyzer.analyze(scan)
  const { facts } = analysis

  let report = generateDiscoveryReport(analysis)

  // --- staleness
  let staleness: StalenessResult = {
    indexIsStale: false,
    changes: [],
    firstIndex: false,
  }

  if (indexDir) {
    const indexPath = join(indexDir, INDEX_FILE_NAME)
    staleness = checkStaleness(scan.files.map(toIndexEntry), indexPath)

    if (persistIndex) {
      saveIndex(
        scan.files.map(toIndexEntry),
        indexDir,
        workspace.rootPath,
        facts.repositoryRoot,
      )
    }

    report = {
      ...report,
      staleness: {
        indexIsStale: staleness.indexIsStale,
        changes: staleness.changes,
      },
    }

    if (staleness.firstIndex) {
      report = {
        ...report,
        uncertainties: [
          ...report.uncertainties,
          'No previous framework index existed. This is the first analysis of this repository.',
        ],
      }
    } else if (staleness.indexIsStale) {
      report = {
        ...report,
        uncertainties: [
          ...report.uncertainties,
          `${staleness.changes.length} file(s) changed since the last index. The facts below reflect the current source, not the stale index.`,
        ],
      }
    }
  }

  // --- reuse analysis
  let reuse: ReuseReport | undefined
  if (testCase) {
    reuse = buildReuseReport(testCase, facts)
    report = {
      ...report,
      functionalityGaps: buildGaps(reuse),
    }
  }

  return { facts, analysis, scan, report, reuse, staleness }
}

/** Turn missing framework capability into concrete gap entries. */
function buildGaps(reuse: ReuseReport) {
  const gaps: FrameworkDiscoveryReport['functionalityGaps'] = []

  for (const line of reuse.missingFunctionality) {
    const match = /^Step (\d+): "(.*)" — (.+)$/.exec(line)
    const stepNumber = match?.[1] ? parseInt(match[1], 10) : 0
    const requirement = match?.[2] ?? line
    const explanation = match?.[3] ?? 'No indexed action method plausibly covers this step.'

    gaps.push({
      requirement,
      explanation,
      affectedSteps: stepNumber > 0 ? [stepNumber] : [],
      recommendation:
        'Plan a new action method, review it with a human, then reference it from the generated test.',
    })
  }

  return gaps
}

/** A compact human-readable summary, for CLI output and Quick Pick previews. */
export function summariseAnalysis(result: FrameworkAnalysisResult): string {
  const { report, reuse, staleness } = result
  const lines: string[] = []

  lines.push(`Framework:        ${report.identity.packageName ?? '(unnamed package)'}`)
  lines.push(`Playwright config: ${report.execution.playwrightConfigPath ?? 'not found'}`)
  lines.push(`Files indexed:     ${report.fileInventory.totalScanned}`)
  lines.push(`Tests indexed:     ${result.facts.tests.length}`)
  lines.push(`Page objects:      ${result.facts.pageObjects.length}`)
  lines.push(`Locator fields:    ${result.facts.locators.length}`)
  lines.push(`Action methods:    ${report.actionsSurface.totalMethods}`)
  lines.push(`Facade namespaces: ${report.actionsSurface.namespaces.join(', ') || 'none'}`)
  lines.push(`Fixtures:          ${result.facts.fixtures.length}`)
  lines.push(`Index confidence:  ${report.indexConfidence}`)
  lines.push(
    `Index state:       ${staleness.firstIndex ? 'first index (no prior index)' : staleness.indexIsStale ? `stale (${staleness.changes.length} change(s))` : 'up to date'}`,
  )

  if (reuse) {
    lines.push('')
    lines.push(`Test case:         ${reuse.testCaseTitle}`)
    lines.push(`Decision:          ${reuse.decision.decision}`)
    lines.push(`  rationale:       ${reuse.decision.rationale}`)
    lines.push(`Duplicates:        ${reuse.duplicates.length}`)
    lines.push(`Helpers to reuse:  ${reuse.helperMethods.length}`)
    lines.push(`Missing capability:${String(reuse.missingFunctionality.length).padStart(2)} step(s)`)
    lines.push(`Reuse confidence:  ${reuse.confidence.score}`)
  }

  if (report.uncertainties.length > 0) {
    lines.push('')
    lines.push('Uncertainties:')
    for (const u of report.uncertainties) lines.push(`  - ${u}`)
  }

  return lines.join('\n')
}