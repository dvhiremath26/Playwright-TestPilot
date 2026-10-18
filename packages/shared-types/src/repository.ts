/**
 * Repository intelligence contracts.
 *
 * Everything here is discovered from the target framework's real source.
 * Nothing is assumed by default: `RepositoryIndex` only contains what the
 * scanner actually found on disk.
 */

/**
 * A single indexed source file.
 *
 * `fact` vs `inferred` is tracked per finding so the discovery report can
 * clearly separate confirmed facts from reasoned conventions.
 */
export interface IndexedFile {
  /** Path relative to the repository root, always `/`-separated. */
  relativePath: string
  /** Absolute path on the host. */
  absolutePath: string
  /** Byte size at scan time. */
  sizeBytes: number
  /** SHA-256 of the file content at scan time. */
  fingerprint: string
  /** Last-modified time (ms) at scan time. */
  modifiedMs: number
  /** Which bucket of the framework this file belongs to. */
  role: SourceFileRole
  /** Import specifiers this file imports, with their local aliases. */
  imports: ImportInfo[]
}

export type SourceFileRole =
  | 'test'
  | 'page-object'
  | 'locators'
  | 'action-facade'
  | 'action-group'
  | 'decorator'
  | 'fixture'
  | 'config'
  | 'data-loader'
  | 'credential'
  | 'reporter'
  | 'model'
  | 'constant'
  | 'enum'
  | 'utility'
  | 'other'

export interface ImportInfo {
  /** The specifier as written, e.g. `@src/helper/actions/actions`. */
  specifier: string
  /** Local names imported, e.g. `Actions`. */
  localNames: string[]
}

/** A declared symbol (class / interface / enum / function / method / const). */
export interface IndexedSymbol {
  name: string
  kind: SymbolKind
  /** Owning file, repository-relative. */
  file: string
  /** 1-based line of the declaration. */
  line: number
  /** Parent symbol name, for methods and properties. */
  parent?: string
  /** Full TypeScript signature line, for methods and functions. */
  signature?: string
  /** Whether the declaration is exported from its module. */
  exported: boolean
  /** Parameter names, in order. */
  parameters: { name: string; type: string }[]
  /** Return type as written, or undefined for constructor-like symbols. */
  returnType?: string
  /**
   * Human note extracted from the declaration's doc comment, if any.
   * Truncated; this is provenance, not a policy source.
   */
  docSummary?: string
}

export type SymbolKind =
  | 'class'
  | 'abstract-class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'function'
  | 'method'
  | 'constructor'
  | 'property'
  | 'const'
  | 'variable'

/** A Playwright test declaration discovered in a spec file. */
export interface IndexedTest {
  title: string
  /** Fully qualified title, e.g. `Logout Tests › Login Test`. */
  fullTitle: string
  /** Repository-relative spec file. */
  file: string
  /** 1-based line of the declaration. */
  line: number
  /** Jira/Xray key extracted from the `xray(...)` details argument, if any. */
  xrayKey?: string
  /** Tags found on the test, e.g. `['@TPA-5']`. */
  tags: string[]
  /** Annotations, e.g. `test_key`. */
  annotations: string[]
  /** Page-object and helper classes instantiated or referenced in the body. */
  referencedSymbols: string[]
  /** Fixture names destructured in the callback. */
  fixtures: string[]
  /** Whether the test body contains any explicit assertion. */
  hasAssertion: boolean
  /** Test description string, for `test.describe`. */
  describeBlock?: string
}

/** A locator field declared in a locator class, e.g. `USERNAME`. */
export interface IndexedLocator {
  name: string
  /** Owning locator class, e.g. `LoginLocators`. */
  ownerClass: string
  /** Repository-relative file. */
  file: string
  /** 1-based line. */
  line: number
  /** The Playwright locator expression, e.g. `this.page.getByRole('button', ...)`. */
  expression: string
  /** The locator strategy used, for reporting. */
  strategy: LocatorStrategy
}

export type LocatorStrategy =
  | 'getByRole'
  | 'getByPlaceholder'
  | 'getByText'
  | 'getByLabel'
  | 'getByTitle'
  | 'getByTestId'
  | 'getByAltText'
  | 'css'
  | 'xpath'
  | 'locator'
  | 'frameLocator'
  | 'other'

/** A reusable method discovered on an action facade or action group class. */
export interface IndexedActionMethod {
  /** Owning class, e.g. `ValidationActions`. */
  ownerClass: string
  /** Namespace on the flattened facade, e.g. `validation`. */
  facadeNamespace?: string
  name: string
  /** Repository-relative file. */
  file: string
  /** 1-based line. */
  line: number
  signature: string
  parameters: { name: string; type: string }[]
  returnType?: string
  /** Decorators applied to the method. */
  decorators: string[]
  /** True when the method is flattened onto the `Actions` facade instance. */
  onFacade: boolean
  docSummary?: string
}

export interface IndexedFixture {
  name: string
  /** Repository-relative file declaring the fixture. */
  file: string
  /** 1-based line. */
  line: number
  scope: 'test' | 'worker' | 'unknown'
  /** True when the fixture runs automatically without being destructured. */
  auto: boolean
  docSummary?: string
}

/** A package.json script or a Playwright/CI command discovered in the repo. */
export interface DiscoveredCommand {
  /** Script name or command name, e.g. `lint` or `playwright test`. */
  name: string
  /** The exact command to run, e.g. `npm run lint`. */
  command: string
  /** Where it was found. */
  source: string
  /** Whether it mutates files. */
  mutates: boolean
  /** True when it requires a live application or network. */
  needsNetwork: boolean
}

export interface FrameworkFacts {
  /** Repository root, absolute. */
  repositoryRoot: string
  /** Detected framework identity, when a Playwright config is present. */
  packageName?: string
  /** `testDir` from the Playwright config, repository-relative. */
  testDir?: string
  /** Playwright config file, repository-relative. */
  playwrightConfig?: string
  /** TypeScript config files found. */
  tsconfigs: string[]
  /** Path aliases from tsconfig `paths`. */
  pathAliases: Record<string, string[]>
  /** npm scripts. */
  scripts: Record<string, string>
  /** Direct + dev dependency names with versions. */
  dependencies: Record<string, string>
  /** Playwright-related dependency versions actually installed. */
  playwrightVersions: Record<string, string>
  /** Custom fixtures. */
  fixtures: IndexedFixture[]
  /** Whether the custom fixture module is imported by any spec file. */
  customFixtureUsed: boolean
  /** Test files. */
  tests: IndexedTest[]
  /** Page object classes. */
  pageObjects: string[]
  /** Locator classes. */
  locatorClasses: string[]
  /** Locator fields. */
  locators: IndexedLocator[]
  /** Action facade class name, e.g. `Actions`. */
  actionFacade?: string
  /** Action group classes. */
  actionGroups: string[]
  /** Reusable action methods. */
  actionMethods: IndexedActionMethod[]
  /** Decorators available. */
  decorators: string[]
  /** Test data modules. */
  testDataModules: string[]
  /** Reporting entry points configured in the Playwright config. */
  reporters: string[]
  /** Discovered commands. */
  commands: DiscoveredCommand[]
  /** Environment variable names referenced by source. */
  envVars: string[]
  /** Files excluded from indexing, with the reason. */
  excluded: { relativePath: string; reason: string }[]
}
