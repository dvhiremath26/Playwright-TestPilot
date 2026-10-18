/**
 * The analyzer is deterministic and works offline, so it is tested for real
 * rather than mocked: a miniature framework is written to a temp directory and
 * must be indexed correctly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { analyzeFramework } from '@tcoe/repo-intelligence'
import type { FrameworkAnalysisResult } from '@tcoe/repo-intelligence'

const FIXTURE = {
  'package.json': JSON.stringify(
    {
      name: 'mini-framework',
      version: '1.0.0',
      scripts: { lint: 'eslint "**/*.ts"', typecheck: 'tsc --noEmit', test: 'playwright test' },
      dependencies: { '@playwright/test': '^1.64.1' },
    },
    null,
    2,
  ),
  'tsconfig.json': JSON.stringify(
    { compilerOptions: { paths: { '@src/*': ['./src/*'], '@pages/*': ['./pages/*'] } } },
    null,
    2,
  ),
  'playwright.config.ts': `import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: './tests' })
`,
  'src/helper/actions/validation.actions.ts': `import { Page, Locator, expect } from '@playwright/test'

export class ValidationActions {
  constructor(private readonly page: Page) {}

  /** Asserts the element is visible. */
  async expectVisible(locator: Locator, message?: string): Promise<void> {
    await expect(locator, message).toBeVisible()
  }

  async expectText(locator: Locator, text: string): Promise<void> {
    await expect(locator).toHaveText(text)
  }
}
`,
  'src/helper/actions/textbox.actions.ts': `import { Page, Locator } from '@playwright/test'

export class TextboxActions {
  constructor(private readonly page: Page) {}

  async fill(locator: Locator, value: string): Promise<void> {
    await locator.fill(value)
  }
}
`,
  'src/helper/actions/page.actions.ts': `import { Page, Locator } from '@playwright/test'

export class PageActions {
  constructor(private readonly page: Page) {}

  async click(locator: Locator): Promise<void> {
    await locator.click()
  }

  async getText(locator: Locator): Promise<string> {
    return locator.innerText()
  }
}
`,
  'src/helper/actions/actions.ts': `import { Page } from '@playwright/test'
import { CommonActions } from './page.actions'
import { ValidationActions } from './validation.actions'
import { TextboxActions } from './textbox.actions'

const VALIDATION_METHODS = ['expectVisible', 'expectText'] as const
const TEXTBOX_METHODS = ['fill'] as const

export class Actions {
  readonly page: CommonActions
  readonly validation: ValidationActions
  readonly textbox: TextboxActions

  constructor(page: Page) {
    this.page = new CommonActions(page)
    this.validation = new ValidationActions(page)
    this.textbox = new TextboxActions(page)
  }
}
`,
  'src/config/fixture.ts': `import { test as base } from '@playwright/test'

export const test = base.extend({
  sharedPage: async ({ page }, use) => {
    await use(page)
  },
  sharedActions: [async ({ sharedPage }, use) => {
    await use(sharedPage)
  }, { scope: 'worker' }],
})

export { expect } from '@playwright/test'
`,
  'pages/LoginPage/login.locators.ts': `import { Page } from '@playwright/test'

export class LoginLocators {
  constructor(private readonly page: Page) {}

  readonly USERNAME = this.page.getByPlaceholder('Username')
  readonly PASSWORD = this.page.getByRole('textbox', { name: 'Password' })
  readonly LOGIN_BUTTON = this.page.getByRole('button', { name: 'Login' })
}
`,
  'pages/LoginPage/login.page.ts': `import { Page } from '@playwright/test'
import { BasePage } from '../Base/base.page'
import { LoginLocators } from './login.locators'

export class LoginPage extends BasePage {
  readonly locators: LoginLocators

  constructor(page: Page) {
    super(page)
    this.locators = new LoginLocators(page)
  }

  async enterUsername(username: string): Promise<void> {
    await this.actions.fill(this.locators.USERNAME, username)
  }
}
`,
  'pages/Base/base.page.ts': `import { Page } from '@playwright/test'
import { Actions } from '@src/helper/actions/actions'

export abstract class BasePage {
  protected readonly actions: Actions
  constructor(protected readonly page: Page) {
    this.actions = new Actions(page)
  }
}
`,
  'tests/example.spec.ts': `import { test, expect } from '@src/config/fixture'
import { LoginPage } from '@pages/LoginPage/login.page'
import { xray } from '@src/utils/xray/xray'

export function xray(key: string) {
  return { tag: ['@' + key], annotation: [{ type: 'test_key', description: key }] }
}

test.describe('Login Tests', () => {
  test('Login Test', xray('TPA-5'), async ({ page }) => {
    const loginPage = new LoginPage(page)
    await loginPage.enterUsername('admin')
    await expect(page.getByRole('button', { name: 'Login' })).toBeVisible()
  })
})
`,
}

