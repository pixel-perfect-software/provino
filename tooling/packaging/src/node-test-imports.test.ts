import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'provino'
import {
  importProblems,
  nodeTestImportProblems,
  provinoImportProblems,
  sourceReader,
} from './node-test-imports.ts'
import { scratchDir, writeFiles } from './test-support.ts'

type Files = Readonly<Record<string, string>>

describe('nodeTestImportProblems (B27h3)', () => {
  const TEST = 'packages/p/src/a.test.ts'
  /** The problems for `files` (path to text) when `tests` are the test files Provino runs. */
  const problems = (files: Files, tests: readonly string[] = [TEST]): string =>
    nodeTestImportProblems(tests, (file) => files[file]).join('\n')

  it('a helper that imports node:test and a Provino test that imports the helper fail, as a chain', () => {
    const found = problems({
      [TEST]: "import { tempDir } from './helper.ts'\n",
      'packages/p/src/helper.ts': "import { after } from 'node:test'\nafter(() => {})\n",
    })
    assert.match(
      found,
      /^packages\/p\/src\/a\.test\.ts → packages\/p\/src\/helper\.ts imports node:test: /,
    )
    assert.match(found, /never run in a Provino worker/)
  })

  it('every value form counts: default, namespace, side effect, a named value beside a type, a re-export, import()', () => {
    for (const line of [
      "import test from 'node:test'",
      "import * as nodeTest from 'node:test'",
      "import 'node:test'",
      "import { type TestContext, after } from 'node:test'",
      "export { after } from 'node:test'",
      "export * from 'node:test'",
      "const nodeTest = await import('node:test')",
      'const nodeTest = await import("node:test")',
      'const nodeTest = await import(`node:test`)',
    ]) {
      const found = problems({
        [TEST]: "import './helper.ts'\n",
        'packages/p/src/helper.ts': `${line}\n`,
      })
      assert.match(found, /helper\.ts imports node:test/, line)
    }
  })

  it('an import() that names no module a scan can read is none', () => {
    for (const line of [
      // A template with a substitution (written so the string is no template to the linter).
      `const nodeTest = await import(\`node:$\{name}\`)`,
      "const nodeTest = await import('node:' + name)",
      'const nodeTest = await import(name)',
    ]) {
      const files = { [TEST]: "import './helper.ts'\n", 'packages/p/src/helper.ts': `${line}\n` }
      assert.equal(problems(files), '', line)
    }
  })

  it('a type import is erased: it loads nothing', () => {
    for (const line of [
      "import type { TestContext } from 'node:test'",
      "import { type TestContext } from 'node:test'",
      "export type { TestContext } from 'node:test'",
    ]) {
      const files = { [TEST]: "import './helper.ts'\n", 'packages/p/src/helper.ts': `${line}\n` }
      assert.equal(problems(files), '', line)
    }
  })

  it('a file only the bootstrap set imports may use node:test', () => {
    // The helper is reached by no Provino test: the bootstrap test that imports it is not in `tests`.
    assert.equal(
      problems({
        [TEST]: "import './other.ts'\n",
        'packages/p/src/other.ts': '',
        'packages/p/src/boot.test.ts': "import './helper.ts'\n",
        'packages/p/src/helper.ts': "import { after } from 'node:test'\n",
      }),
      '',
    )
  })

  it('the chain names every file between the test and the one that imports node:test', () => {
    const found = problems({
      [TEST]: "import { b } from './a.ts'\n",
      'packages/p/src/a.ts': "export { b } from './deep/b.ts'\n",
      'packages/p/src/deep/b.ts': "import { describe } from 'node:test'\n",
    })
    assert.match(
      found,
      /^packages\/p\/src\/a\.test\.ts → packages\/p\/src\/a\.ts → packages\/p\/src\/deep\/b\.ts imports node:test: /,
    )
  })

  it('a relative import is followed by its exact path: a path with no extension names nothing', () => {
    assert.equal(
      problems({
        [TEST]: "import './helper'\nimport './dir'\n",
        'packages/p/src/helper.ts': "import { after } from 'node:test'\n",
        'packages/p/src/dir/index.ts': "import { after } from 'node:test'\n",
      }),
      '',
    )
  })

  it('a Provino test that imports node:test itself fails, and an import cycle ends', () => {
    assert.match(
      problems({ [TEST]: "import { test } from 'node:test'\n" }),
      /packages\/p\/src\/a\.test\.ts is a test file Provino runs and imports node:test/,
    )
    assert.equal(
      problems({
        [TEST]: "import './x.ts'\n",
        'packages/p/src/x.ts': "import './y.ts'\n",
        'packages/p/src/y.ts': "import './x.ts'\n",
      }),
      '',
    )
  })

  it('a string that holds an import is no import, and a file the reader gives no text is not followed', () => {
    assert.equal(
      problems({
        [TEST]:
          "const text = \"import { test } from 'node:test'\"\nimport '../../q/src/outside.ts'\n",
      }),
      '',
    )
  })

  it('each file is named once however many tests reach it', () => {
    const found = problems(
      {
        'packages/p/src/a.test.ts': "import './helper.ts'\n",
        'packages/p/src/b.test.ts': "import './helper.ts'\n",
        'packages/p/src/helper.ts': "import { after } from 'node:test'\n",
      },
      ['packages/p/src/a.test.ts', 'packages/p/src/b.test.ts'],
    )
    assert.match(found, /helper\.ts imports node:test/)
    assert.equal(found.split('\n').length, 1)
  })
})

