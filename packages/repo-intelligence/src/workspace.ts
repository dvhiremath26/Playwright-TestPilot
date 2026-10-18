import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

/**
 * Workspace boundary enforcement.
 *
 * Every file path the agent touches must be resolved against an explicitly
 * configured workspace root and verified to stay inside it. This is the
 * control that stops path traversal and symlink escapes, including paths
 * the model generates.
 */

export class WorkspaceViolationError extends Error {
  readonly attemptedPath: string
  readonly workspaceRoot: string

  constructor(
    message: string,
    attemptedPath: string,
    workspaceRoot: string,
  ) {
    super(message)
    this.name = 'WorkspaceViolationError'
    this.attemptedPath = attemptedPath
    this.workspaceRoot = workspaceRoot
  }
}

/**
 * A resolved, verified workspace path. The rest of the agent should only
 * ever write through the values returned here.
 */
export interface WorkspacePath {
  /** Absolute, fully resolved real path. */
  resolved: string
  /** Repository-relative, `/`-separated. */
  relative: string
}

export interface WorkspaceOptions {
  /** Allow symlinked entries that resolve inside the workspace. Default: false. */
  allowSymlinks?: boolean
}

export class Workspace {
  private readonly root: string
  private readonly allowSymlinks: boolean

  constructor(root: string, options: WorkspaceOptions = {}) {
    this.root = realpathSync(root)
    this.allowSymlinks = options.allowSymlinks ?? false
  }

  get rootPath(): string {
    return this.root
  }

  /**
   * Resolve `candidate` against the workspace root and verify it stays inside.
   *
   * Returns null rather than throwing when the path is simply outside, so
   * callers can distinguish "not ours" from "traversal attack" without
   * relying on exceptions for control flow.
   */
  tryResolve(candidate: string, options: { mustExist?: boolean } = {}): WorkspacePath | null {
    if (typeof candidate !== 'string' || candidate.length === 0) return null
    if (candidate.includes('\0')) return null

    const normalized = candidate.replace(/\\/g, '/')
    if (path.isAbsolute(normalized)) {
      // Absolute paths must be resolved via realpath and must still be inside.
      const abs = path.resolve(this.root, normalized)
      return this.verify(abs, options)
    }

    const joined = path.resolve(this.root, normalized)
    return this.verify(joined, options)
  }

  /** Like {@link tryResolve} but throws. Use at write boundaries. */
  resolve(candidate: string, options: { mustExist?: boolean } = {}): WorkspacePath {
    const result = this.tryResolve(candidate, options)
    if (!result) {
      throw new WorkspaceViolationError(
        `Path escapes the workspace: ${candidate}`,
        candidate,
        this.root,
      )
    }
    return result
  }

  /** True when `candidate` resolves to a location inside the workspace. */
  isInside(candidate: string): boolean {
    return this.tryResolve(candidate) !== null
  }

  private verify(joined: string, options: { mustExist?: boolean }): WorkspacePath | null {
    if (!this.isPathInside(joined)) return null

    let real: string
    try {
      real = realpathSync(joined)
    } catch {
      // realpathSync throws ENOENT for missing files. Re-check the chain of
      // ancestors to still prove containment for files about to be created.
      return options.mustExist ? null : this.verifyAncestors(joined)
    }

    if (!this.isPathInside(real)) return null

    if (!this.allowSymlinks && this.chainContainsSymlink(joined)) {
      return null
    }

    const relative = path.relative(this.root, real).split(path.sep).join('/')
    return { resolved: real, relative }
  }

  private verifyAncestors(joined: string): WorkspacePath | null {
    // Walk up to the nearest existing ancestor and verify it.
    let dir = path.dirname(joined)
    while (dir.length >= this.root.length) {
      try {
        const real = realpathSync(dir)
        if (!this.isPathInside(real)) return null
        if (this.chainContainsSymlink(dir)) return null

        // `real` is the verified prefix only. The rest of `joined` does not
        // exist yet, so splice it back on. Returning `real` as `resolved` would
        // misreport a new file as its parent directory, which is enough to make
        // a "create" look like an overwrite of a directory.
        const resolved = real === dir ? joined : `${real}/${joined.slice(dir.length)}`
        const relative = path.relative(this.root, resolved).split(path.sep).join('/')
        return { resolved, relative }
      } catch {
        const parent = path.dirname(dir)
        if (parent === dir) return null
        dir = parent
      }
    }
    return null
  }

  private isPathInside(target: string): boolean {
    if (target === this.root) return true
    const rel = path.relative(this.root, target)
    return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  private chainContainsSymlink(target: string): boolean {
    const rel = path.relative(this.root, target)
    const segments = rel.split(path.sep).filter((s) => s.length > 0)
    let cursor = this.root
    for (const segment of segments) {
      cursor = path.join(cursor, segment)
      try {
        if (lstatSync(cursor).isSymbolicLink()) return true
      } catch {
        // Not yet present; a new file being created is fine.
      }
    }
    return false
  }

  /** Validate a path the model produced before any filesystem write. */
  validateModelPath(modelPath: string, expectedExtension: string): WorkspacePath {
    if (typeof modelPath !== 'string') {
      throw new WorkspaceViolationError('Model path is not a string.', String(modelPath), this.root)
    }

    const trimmed = modelPath.trim()
    if (trimmed.length === 0) {
      throw new WorkspaceViolationError('Model path is empty.', modelPath, this.root)
    }
    if (trimmed.includes('\0')) {
      throw new WorkspaceViolationError('Model path contains a null byte.', modelPath, this.root)
    }
    if (trimmed.startsWith('/') && path.isAbsolute(trimmed)) {
      throw new WorkspaceViolationError(
        'Model paths must be workspace-relative, not absolute.',
        modelPath,
        this.root,
      )
    }
    if (!trimmed.toLowerCase().endsWith(expectedExtension)) {
      throw new WorkspaceViolationError(
        `Model path must end with "${expectedExtension}".`,
        modelPath,
        this.root,
      )
    }

    return this.resolve(trimmed)
  }
}
