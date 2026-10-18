/**
 * Applying approved changes, checkpointing, and reporting.
 *
 * Nothing here runs unless the plan was approved. Every write goes through the
 * Workspace containment check, so a path the model invented cannot escape the
 * target repository.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

import type {
  AgentStage,
  FileChange,
  StageRecord,
  TaskCheckpoint,
  TaskRecord,
  TaskStatus,
} from '@tcoe/shared-types'

import { Workspace } from '@tcoe/repo-intelligence'
import { fingerprint } from '@tcoe/repo-intelligence'

export interface ApplyOptions {
  repositoryRoot: string
  stateDir: string
  task: TaskRecord
  /** The approved changes to write. */
  changes: FileChange[]
  /** Write the files. When false, the changes are only previewed. */
  dryRun?: boolean
}

export interface ApplyResult {
  /** Paths actually written, repository-relative. */
  written: string[]
  /** Paths that would be written, when dryRun is true. */
  wouldWrite: string[]
  skipped: { path: string; reason: string }[]
  /** Unified diffs, for review. */
  diffs: { path: string; diff: string }[]
}

/** Build a minimal unified diff between two texts. */
export function buildUnifiedDiff(
  path: string,
  original: string | undefined,
  next: string,
): string {
  const before = (original ?? '').split('\n')
  const after = next.split('\n')
  const lines: string[] = [
    `--- a/${path}`,
    `+++ b/${path}`,
  ]

  // Simple LCS-based line diff.
  const rows = before.length + 1
  const cols = after.length + 1
  const dp: number[] = new Array<number>(rows * cols).fill(0)
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      dp[i * cols + j] =
        before[i] === after[j]
          ? dp[(i + 1) * cols + (j + 1)]! + 1
          : Math.max(dp[(i + 1) * cols + j]!, dp[i * cols + (j + 1)]!)
    }
  }

  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      lines.push(` ${before[i]}`)
      i++
      j++
    } else if (dp[(i + 1) * cols + j]! >= dp[i * cols + (j + 1)]!) {
      lines.push(`-${before[i]}`)
      i++
    } else {
      lines.push(`+${after[j]}`)
      j++
    }
  }
  while (i < before.length) { lines.push(`-${before[i]!}`); i++ }
  while (j < after.length) { lines.push(`+${after[j]!}`); j++ }

  return lines.join('\n')
}

/**
 * Validate and write the approved changes.
 *
 * Paths are resolved against the repository root through the Workspace guard,
 * which rejects traversal and symlink escapes.
 */
