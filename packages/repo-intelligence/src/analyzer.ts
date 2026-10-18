import path from 'node:path'

import type {
  DiscoveredCommand,
  FrameworkFacts,
  IndexedActionMethod,
  IndexedFile,
  IndexedFixture,
  IndexedLocator,
  IndexedSymbol,
  IndexedTest,
  SourceFileRole,
} from '@tcoe/shared-types'

import { fingerprint } from './fingerprint.ts'
import type { ScanResult, ScannedFile } from './scanner.ts'
import type { Workspace } from './workspace.ts'
import { parseTypeScript, type ParsedModule } from './ts-parser.ts'

/**
 * Deterministic framework analyzer.
 *
 * Turns a raw scan into {@link FrameworkFacts}. No model calls: every field
 * comes from the actual source, because a wrong index would make the
 * generator invent methods that do not exist.
 */

export interface AnalyzeOptions {
  /** Extra commands discovered outside package.json (e.g. CI configs). */
  additionalCommands?: DiscoveredCommand[]
  /** When true, skip reading test file bodies for symbol references. */
  shallow?: boolean
}

export interface AnalysisResult {
  facts: FrameworkFacts
  /** The per-file index, keyed by repository-relative path. */
  indexedFiles: IndexedFile[]
  /** All symbols found, for the reuse analyzer. */
  symbols: IndexedSymbol[]
  /** The facade's namespace map, e.g. `validation` -> `ValidationActions`. */
  facadeNamespaces: Record<string, string>
}

export class FrameworkAnalyzer {
  private readonly workspace: Workspace

  constructor(workspace: Workspace) {
    this.workspace = workspace
  }

