/**
 * Index staleness detection.
 *
 * Compares the fingerprints of the current scan against a previously saved
 * index on disk, so the agent can tell a human when its understanding of the
 * framework has drifted from the source.
 *
 * The saved index is always written inside a caller-supplied directory that has
 * been validated against the Workspace containment check.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { StalenessFinding } from './analyzer-report-types.ts'

/** One indexed file as persisted in the index file. */
export interface IndexEntry {
  relativePath: string
  fingerprint: string
}

/** The persisted index shape. */
export interface SavedIndex {
  version: 1
  savedAt: string
  repositoryRoot: string
  files: IndexEntry[]
}

export interface StalenessResult {
  indexIsStale: boolean
  changes: StalenessFinding[]
  /** True when no prior index existed, so this is a first index. */
  firstIndex: boolean
  /** Path of the index file, or null when none was written. */
  indexPath?: string
}

export const INDEX_FILE_NAME = 'framework-index.json'

/**
 * Compare the current scan against a saved index.
 *
 * `scan` may be null when the scanner has not run; in that case the result is
 * reported as unchanged rather than guessed.
 */
export function checkStaleness(
  scan: IndexEntry[] | null,
  indexPath: string,
): StalenessResult {
  if (!scan) {
    return { indexIsStale: false, changes: [], firstIndex: false, indexPath }
  }

  if (!existsSync(indexPath)) {
    return { indexIsStale: false, changes: [], firstIndex: true, indexPath }
  }

  let saved: SavedIndex
  try {
    saved = JSON.parse(readFileSync(indexPath, 'utf-8')) as SavedIndex
  } catch {
    // A corrupt index is treated as no index rather than a hard failure.
    return { indexIsStale: false, changes: [], firstIndex: true, indexPath }
  }

  const previous = new Map(saved.files.map((f) => [f.relativePath, f.fingerprint]))
  const current = new Map(scan.map((f) => [f.relativePath, f.fingerprint]))

  const changes: StalenessFinding[] = []

  for (const [path, fingerprint] of current) {
    const before = previous.get(path)
    if (before === undefined) {
      changes.push({ file: path, change: 'new', currentFingerprint: fingerprint })
    } else if (before !== fingerprint) {
      changes.push({ file: path, change: 'modified', previousFingerprint: before, currentFingerprint: fingerprint })
    }
  }

  for (const [path, fingerprint] of previous) {
    if (!current.has(path)) {
      changes.push({ file: path, change: 'deleted', previousFingerprint: fingerprint })
    }
  }

  return {
    indexIsStale: changes.length > 0,
    changes,
    firstIndex: false,
    indexPath,
  }
}

/**
 * Persist the current scan as the index for the next run.
 *
 * The target directory must already have been validated to sit inside the
 * workspace; this function resolves the path and refuses to write outside it.
 */
export function saveIndex(
  scan: IndexEntry[],
  targetDir: string,
  workspaceRoot: string,
  repositoryRoot: string,
): string {
  const dir = resolve(targetDir)
  const root = resolve(workspaceRoot)

  // Containment check: refuse to write outside the workspace.
  if (dir !== root && !dir.startsWith(root + '/') && !dir.startsWith(root + '\\')) {
    throw new Error(
      `Refusing to write the framework index outside the workspace: ${dir} is not inside ${root}.`,
    )
  }

  mkdirSync(dir, { recursive: true })
  const indexPath = join(dir, INDEX_FILE_NAME)

  const index: SavedIndex = {
    version: 1,
    savedAt: new Date().toISOString(),
    repositoryRoot,
    files: scan.map((f) => ({ relativePath: f.relativePath, fingerprint: f.fingerprint })),
  }

  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')
  return indexPath
}