let root: string
let result: FrameworkAnalysisResult

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tp-fw-'))
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf-8')
  }
  result = analyzeFramework({ repositoryRoot: root })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('framework discovery', () => {
  it('detects the Playwright identity and config', () => {
    expect(result.facts.packageName).toBe('mini-framework')
    expect(result.facts.playwrightConfig).toBe('playwright.config.ts')
    expect(result.facts.testDir).toBe('./tests')
  })

  it('reads tsconfig path aliases', () => {
    expect(Object.keys(result.facts.pathAliases)).toEqual(
      expect.arrayContaining(['@src/*', '@pages/*']),
    )
  })

  it('reads npm scripts', () => {
    expect(result.facts.scripts.lint).toContain('eslint')
    expect(result.facts.scripts.test).toContain('playwright')
  })

  it('discovers page objects', () => {
    expect(result.facts.pageObjects).toEqual(expect.arrayContaining(['LoginPage', 'BasePage']))
  })

  it('discovers locators with their expressions and strategies', () => {
    const username = result.facts.locators.find((l) => l.name === 'USERNAME')
    expect(username).toBeDefined()
    expect(username!.ownerClass).toBe('LoginLocators')
    expect(username!.file).toBe('pages/LoginPage/login.locators.ts')
    expect(username!.expression).toContain('getByPlaceholder')
    expect(username!.strategy).toBe('getByPlaceholder')

    const button = result.facts.locators.find((l) => l.name === 'LOGIN_BUTTON')
    expect(button!.strategy).toBe('getByRole')
  })

  it('discovers reusable action methods with file, line, and parameters', () => {
    const fill = result.facts.actionMethods.find(
      (m) => m.name === 'fill' && m.ownerClass === 'TextboxActions',
    )
    expect(fill).toBeDefined()
    expect(fill!.file).toBe('src/helper/actions/textbox.actions.ts')
    expect(fill!.parameters.map((p) => p.name)).toEqual(['locator', 'value'])

    const expectVisible = result.facts.actionMethods.find((m) => m.name === 'expectVisible')
    expect(expectVisible).toBeDefined()
    expect(expectVisible!.facadeNamespace).toBe('validation')
  })

  it('discovers the action facade and its groups', () => {
    expect(result.facts.actionFacade).toBe('Actions')
    expect(result.facts.actionGroups).toEqual(
      expect.arrayContaining(['ValidationActions', 'TextboxActions', 'CommonActions']),
    )
  })

  it('discovers custom fixtures with their scope', () => {
    const names = result.facts.fixtures.map((f) => f.name)
    expect(names).toEqual(expect.arrayContaining(['sharedPage', 'sharedActions']))

    // `sharedActions` declares `{ scope: 'worker' }` two lines below its
    // declaration, so this only passes if the fixture block is scanned rather
    // than a single line.
    const workerScoped = result.facts.fixtures.find((f) => f.name === 'sharedActions')
    expect(workerScoped!.scope).toBe('worker')
    const testScoped = result.facts.fixtures.find((f) => f.name === 'sharedPage')
    expect(testScoped!.scope).toBe('test')
  })

  it('detects that specs import the custom fixture', () => {
    expect(result.facts.customFixtureUsed).toBe(true)
  })

  it('discovers tests with their Xray key and referenced symbols', () => {
    expect(result.facts.tests).toHaveLength(1)
    const test = result.facts.tests[0]!
    expect(test.title).toBe('Login Test')
    expect(test.file).toBe('tests/example.spec.ts')
    expect(test.describeBlock).toBe('Login Tests')
    expect(test.referencedSymbols).toContain('LoginPage')
    expect(test.hasAssertion).toBe(true)
  })

  it('produces a discovery report that states its confidence', () => {
    expect(result.report.conventions.confirmed.length).toBeGreaterThan(0)
    expect(result.report).toHaveProperty('architecture')
  })

  it('excludes node_modules from the scan', () => {
    mkdirSync(join(root, 'node_modules', 'junk'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'junk', 'a.ts'), 'export const x = 1', 'utf-8')
    const rescanned = analyzeFramework({ repositoryRoot: root })
    expect(rescanned.facts.repositoryRoot).toBeTruthy()
    rmSync(join(root, 'node_modules'), { recursive: true, force: true })
  })
})