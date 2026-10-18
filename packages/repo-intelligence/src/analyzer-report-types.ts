/**
 * Contracts for framework discovery reporting.
 *
 * These are kept separate so the report generator (which depends on the model
 * for prose generation) can live alongside the purely deterministic analyzer.
 */

/** A single item in the framework architecture section of the discovery report. */
export interface ArchitectureItem {
  category: string
  items: ArchitectureEntry[]
}

export interface ArchitectureEntry {
  /** Human-readable label. */
  label: string
  /** Repository-relative paths. */
  paths: string[]
  /** CONFIRMED if the item was actually found; INFERRED if derived from a convention. */
  confidence: 'CONFIRMED' | 'INFERRED'
}

/** A gap between what the manual test case needs and what the framework provides. */
export interface FunctionalityGap {
  /** What the manual test case requires. */
  requirement: string
  /** Why it is missing or not implemented yet. */
  explanation: string
  /** Steps that cannot be fulfilled without this. */
  affectedSteps: number[]
  /** What the agent recommends. */
  recommendation: string
}

/** One finding from the stale-index check. */
export interface StalenessFinding {
  file: string
  /** What changed. */
  change: 'modified' | 'deleted' | 'new'
  previousFingerprint?: string
  currentFingerprint?: string
}

/** The full framework discovery report. */
export interface FrameworkDiscoveryReport {
  generatedAt: string
  repositoryRoot: string
  /** What the framework was identified as. */
  identity: {
    packageName?: string
    playwrightVersion?: string
    description: string
  }
  architecture: ArchitectureItem[]
  fileInventory: {
    totalScanned: number
    byRole: Record<string, number>
    totalBytes: number
  }
  conventions: {
    /** Confirmed patterns the agent must follow. */
    confirmed: string[]
    /** Patterns inferred from structure, not guaranteed. */
    inferred: string[]
  }
  locatorStrategy: {
    preferredStrategy: string
    examples: { name: string; expression: string; file: string }[]
  }
  actionsSurface: {
    facadeClass?: string
    groupClasses: string[]
    totalMethods: number
    namespaces: string[]
  }
  fixtures: {
    customFixtures: { name: string; file: string }[]
    fixtureUsedInTests: boolean
  }
  testData: {
    modules: string[]
    environmentStrategy: string
  }
  execution: {
    availableCommands: { name: string; command: string; needsNetwork: boolean }[]
    playwrightConfigPath?: string
  }
  functionalityGaps: FunctionalityGap[]
  staleness: {
    indexIsStale: boolean
    changes: StalenessFinding[]
  }
  excludedFromIndex: {
    count: number
    sample: { relativePath: string; reason: string }[]
  }
  /** Overall confidence that the index reflects the current state. */
  indexConfidence: number
  uncertainties: string[]
}
