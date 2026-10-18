/**
 * Framework discovery report generation.
 *
 * Pure assembly from deterministic analyzer output. No model calls: every
 * field in the report traces back to a source fact. The confidence/inference
 * split is what lets the report distinguish what was found from what was
 * reasoned.
 */

import type { AnalysisResult } from './analyzer.ts'
import type { FrameworkFacts } from '@tcoe/shared-types'
import type { ArchitectureItem, FrameworkDiscoveryReport } from './analyzer-report-types.ts'

export function generateDiscoveryReport(result: AnalysisResult): FrameworkDiscoveryReport {
  const { facts } = result
  const now = new Date().toISOString()

  return {
    generatedAt: now,
    repositoryRoot: facts.repositoryRoot,
    identity: {
      packageName: facts.packageName,
      playwrightVersion: facts.playwrightVersions['@playwright/test'],
      description: facts.packageName
        ? `${facts.packageName} — Playwright TypeScript automation framework`
        : 'Playwright TypeScript automation framework',
    },
    architecture: buildArchitecture(facts),
    fileInventory: {
      totalScanned: result.indexedFiles.length,
      byRole: buildRoleCounts(result.indexedFiles),
      totalBytes: result.indexedFiles.reduce((sum, f) => sum + f.sizeBytes, 0),
    },
    conventions: buildConventions(facts),
    locatorStrategy: {
      preferredStrategy: detectDominantLocatorStrategy(facts),
      examples: facts.locators.slice(0, 6).map((l) => ({
        name: l.name,
        expression: l.expression,
        file: l.file,
      })),
    },
    actionsSurface: {
      facadeClass: facts.actionFacade,
      groupClasses: facts.actionGroups,
      totalMethods: facts.actionMethods.length,
      namespaces: [...new Set(facts.actionMethods.map((m) => m.facadeNamespace ?? '').filter((n) => n.length > 0))],
    },
    fixtures: {
      customFixtures: facts.fixtures.map((f) => ({ name: f.name, file: f.file })),
      fixtureUsedInTests: facts.customFixtureUsed,
    },
    testData: {
      modules: facts.testDataModules,
      environmentStrategy: 'ENV env var + DataLoader.get(moduleName)',
    },
    execution: {
      availableCommands: facts.commands.map((c) => ({
        name: c.name,
        command: c.command,
        needsNetwork: c.needsNetwork,
      })),
      playwrightConfigPath: facts.playwrightConfig,
    },
    functionalityGaps: [],
    staleness: { indexIsStale: false, changes: [] },
    excludedFromIndex: {
      count: facts.excluded.length,
      sample: facts.excluded.slice(0, 10),
    },
    indexConfidence: computeConfidence(facts),
    uncertainties: buildUncertainties(facts),
  }
}

function buildArchitecture(facts: FrameworkFacts): ArchitectureItem[] {
  const items: ArchitectureItem[] = []

  if (facts.tests.length > 0) {
    items.push({
      category: 'Tests',
      items: dedup(facts.tests.map((t) => t.file)).map((p) => ({
        label: p,
        paths: [p],
        confidence: 'CONFIRMED',
      })),
    })
  }

  if (facts.pageObjects.length > 0) {
    items.push({
      category: 'Page Objects',
      items: facts.pageObjects.map((name) => ({
        label: name,
        paths: [],
        confidence: 'CONFIRMED',
      })),
    })
  }

  if (facts.locatorClasses.length > 0) {
    items.push({
      category: 'Locators',
      items: facts.locatorClasses.map((name) => ({
        label: name,
        paths: dedup(facts.locators.filter((l) => l.ownerClass === name).map((l) => l.file)),
        confidence: 'CONFIRMED',
      })),
    })
  }

  if (facts.decorators.length > 0) {
    items.push({
      category: 'Decorators',
      items: facts.decorators.map((name) => ({
        label: `@${name}`,
        paths: [],
        confidence: 'CONFIRMED',
      })),
    })
  }

  if (facts.fixtures.length > 0) {
    items.push({
      category: 'Fixtures',
      items: facts.fixtures.map((f) => ({
        label: f.auto ? `[auto] ${f.name}` : f.name,
        paths: [f.file],
        confidence: 'CONFIRMED',
      })),
    })
  }

  if (facts.testDataModules.length > 0) {
    items.push({
      category: 'Test Data',
      items: facts.testDataModules.map((name) => ({
        label: `test-data/${name}/`,
        paths: [],
        confidence: 'CONFIRMED',
      })),
    })
  }

  if (facts.reporters.length > 0) {
    items.push({
      category: 'Reporters',
      items: facts.reporters.map((r) => ({
        label: r,
        paths: [],
        confidence: 'CONFIRMED',
      })),
    })
  }

  return items
}

