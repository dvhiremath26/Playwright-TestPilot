import { isAbsolute, resolve, sep } from 'node:path'

export interface WorkspaceConfiguration {
  frameworkRepo?: string
  appName?: string
  targetUrl?: string
  stateDir?: string
}

export interface ResolvedWorkspaceConfig {
  frameworkRepo: string
  appName?: string
  targetUrl?: string
  stateDir: string
}

/** Resolve a repository-relative path while leaving absolute paths untouched. */
export function resolveRepoPath(path: string, repositoryRoot: string): string {
  if (isAbsolute(path) || path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return path
  const separator = repositoryRoot.includes('\\') && !repositoryRoot.includes('/') ? '\\' : '/'
  const root = repositoryRoot.replace(/[\\/]+$/, '')
  const child = path.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '').replace(/[\\/]/g, separator)
  return child ? `${root}${separator}${child}` : root
}

/** Validate extension settings and resolve the repository and state directory. */
export function resolveWorkspaceConfig(
  config: WorkspaceConfiguration,
  workspaceRoot?: string,
): ResolvedWorkspaceConfig {
  const configuredRoot = config.frameworkRepo?.trim()
  const frameworkRepo = (configuredRoot || workspaceRoot || '').replace(/[\\/]+$/, '')
  if (!frameworkRepo) throw new Error('A workspace folder is open before configuring TestPilot.')

  const targetUrl = config.targetUrl?.trim() || undefined
  if (targetUrl) {
    let parsed: URL
    try {
      parsed = new URL(targetUrl)
    } catch {
      throw new Error('targetUrl must be a valid absolute URL.')
    }
    if (parsed.username || parsed.password) {
      throw new Error('targetUrl must not contain userinfo or a password.')
    }
  }

  const appName = config.appName?.trim() || undefined
  const stateDir = config.stateDir?.trim() || '.tcoe-testpilot'
  const absolute = isAbsolute(frameworkRepo) || frameworkRepo.startsWith('/') || /^[A-Za-z]:[\\/]/.test(frameworkRepo)
  return {
    frameworkRepo: absolute ? frameworkRepo : resolve(workspaceRoot || process.cwd(), frameworkRepo),
    appName,
    targetUrl,
    stateDir,
  }
}