  analyze(scan: ScanResult, options: AnalyzeOptions = {}): AnalysisResult {
    const scanned = scan.files
    const indexedFiles: IndexedFile[] = []
    const symbols: IndexedSymbol[] = []
    const actionMethods: IndexedActionMethod[] = []
    const locators: IndexedLocator[] = []
    const decorators = new Set<string>()
    const pathAliases: Record<string, string[]> = {}
    const envVars = new Set<string>()

    let packageName: string | undefined
    const scripts: Record<string, string> = {}
    const dependencies: Record<string, string> = {}
    let testDir: string | undefined
    let playwrightConfig: string | undefined
    const tsconfigs: string[] = []
    const reporters: string[] = []

    // Cache parsed modules so we do not re-parse the facade file three times.
    const parsedCache = new Map<string, ParsedModule>()
    const parse = (file: ScannedFile): ParsedModule | undefined => {
      if (parsedCache.has(file.relativePath)) return parsedCache.get(file.relativePath)
      if (!file.relativePath.endsWith('.ts')) return undefined
      let parsed: ParsedModule | undefined
      try {
        parsed = parseTypeScript(file.content, file.relativePath)
      } catch {
        return undefined
      }
      parsedCache.set(file.relativePath, parsed)
      return parsed
    }

    // --- Pass 1: package.json, tsconfigs, playwright config
    for (const file of scanned) {
      if (file.relativePath === 'package.json') {
        this.readPackageJson(file.content, { scripts, dependencies, envVars })
        packageName = dependencies['name']
        continue
      }
      if (file.relativePath === 'tsconfig.json' || /(^|\/)tsconfig[^/]*\.json$/.test(file.relativePath)) {
        tsconfigs.push(file.relativePath)
        this.readTsconfig(file.content, pathAliases)
        continue
      }
      if (/(^|\/)playwright\.config\.(ts|js|mts|mjs)$/.test(file.relativePath)) {
        playwrightConfig = file.relativePath
        this.readPlaywrightConfig(file.content, { testDir, reporters, envVars })
        continue
      }
    }
    testDir = testDir ?? './tests'

    // --- Pass 2: symbols, locators, decorators
    for (const file of scanned) {
      const parsed = parse(file)
      if (!parsed) {
        if (file.relativePath.endsWith('.ts')) {
          indexedFiles.push({
            relativePath: file.relativePath,
            absolutePath: file.absolutePath,
            sizeBytes: file.sizeBytes,
            fingerprint: fingerprint(file.content),
            modifiedMs: file.modifiedMs,
            role: 'other',
            imports: [],
          })
        }
        continue
      }

      for (const symbol of parsed.symbols) symbols.push(symbol)
      for (const decorator of parsed.decorators) decorators.add(decorator)
      for (const envVar of this.findEnvVars(file.content)) envVars.add(envVar)

      for (const rawLocator of parsed.rawLocators) {
        locators.push({
          name: rawLocator.name,
          ownerClass: rawLocator.ownerClass,
          file: file.relativePath,
          line: rawLocator.line,
          expression: rawLocator.expression,
          strategy: rawLocator.strategy,
        })
      }

      indexedFiles.push({
        relativePath: file.relativePath,
        absolutePath: file.absolutePath,
        sizeBytes: file.sizeBytes,
        fingerprint: fingerprint(file.content),
        modifiedMs: file.modifiedMs,
        role: classifyFile(file.relativePath, parsed.symbols),
        imports: parsed.imports,
      })
    }

    // --- Pass 3: action facade and reusable methods
    const actionFacade = this.detectActionFacade(parsedCache)
    const facadeNamespaces = this.parseFacadeNamespaceLists(parsedCache, actionFacade)
    const actionGroups: string[] = []

    if (actionFacade) {
      for (const [relativePath, parsed] of parsedCache) {
        if (!relativePath.endsWith('.ts')) continue
        for (const method of parsed.rawMethods) {
          const namespace = facadeNamespaces[method.ownerClass]
          if (!namespace) continue
          actionMethods.push({
            ownerClass: method.ownerClass,
            facadeNamespace: namespace,
            name: method.name,
            file: relativePath,
            line: method.line,
            signature: method.signature,
            parameters: method.parameters,
            returnType: method.returnType,
            decorators: method.decorators,
            onFacade: true,
            docSummary: method.docSummary,
          })
        }
      }
      for (const ownerClass of Object.keys(facadeNamespaces)) actionGroups.push(ownerClass)
    }

    // --- Pass 4: tests
    const tests: IndexedTest[] = []
    if (!options.shallow) {
      for (const [relativePath, parsed] of parsedCache) {
        if (!relativePath.endsWith('.ts')) continue
        const role = indexedFiles.find((f) => f.relativePath === relativePath)?.role
        if (role !== 'test') continue
        const file = scanned.find((f) => f.relativePath === relativePath)
        if (!file) continue
        tests.push(...this.parseTests(file.content, relativePath, parsed))
      }
    }

    // --- Pass 5: fixtures
    const fixtures: IndexedFixture[] = []
    for (const [relativePath, parsed] of parsedCache) {
      const file = scanned.find((f) => f.relativePath === relativePath)
      if (!file) continue
      fixtures.push(...this.parseFixtures(file.content, relativePath))
    }

    const customFixtureFiles = new Set(fixtures.map((f) => f.file))
    const customFixtureUsed = scanned.some((candidate) => {
      if (!candidate.relativePath.endsWith('.spec.ts')) return false
      if (customFixtureFiles.has(candidate.relativePath)) return false
      return [...customFixtureFiles].some((fixtureFile) =>
        this.importsPath(candidate.content, fixtureFile),
      )
    })

    const facts: FrameworkFacts = {
      repositoryRoot: this.workspace.rootPath,
      packageName,
      testDir,
      playwrightConfig,
      tsconfigs,
      pathAliases,
      scripts,
      dependencies,
      playwrightVersions: this.filterPlaywrightDeps(dependencies),
      fixtures,
      customFixtureUsed,
      tests,
      pageObjects: this.collectPageObjects(parsedCache),
      locatorClasses: [...new Set(locators.map((l) => l.ownerClass).filter(Boolean))].sort(),
      locators,
      actionFacade,
      actionGroups: actionGroups.sort(),
      actionMethods,
      decorators: [...decorators].sort(),
      testDataModules: this.collectTestDataModules(scanned),
      reporters: [...new Set(reporters)].sort(),
      commands: this.buildCommands(scripts, playwrightConfig, options.additionalCommands ?? []),
      envVars: [...envVars].sort(),
      excluded: scan.excluded,
    }

    return { facts, indexedFiles, symbols, facadeNamespaces }
  }