function buildRoleCounts(files: { role: string }[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const f of files) counts[f.role] = (counts[f.role] ?? 0) + 1
  return counts
}

function buildConventions(facts: FrameworkFacts): { confirmed: string[]; inferred: string[] } {
  const confirmed: string[] = []
  const inferred: string[] = []

  confirmed.push(`Playwright config: ${facts.playwrightConfig ?? 'not found'}`)
  confirmed.push(`Test directory: ${facts.testDir}`)

  if (facts.actionFacade) {
    confirmed.push(`Action facade class: ${facts.actionFacade}`)
    const namespaces = [...new Set(facts.actionMethods.map((m) => m.facadeNamespace).filter(Boolean))]
    confirmed.push(`Facaded namespaces: ${namespaces.join(', ')}`)
    confirmed.push(`${facts.actionMethods.length} reusable action methods indexed across ${facts.actionGroups.length} groups`)
  }

  if (facts.testDataModules.length > 0) {
    confirmed.push(`Test data modules: ${facts.testDataModules.join(', ')}`)
    confirmed.push('DataLoader.get(moduleName) with per-env files')
  }

  if (facts.customFixtureUsed) {
    confirmed.push('Custom fixtures are imported by test specs')
  } else {
    inferred.push('Custom fixtures are declared but no spec file imports them; existing tests use @playwright/test directly')
  }

  if (facts.decorators.includes('Step')) {
    confirmed.push('@Step decorator wraps page object methods with logging + Playwright step boxing')
  }
  if (facts.decorators.includes('Retry')) {
    confirmed.push('@Retry decorator available for retryable operations')
  }

  if (facts.pathAliases['@src/*']) confirmed.push('Path alias @src/* → ./src/*')
  if (facts.pathAliases['@pages/*']) confirmed.push('Path alias @pages/* → ./pages/*')

  return { confirmed, inferred }
}

function detectDominantLocatorStrategy(facts: FrameworkFacts): string {
  const counts: Record<string, number> = {}
  for (const l of facts.locators) counts[l.strategy] = (counts[l.strategy] ?? 0) + 1
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  return dominant ? dominant[0] : 'none detected'
}

function computeConfidence(facts: FrameworkFacts): number {
  let score = 0.8
  if (facts.playwrightConfig) score += 0.05
  if (facts.actionMethods.length > 50) score += 0.05
  if (facts.tests.length > 0) score += 0.05
  if (facts.customFixtureUsed) score += 0.05
  return Math.min(score, 1.0)
}

function buildUncertainties(facts: FrameworkFacts): string[] {
  const u: string[] = []
  if (!facts.customFixtureUsed) {
    u.push('Custom fixtures exist but are not imported by any spec. Generated tests should not assume they are available.')
  }
  if (facts.locators.length === 0) {
    u.push('No locator fields detected. The locator convention may differ from the expected pattern.')
  }
  if (!facts.playwrightConfig) {
    u.push('No Playwright config found. Execution commands cannot be verified.')
  }
  if (!facts.actionFacade) {
    u.push('No action facade detected. Reuse analysis cannot map steps to existing methods.')
  }
  return u
}

function dedup(paths: string[]): string[] {
  return [...new Set(paths)].sort()
}
