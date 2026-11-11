import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

/** A fresh, headed Chromium process that CLI and MCP can both attach to. */
export class IsolatedCdpBrowser {
  private constructor(
    readonly endpoint: string,
    private readonly profileDirectory: string,
    private readonly child: ChildProcess,
  ) {}

  static async launch(profileRoot: string, timeoutMs = 20_000): Promise<IsolatedCdpBrowser> {
    const executable = findChromiumExecutable()
    if (!executable) {
      throw new Error('TestPilot could not find Google Chrome or Microsoft Edge to create a shared isolated browser session.')
    }

    await mkdir(profileRoot, { recursive: true })
    const profileDirectory = await mkdtemp(join(profileRoot, 'tcoe-cdp-'))
    const child = spawn(executable, [
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDirectory}`,
      '--incognito',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      'about:blank',
    ], { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' })

    let spawnError: Error | undefined
    child.once('error', (error) => { spawnError = error })
    const activePortPath = join(profileDirectory, 'DevToolsActivePort')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (spawnError) {
        await stopOwnedBrowser(child)
        await rm(profileDirectory, { recursive: true, force: true })
        throw new Error(`Could not start the isolated browser: ${spawnError.message}`)
      }
      if (child.exitCode !== null) {
        await rm(profileDirectory, { recursive: true, force: true })
        throw new Error(`The isolated browser exited during startup (code ${child.exitCode}).`)
      }
      try {
        const [portLine] = (await readFile(activePortPath, 'utf8')).split(/\r?\n/)
        const port = Number(portLine)
        if (Number.isInteger(port) && port > 0 && port < 65_536) {
          return new IsolatedCdpBrowser(`http://127.0.0.1:${port}`, profileDirectory, child)
        }
      } catch { /* Chrome creates DevToolsActivePort after starting its profile. */ }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    await stopOwnedBrowser(child)
    await rm(profileDirectory, { recursive: true, force: true })
    throw new Error('Timed out waiting for the isolated browser to expose its local DevTools connection.')
  }

  async close(): Promise<void> {
    await stopOwnedBrowser(this.child)
    await rm(this.profileDirectory, { recursive: true, force: true })
  }
}

function findChromiumExecutable(): string | undefined {
  const env = process.env
  const candidates = process.platform === 'win32'
    ? [
        env['ProgramFiles'] && join(env['ProgramFiles'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        env['LOCALAPPDATA'] && join(env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        env['ProgramFiles'] && join(env['ProgramFiles'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        env['LOCALAPPDATA'] && join(env['LOCALAPPDATA'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]
    : process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ]
    : [
        ...['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'],
      ].flatMap((name) => (env['PATH'] ?? '').split(delimiter).map((directory) => join(directory, name)))
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)))
}

async function stopOwnedBrowser(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.once('error', () => resolve())
      killer.once('exit', () => resolve())
    })
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch {
      try { child.kill('SIGTERM') } catch { /* Already exited. */ }
    }
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL') } catch { /* Already exited. */ }
  }
}