  private readPackageJson(
    content: string,
    sink: {
      scripts: Record<string, string>
      dependencies: Record<string, string>
      envVars: Set<string>
    },
  ): void {
    let parsed: {
      name?: string
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    try {
      parsed = JSON.parse(content)
    } catch {
      return
    }
    if (parsed.name) sink.dependencies['name'] = parsed.name
    Object.assign(sink.scripts, parsed.scripts ?? {})
    Object.assign(sink.dependencies, parsed.dependencies ?? {})
    Object.assign(sink.dependencies, parsed.devDependencies ?? {})
  }

  private readTsconfig(content: string, sink: Record<string, string[]>): void {
    let parsed: {
      paths?: Record<string, string[]>
      compilerOptions?: { paths?: Record<string, string[]> }
    }
    try {
      parsed = JSON.parse(content)
    } catch {
      return
    }

    // `paths` is nested under `compilerOptions`. A top-level `paths` is not a
    // real tsconfig shape, but tolerate it for hand-written fixtures.
    const paths = parsed.compilerOptions?.paths ?? parsed.paths
    if (paths) {
      for (const [alias, targets] of Object.entries(paths)) sink[alias] = targets
    }
  }

  private readPlaywrightConfig(
    content: string,
    sink: { testDir?: string; reporters: string[]; envVars: Set<string> },
  ): void {
    const dirMatch = content.match(/testDir:\s*['"`]([^'"`]+)['"`]/)
    if (dirMatch && !sink.testDir) sink.testDir = dirMatch[1]

    const reporterRegex = /\[\s*['"`]([^'"`]+)['"`]/g
    let match: RegExpExecArray | null
    while ((match = reporterRegex.exec(content))) {
      const name = match[1]!
      // Skip string literals that are testDir/baseURL values, not reporters.
      if (!sink.reporters.includes(name)) sink.reporters.push(name)
    }
    for (const envVar of this.findEnvVars(content)) sink.envVars.add(envVar)
  }

  private findEnvVars(content: string): string[] {
    const names: string[] = []
    const regex = /process\.env\.([A-Z0-9_]+)/g
    let match: RegExpExecArray | null
    while ((match = regex.exec(content))) names.push(match[1]!)
    return names
  }

  private detectActionFacade(parsedCache: Map<string, ParsedModule>): string | undefined {
    for (const [relativePath, parsed] of parsedCache) {
      // The facade is the class that imports most other action groups.
      const importedGroups = parsed.imports.filter((i) => /actions?$/.test(i.specifier.split('/').pop() ?? ''))
      const classSymbols = parsed.symbols.filter(
        (s) => s.kind === 'class' || s.kind === 'abstract-class',
      )
      if (importedGroups.length >= 3 && classSymbols.length > 0) {
        return classSymbols[0]?.name
      }
      if (classSymbols.length > 0 && !relativePath.includes('/actions/') && classSymbols[0]?.name === 'Actions') {
        return 'Actions'
      }
    }
    return undefined
  }

  private parseFacadeNamespaceLists(
    parsedCache: Map<string, ParsedModule>,
    facadeName?: string,
  ): Record<string, string> {
    const result: Record<string, string> = {}
    if (!facadeName) return result

    for (const [relativePath, parsed] of parsedCache) {
      if (!parsed.symbols.some((s) => s.name === facadeName)) continue

      // `readonly validation: ValidationActions`
      for (const symbol of parsed.symbols) {
        if (symbol.parent !== facadeName || symbol.kind !== 'property') continue
        const returnType = symbol.returnType ?? ''
        if (/^\w+Actions$/.test(returnType)) {
          result[returnType] = symbol.name
        }
      }
      return result
    }
    return result
  }

  private parseTests(content: string, relativePath: string, parsed: ParsedModule): IndexedTest[] {
    const tests: IndexedTest[] = []
    const lines = content.split('\n')

    const describeRegex = /describe(?:\.\w+)?\(\s*(['"`])(.*?)\1/
    const testRegex = /test(?:\.\w+)?\(\s*(['"`])(.*?)\1\s*(?:,\s*([^)]*))?\)/
    const xrayRegex = /xray\(\s*(['"`])([^'"`]+)\1\s*\)/

    const describeStack: string[] = []
    let lastDescribeLine = -1
    let currentTestLine: number | undefined

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!
      const trimmed = line.trimStart()

      const describeMatch = describeRegex.exec(line)
      if (describeMatch && (trimmed.startsWith('test.describe') || /^describe/.test(trimmed))) {
        describeStack.push(describeMatch[2] ?? '')
        lastDescribeLine = index
        continue
      }

      // A closing brace pops the describe stack.
      if (trimmed.startsWith('}') && currentTestLine === undefined && index > lastDescribeLine) {
        const depth = countDepth(content, lastDescribeLine, index)
        if (depth <= 0) describeStack.pop()
        continue
      }

      const testMatch = testRegex.exec(line)
      if (!testMatch) continue
      if (!/test\./.test(line) && !/^test\(/.test(trimmed)) continue

      currentTestLine = index
      const title = testMatch[2] ?? ''
      const details = testMatch[3]?.trim()

      // Body: from this line to the matching closing brace.
      let bodyEnd = Math.min(lines.length - 1, index + 150)
      let depth = 0
      for (let scan = index; scan < lines.length; scan++) {
        for (const char of lines[scan]!) {
          if (char === '{') depth++
          else if (char === '}') depth--
        }
        if (depth <= 0) {
          bodyEnd = scan
          break
        }
      }
      const body = lines.slice(index, bodyEnd + 1).join('\n')

      const xrayMatch = xrayRegex.exec(body)
      const xrayKey = xrayMatch?.[2]
      const tags = xrayKey ? [`@${xrayKey}`] : []
      const annotationMatches = [
        ...body.matchAll(/type:\s*['"`](\w+)['"`]\s*,\s*description:\s*['"`]([^'"`]+)['"`]/g),
      ].map((m) => `${m[1]!}:${m[2]!}`)

      const fixtureMatch = body.match(/\(\s*\{\s*([^}]+)\s*\}\s*\)/)
      const fixtures = fixtureMatch
        ? fixtureMatch[1]!.split(',').map((f) => f.trim()).filter(Boolean)
        : []

      const referencedSymbols = [
        ...new Set(
          [...body.matchAll(/new\s+([A-Z]\w+)\s*\(/g)].map((m) => m[1]!).concat(
            [...body.matchAll(/await\s+this\.\w+\.\w+\(/g)].map(() => ''),
          ),
        ),
      ].filter(Boolean).sort()

      const describeBlock = describeStack.length > 0 ? describeStack[describeStack.length - 1] : undefined
      const fullTitle = describeBlock ? `${describeBlock} › ${title}` : title

      tests.push({
        title,
        fullTitle,
        file: relativePath,
        line: index + 1,
        xrayKey,
        tags,
        annotations: annotationMatches,
        referencedSymbols,
        fixtures,
        hasAssertion: /\bexpect\s*\(/.test(body) || /actions\.validation\.expect\w+/.test(body),
        describeBlock,
      })
      currentTestLine = undefined
    }

    return tests
  }

  private parseFixtures(content: string, relativePath: string): IndexedFixture[] {
    const fixtures: IndexedFixture[] = []
    const lines = content.split('\n')
    const builtIn = new Set(['context', 'page', 'request', 'browser', 'playwright', 'workerInfo', 'testInfo'])
    const reserved = new Set(['blockWlakMeBalloons'])

    // `name: [async (...) => {...}, { scope: 'worker' }]`
    const arrayFixtureRegex = /^\s{2}(\w+):\s*\[/gm
    // `name: async (...) => {...}`
    const simpleFixtureRegex = /^\s{2}(\w+):\s*async\s*\(/gm
    // Built from codepoints rather than a literal so all three quote styles are
    // unambiguous in the character class: single quote, double quote, backtick.
    const QUOTE = String.fromCharCode(0x27, 0x22, 0x60)
    const scopeRegex = new RegExp(String.raw`scope:\s*([${QUOTE}])(\w+)\1`)
    const autoRegex = /auto:\s*true/

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!
      const arrayMatch = arrayFixtureRegex.exec(line)
      const simpleMatch = simpleFixtureRegex.exec(line)
      const match = arrayMatch ?? simpleMatch
      if (!match) continue

      const name = match[1]!
      if (builtIn.has(name)) continue

      // A Playwright fixture body spans several lines, and the `{ scope, auto }`
      // options object is the LAST element of an array fixture — typically two
      // lines below its declaration. Searching only the declaration line reports
      // every multi-line worker-scoped fixture as test-scoped, which is the
      // common case in practice. Collect until the next fixture declaration.
      const blockLines: string[] = []
      for (let offset = 0; offset < 15; offset++) {
        const next = lines[index + offset]
        if (next === undefined) break
        if (offset > 0 && (arrayFixtureRegex.test(next) || simpleFixtureRegex.test(next))) break
        blockLines.push(next)
      }
      const block = blockLines.join('\n')

      let scopeValue: string | undefined
      for (const blockLine of blockLines) {
        const m = scopeRegex.exec(blockLine)
        if (m) {
          scopeValue = m[2]
          break
        }
      }
      const scope: 'test' | 'worker' = scopeValue === 'worker' ? 'worker' : 'test'
      const auto = autoRegex.test(block) || reserved.has(name)

      const preceding = lines.slice(Math.max(0, index - 8), index).join('\n')
      const docMatch = preceding.match(/\/\*\*([\s\S]*?)\*\/\s*$/)
      const docSummary = docMatch?.[1]?.replace(/\*\//g, '').replace(/^\/\*\*\s*/, '').replace(/\s+/g, ' ').trim()

      fixtures.push({
        name,
        file: relativePath,
        line: index + 1,
        scope,
        auto,
        docSummary: docSummary && docSummary.length > 0 && docSummary.length < 300 ? docSummary : undefined,
      })
    }

    return fixtures
  }

  private collectPageObjects(parsedCache: Map<string, ParsedModule>): string[] {
    const names: string[] = []
    for (const [relativePath, parsed] of parsedCache) {
      if (!isPageObjectPath(relativePath)) continue
      for (const symbol of parsed.symbols) {
        if (symbol.kind === 'class' || symbol.kind === 'abstract-class') names.push(symbol.name)
      }
    }
    return [...new Set(names)].sort()
  }

  private collectTestDataModules(scanned: ScannedFile[]): string[] {
    const modules: string[] = []
    for (const file of scanned) {
      const match = file.relativePath.match(/^test-data\/([^/]+)\//)
      if (match) modules.push(match[1]!)
    }
    return [...new Set(modules)].sort()
  }

  private buildCommands(
    scripts: Record<string, string>,
    playwrightConfig: string | undefined,
    additional: DiscoveredCommand[],
  ): DiscoveredCommand[] {
    const commands: DiscoveredCommand[] = []

    for (const [name, script] of Object.entries(scripts)) {
      commands.push({
        name,
        command: `npm run ${name}`,
        source: 'package.json',
        mutates: this.commandMutates(name, script),
        needsNetwork: this.commandNeedsNetwork(script),
      })
    }

    if (playwrightConfig) {
      commands.push({
        name: 'playwright test',
        command: 'npx playwright test',
        source: playwrightConfig,
        mutates: false,
        needsNetwork: true,
      })
      commands.push({
        name: 'playwright test (list only)',
        command: 'npx playwright test --list',
        source: playwrightConfig,
        mutates: false,
        needsNetwork: false,
      })
    }

    commands.push({
      name: 'typecheck',
      command: 'npx tsc --noEmit',
      source: 'tsconfig.json',
      mutates: false,
      needsNetwork: false,
    })

    return [...commands, ...additional]
  }

  private commandMutates(name: string, script: string): boolean {
    return /--write|--fix|format|prepare|pre-commit|lint-staged/.test(`${name} ${script}`)
  }

  private commandNeedsNetwork(script: string): boolean {
    return /playwright\s+test|e2e|integration/.test(script)
  }

  private filterPlaywrightDeps(dependencies: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [name, version] of Object.entries(dependencies)) {
      if (name === 'name') continue
      if (/playwright/i.test(name)) result[name] = version
    }
    return result
  }

  private importsPath(content: string, targetRelativePath: string): boolean {
    const withoutExt = targetRelativePath.replace(/\.ts$/, '')
    const segments = withoutExt.split('/')

    // Match a path suffix, not a quoted exact string: a spec typically imports
    // the custom fixture via `../src/config/fixture` or `@src/config/fixture`,
    // which neither equals the target path nor a bare filename. The two-segment
    // minimum keeps a bare filename from matching an unrelated same-named import.
    const suffixes = segments.length >= 2 ? [segments.slice(-2).join('/')] : [withoutExt]
    for (const suffix of suffixes) {
      if (content.includes(suffix)) return true
    }
    return false
  }
}

function countDepth(content: string, fromLine: number, toLine: number): number {
  const lines = content.split('\n')
  let depth = 0
  // `fromLine` is -1 when no `describe` block preceded the closing brace, so
  // clamp before indexing.
  for (let i = Math.max(0, fromLine); i <= Math.min(toLine, lines.length - 1); i++) {
    const line = lines[i]
    if (line === undefined) continue
    for (const char of line) {
      if (char === '{') depth++
      else if (char === '}') depth--
    }
  }
  return depth
}

function classifyFile(relativePath: string, symbols: IndexedSymbol[]): SourceFileRole {
  const lower = relativePath.toLowerCase()

  if (/\.spec\.(ts|js)$/.test(relativePath)) return 'test'
  if (lower.includes('locator')) return 'locators'
  if (isPageObjectPath(relativePath)) return 'page-object'
  if (lower.includes('fixture')) return 'fixture'
  if (lower.includes('credential')) return 'credential'
  if (lower.includes('config')) return 'config'
  if (lower.includes('dataloader') || lower.includes('data-types')) return 'data-loader'
  if (lower.includes('reporter') || lower.includes('report')) return 'reporter'
  if (lower.includes('decorator')) return 'decorator'
  if (lower.includes('constant') || lower.includes('url')) return 'constant'
  if (lower.includes('enum')) return 'enum'
  if (/(^|\/)utils?\//.test(lower)) return 'utility'

  return symbols.some((s) => s.kind === 'method') ? 'action-group' : 'other'
}

function isPageObjectPath(relativePath: string): boolean {
  return /(^|\/)pages\//.test(relativePath) || /\.page\.ts$/.test(relativePath)
}