export function applyChanges(options: ApplyOptions): ApplyResult {
  const workspace = new Workspace(options.repositoryRoot)
  const result: ApplyResult = {
    written: [],
    wouldWrite: [],
    skipped: [],
    diffs: [],
  }

  for (const change of options.changes) {
    const resolved = workspace.tryResolve(change.path)

    if (!resolved) {
      result.skipped.push({
        path: change.path,
        reason: `Path resolves outside the repository root (${workspace.rootPath}). Refused for safety.`,
      })
      continue
    }

    const absolute = resolved.resolved
    const exists = existsSync(absolute)

    // Guard against clobbering a file the plan did not declare as a modify.
    if (change.kind === 'modify' && !exists) {
      result.skipped.push({
        path: change.path,
        reason: 'Plan says "modify" but the file does not exist. Refusing to guess.',
      })
      continue
    }
    if (change.kind === 'create' && exists) {
      result.skipped.push({
        path: change.path,
        reason: 'Plan says "create" but the file already exists. Refusing to overwrite an uninspected file.',
      })
      continue
    }
    if (change.kind === 'delete') {
      if (!options.dryRun) {
        try {
          rmSync(absolute)
          result.written.push(change.path)
        } catch (err) {
          result.skipped.push({ path: change.path, reason: err instanceof Error ? err.message : String(err) })
        }
      } else {
        result.wouldWrite.push(change.path)
      }
      continue
    }

    if (change.newContent === undefined) {
      result.skipped.push({ path: change.path, reason: 'Change has no newContent, so there is nothing to write.' })
      continue
    }

    const originalContent = exists ? readFileSync(absolute, 'utf-8') : undefined
    const diff = buildUnifiedDiff(change.path, originalContent, change.newContent)
    result.diffs.push({ path: change.path, diff })

    if (options.dryRun) {
      result.wouldWrite.push(change.path)
      continue
    }

    try {
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, change.newContent, 'utf-8')
      result.written.push(change.path)
    } catch (err) {
      result.skipped.push({
        path: change.path,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}

/** Capture the repository state a task depends on, for drift detection. */
export function snapshotRepository(repositoryRoot: string, paths: string[]): TaskCheckpoint['repositoryState'] {
  const workspace = new Workspace(repositoryRoot)
  const fileFingerprints: Record<string, string> = {}

  for (const p of paths) {
    const resolved = workspace.tryResolve(p)
    if (!resolved) continue
    try {
      fileFingerprints[p] = fingerprint(readFileSync(resolved.resolved, 'utf-8'))
    } catch {
      // Missing file: recorded as absent via the sentinel below.
      fileFingerprints[p] = '(absent)'
    }
  }

  let headCommit: string | undefined
  let branch: string | undefined
  let gitUnavailable = false
  try {
    headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace.rootPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    branch = execFileSync('git', ['branch', '--show-current'], { cwd: workspace.rootPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    gitUnavailable = true
  }

  return {
    repositoryRoot: workspace.rootPath,
    fileFingerprints,
    ...(headCommit ? { headCommit } : {}),
    ...(branch !== undefined ? { branch } : {}),
    gitUnavailable,
  }
}

/** Return actionable drift reasons before continuing a saved plan. */
export function verifyRepositorySnapshot(
  repositoryRoot: string,
  snapshot: TaskCheckpoint['repositoryState'] | undefined,
): string[] {
  if (!snapshot) return ['This task has no repository snapshot. Create a new plan before continuing.']
  const current = snapshotRepository(repositoryRoot, Object.keys(snapshot.fileFingerprints))
  const reasons: string[] = []
  if (current.repositoryRoot !== snapshot.repositoryRoot) reasons.push('The repository root differs from the one used to create this plan.')
  if (snapshot.headCommit && current.headCommit !== snapshot.headCommit) reasons.push('The Git HEAD changed after the plan was created.')
  if (snapshot.branch !== undefined && current.branch !== snapshot.branch) reasons.push('The Git branch changed after the plan was created.')
  if (snapshot.workingTreeFingerprint && current.workingTreeFingerprint !== snapshot.workingTreeFingerprint) {
    reasons.push('The Git working tree changed after the plan was created.')
  }
  for (const [path, expected] of Object.entries(snapshot.fileFingerprints)) {
    if (current.fileFingerprints[path] !== expected) reasons.push(`Source changed after planning: ${path}`)
  }
  if (snapshot.gitUnavailable && !current.gitUnavailable) reasons.push('Git became available since planning; create a fresh plan to capture repository state.')
  return reasons
}

/** Persist a checkpoint so the run can be resumed. */
export function saveCheckpoint(stateDir: string, checkpoint: TaskCheckpoint): string {
  mkdirSync(stateDir, { recursive: true })
  const path = join(stateDir, `${checkpoint.taskId}.checkpoint.json`)
  writeFileSync(path, JSON.stringify(checkpoint, null, 2), 'utf-8')
  return path
}

/** Load a previously saved checkpoint. */
export function loadCheckpoint(stateDir: string, taskId: string): TaskCheckpoint | null {
  const path = join(stateDir, `${taskId}.checkpoint.json`)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as TaskCheckpoint
  } catch {
    return null
  }
}

/** Persist the task record. */
export function saveTask(stateDir: string, task: TaskRecord): string {
  mkdirSync(stateDir, { recursive: true })
  const path = join(stateDir, `${task.taskId}.task.json`)
  writeFileSync(path, JSON.stringify(task, null, 2), 'utf-8')
  return path
}

/** Load a task record. */
export function loadTask(stateDir: string, taskId: string): TaskRecord | null {
  const path = join(stateDir, `${taskId}.task.json`)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as TaskRecord
  } catch {
    return null
  }
}

/** Append a stage record to a task and update its status. */
export function recordStage(
  task: TaskRecord,
  stage: AgentStage,
  status: StageRecord['status'],
  summary: string,
): void {
  task.stages.push({
    stage,
    status,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    summary,
  })
  task.updatedAt = new Date().toISOString()
}

export { fingerprint }