describe('provinoImportProblems, the mirror (B27h3)', () => {
  const BOOT = 'packages/p/src/boot.test.ts'
  const problems = (files: Files, bootstrap: readonly string[] = [BOOT]): string =>
    provinoImportProblems(bootstrap, (file) => files[file]).join('\n')

  it('a helper a bootstrap test imports that imports provino fails, as a chain', () => {
    const found = problems({
      [BOOT]: "import { scratch } from './helper.ts'\n",
      'packages/p/src/helper.ts': "import { afterAll } from 'provino'\nafterAll(() => {})\n",
    })
    assert.match(
      found,
      /^packages\/p\/src\/boot\.test\.ts → packages\/p\/src\/helper\.ts imports provino: /,
    )
    assert.match(found, /register nothing/)
  })

  it('a bootstrap test that imports provino itself fails, through other files too', () => {
    assert.match(
      problems({ [BOOT]: "import { test } from 'provino'\n" }),
      /packages\/p\/src\/boot\.test\.ts is a bootstrap test \(it runs on node:test\) and imports provino/,
    )
    assert.match(
      problems({
        [BOOT]: "import './a.ts'\n",
        'packages/p/src/a.ts': "export { x } from './b.ts'\n",
        'packages/p/src/b.ts': "const provino = await import('provino')\n",
      }),
      /boot\.test\.ts → packages\/p\/src\/a\.ts → packages\/p\/src\/b\.ts imports provino/,
    )
  })

  it('a type import, another entry of the package and a file only Provino tests reach are fine', () => {
    assert.equal(
      problems({
        [BOOT]: "import './helper.ts'\n",
        'packages/p/src/helper.ts':
          "import type { TestContext } from 'provino'\nimport { defineConfig } from 'provino/config'\n",
        'packages/p/src/a.test.ts': "import './provino-only.ts'\n",
        'packages/p/src/provino-only.ts': "import { afterAll } from 'provino'\n",
      }),
      '',
    )
  })
})

describe('sourceReader and importProblems (B27h3)', () => {
  it('reads a file once, and only under the roots', () => {
    const repo = scratchDir('imports-reader', {
      'packages/p/src/a.ts': 'one',
      'packages/p/src/node_modules/dep/index.ts': 'dep',
      'packages/p/docs/b.ts': 'two',
    })
    const read = sourceReader(repo, ['packages/p/src/'])
    assert.equal(read('packages/p/src/a.ts'), 'one')
    rmSync(join(repo, 'packages/p/src/a.ts'))
    assert.equal(read('packages/p/src/a.ts'), 'one', 'the second read is the first one')
    assert.equal(read('packages/p/src/gone.ts'), undefined)
    assert.equal(read('packages/p/src/node_modules/dep/index.ts'), undefined)
    assert.equal(read('packages/p/docs/b.ts'), undefined, 'outside the roots')
  })

  it('scans a repo: the Provino-run tests and the bootstrap set, each from its own side', () => {
    const repo = scratchDir('imports-repo', {
      'tooling/provino/bootstrap.json': JSON.stringify({
        files: { 'packages/p/src/boot.test.ts': 'x' },
      }),
      'packages/p/package.json': '{}',
      'packages/p/provino.config.ts': 'export default {}\n',
      'packages/p/src/a.test.ts': "import './helper.ts'\n",
      'packages/p/src/boot.test.ts': "import './both.ts'\n",
      'packages/p/src/helper.ts': "import { after } from 'node:test'\n",
      'packages/p/src/both.ts': "import { afterAll } from 'provino'\n",
    })
    const found = importProblems(repo)
    assert.equal(found.length, 2, found.join('\n'))
    assert.match(found.join('\n'), /a\.test\.ts → packages\/p\/src\/helper\.ts imports node:test/)
    assert.match(found.join('\n'), /boot\.test\.ts → packages\/p\/src\/both\.ts imports provino/)
    // The bootstrap test is not a Provino-run root: its own node:test import is its business.
    writeFiles(repo, { 'packages/p/src/helper.ts': '', 'packages/p/src/both.ts': '' })
    assert.deepEqual(importProblems(repo), [])
  })
})
