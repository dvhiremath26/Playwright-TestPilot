import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import type { Workspace } from './workspace.ts'

/**
 * Read-only, exclusion-aware repository scanner.
 *
 * Never writes. Never follows out of the workspace. Never indexes secrets,
 * dependencies, or generated artifacts.
 */

/** Directories never scanned, with the reason recorded in the report. */
export const ALWAYS_EXCLUDED_DIRS: Record<string, string> = {
  node_modules: 'installed dependencies',
  '.git': 'version control metadata',
  dist: 'build output',
  build: 'build output',
  coverage: 'coverage output',
  '.cache': 'tool cache',
  '.turbo': 'tool cache',
  'playwright-report': 'generated Playwright report',
  'test-results': 'Playwright run artifacts',
  '.browser-profiles': 'browser profiles with authentication state',
  Recordings: 'recorded video artifacts',
  reports: 'generated reports and logs',
  'TCOE-Reports': 'generated reports',
  'TCOE-Report': 'generated reports',
  reportingLabs: 'generated reports',
}

/** File patterns never scanned, with the reason recorded in the report. */
const SECRET_FILE_PATTERNS: RegExp[] = [
  /(^|\/)\.env($|\.)/,
  /(^|\/)credentials?\./i,
  /(^|\/)secrets?\./i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|\/)storage[-.]state\.json$/i,
  /(^|\/)auth\.json$/i,
]

const ALWAYS_EXCLUDED_FILE_PATTERNS: RegExp[] = [
  /\.log$/i,
  /\.lock$/i,
  /\.webm$/i,
  /\.png$/i,
  /\.jpe?g$/i,
  /\.zip$/i,
  /\.mp4$/i,
  /\.trace$/i,
  /^package-lock\.json$/,
]

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024

export interface ScanOptions {
  /** Extra relative directories to skip. */
  excludeDirs?: string[]
  /** Extra relative paths or file names to skip. */
  excludeFiles?: string[]
  /** File extensions to index. Defaults to TypeScript and JSON. */
  includeExtensions?: string[]
  /** Max file size to read. */
  maxFileBytes?: number
}

export interface ScannedFile {
  relativePath: string
  absolutePath: string
  sizeBytes: number
  modifiedMs: number
  content: string
}

export interface ScanResult {
  files: ScannedFile[]
  excluded: { relativePath: string; reason: string }[]
  totalBytes: number
}

export class RepositoryScanner {
  private readonly workspace: Workspace
  private readonly includeExtensions: Set<string>
  private readonly maxFileBytes: number
  private readonly extraExcludedDirs: Set<string>
  private readonly extraExcludedFiles: Set<string>

  constructor(workspace: Workspace, options: ScanOptions = {}) {
    this.workspace = workspace
    this.includeExtensions = new Set(
      (options.includeExtensions ?? ['.ts', '.mts', '.cts', '.json']).map((e) =>
        e.startsWith('.') ? e : `.${e}`,
      ),
    )
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.extraExcludedDirs = new Set(options.excludeDirs ?? [])
    this.extraExcludedFiles = new Set(options.excludeFiles ?? [])
  }

  scan(): ScanResult {
    const files: ScannedFile[] = []
    const excluded: { relativePath: string; reason: string }[] = []
    let totalBytes = 0

    const walk = (absoluteDir: string, relativeDir: string): void => {
      let dirents: import('node:fs').Dirent[]
      try {
        dirents = readdirSync(absoluteDir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of dirents) {
        const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
        const absPath = path.join(absoluteDir, entry.name)

        if (entry.isDirectory()) {
          if (ALWAYS_EXCLUDED_DIRS[entry.name]) {
            excluded.push({ relativePath: relPath, reason: ALWAYS_EXCLUDED_DIRS[entry.name]! })
            continue
          }
          if (this.extraExcludedDirs.has(entry.name) || this.extraExcludedDirs.has(relPath)) {
            excluded.push({ relativePath: relPath, reason: 'user-excluded directory' })
            continue
          }
          walk(absPath, relPath)
          continue
        }

        if (!entry.isFile()) {
          excluded.push({ relativePath: relPath, reason: 'not a regular file' })
          continue
        }

        const exclusionReason = this.exclusionReasonForFile(relPath, entry.name)
        if (exclusionReason) {
          excluded.push({ relativePath: relPath, reason: exclusionReason })
          continue
        }

        const ext = path.extname(entry.name).toLowerCase()
        if (!this.includeExtensions.has(ext)) continue

        let size: number
        let modifiedMs: number
        try {
          const stat = lstatSync(absPath)
          size = stat.size
          modifiedMs = stat.mtimeMs
        } catch {
          continue
        }

        if (size > this.maxFileBytes) {
          excluded.push({
            relativePath: relPath,
            reason: `larger than ${this.maxFileBytes} bytes`,
          })
          continue
        }

        let content: string
        try {
          content = readFileSync(absPath, 'utf8')
        } catch {
          continue
        }

        totalBytes += size
        files.push({
          relativePath: relPath,
          absolutePath: absPath,
          sizeBytes: size,
          modifiedMs,
          content,
        })
      }
    }

    walk(this.workspace.rootPath, '')
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    excluded.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    return { files, excluded, totalBytes }
  }

  private exclusionReasonForFile(relativePath: string, name: string): string | null {
    if (SECRET_FILE_PATTERNS.some((p) => p.test(relativePath))) {
      return 'credential or authentication file'
    }
    if (ALWAYS_EXCLUDED_FILE_PATTERNS.some((p) => p.test(name))) {
      return 'generated or binary artifact'
    }
    if (this.extraExcludedFiles.has(relativePath) || this.extraExcludedFiles.has(name)) {
      return 'user-excluded file'
    }
    return null
  }
}
