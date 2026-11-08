import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractJestCases, extractVitestCases } from './extract.ts'

const TESTER = `
pluginTester({
  tests: {
    'plain': { code: formatResult(\`
      jest.mock('a')
    \`), formatResult },
    'with react': {
      babelOptions: { filename: path.resolve(__dirname, '../file.js'), presets: [[presetReact, {}]] },
      code: formatResult(\`jest.mock('./App', () => () => <div />);\`),
    },
    'with ts': {
      babelOptions: { filename: path.resolve(__dirname, '../file.ts'), presets: [presetTypescript] },
      code: formatResult(\`jest.mock('x', () => jest.fn<typeof y>())\`),
    },
  },
})
`

test('Jest cases come out in source order, with the file name and the JSX mode they stood for', () => {
  assert.deepEqual(extractJestCases(TESTER), [
    { name: 'plain', code: "\n      jest.mock('a')\n    ", filename: 'file.js' },
    {
      name: 'with react',
      code: "jest.mock('./App', () => () => <div />);",
      filename: 'file.jsx',
      jsx: 'automatic',
    },
    { name: 'with ts', code: "jest.mock('x', () => jest.fn<typeof y>())", filename: 'file.ts' },
  ])
})

test('a Jest file with no pluginTester call is an error, not an empty list', () => {
  assert.throws(() => extractJestCases('const x = 1'), /no pluginTester/)
})

const VITEST = `
function hoistSimpleCodeWithoutMocks(code) {}
test('top', () => {
  expect(hoistSimpleCode(\`vi.mock('a')\`)).toBe(1)
})
describe('transform', () => {
  test('wrapped', () => {
    expect(hoistSimpleCodeWithoutMocks(\`import x from 'vue'\`)).toBe(1)
  })
  test('via a const', () => {
    const code = \`
a;\`.trim()
    expect(hoistSimpleCodeWithoutMocks(code)).toBe(1)
  })
  test('two inputs', () => {
    hoistMockAndResolve('import a from "a"' + ';vi.mock("a")', 'x.js', parse, {})
    hoistMockAndResolve(\`vi.mock('b')\`, 'x.js', parse, {})
  })
  test('no input at all', () => {
    expect(1).toBe(1)
  })
})
describe('errors', () => {
  it.each([
    ['one', \`vi.mock('x')\`],
    ['two', \`vi.unmock('y')\`],
  ])('throws if %s', (_, code) => {
    getErrorWhileHoisting(code)
  })
})
`

test('Vitest cases: tests, describe paths, wrappers, consts, repeats and it.each rows', () => {
  assert.deepEqual(extractVitestCases(VITEST), [
    { name: 'top', code: "vi.mock('a')" },
    {
      name: 'transform > wrapped',
      code: `import {vi} from "vitest";\nimport x from 'vue'\nvi.mock('faker');\n`,
    },
    {
      name: 'transform > via a const',
      code: `import {vi} from "vitest";\na;\nvi.mock('faker');\n`,
    },
    { name: 'transform > two inputs', code: 'import a from "a";vi.mock("a")' },
    { name: 'transform > two inputs #2', code: "vi.mock('b')" },
    { name: 'errors > throws if one', code: "vi.mock('x')" },
    { name: 'errors > throws if two', code: "vi.unmock('y')" },
  ])
})

test('a template with a hole is refused, so no input is half-extracted', () => {
  assert.throws(
    () => extractVitestCases(`test('t', () => { hoistSimpleCode(\`vi.mock($\{'x'})\`) })`),
    /holes/,
  )
})
