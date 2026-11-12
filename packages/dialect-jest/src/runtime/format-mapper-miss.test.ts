import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatMapperMiss } from './format-mapper-miss.ts'

// The texts are the `resolve/mapper-miss` golden's (Jest 30.5.2), `<root>` standing for the project.
const CONFIG = (rule: string, configured: string, resolver = 'undefined'): string =>
  `\nPlease check your configuration for these entries:\n{\n  "moduleNameMapper": {\n    "${rule}": "${configured}"\n  },\n  "resolver": ${resolver}\n}`

test('a single target prints as itself, in the message and the config', () => {
  assert.equal(
    formatMapperMiss({
      specifier: '@app/missing',
      rule: '/^@app\\/(.*)$/',
      declared: ['<root>/src/$1'],
      tried: ['<root>/src/missing'],
      resolver: undefined,
    }),
    `Configuration error:\n\nCould not locate module @app/missing mapped as:\n<root>/src/$1.\n${CONFIG('/^@app\\/(.*)$/', '<root>/src/$1')}`,
  )
})

test('a list prints what each resolved to, and the configured list nested in the config', () => {
  assert.equal(
    formatMapperMiss({
      specifier: '@multi/missing',
      rule: '/^@multi\\/(.*)$/',
      declared: ['<root>/src/$1', '<root>/lib/$1'],
      tried: ['<root>/src/missing', '<root>/lib/missing'],
      resolver: undefined,
    }),
    `Configuration error:\n\nCould not locate module @multi/missing mapped as:\n[\n  "<root>/src/missing",\n  "<root>/lib/missing"\n].\n${CONFIG('/^@multi\\/(.*)$/', '[\n      "<root>/src/$1",\n      "<root>/lib/$1"\n    ]')}`,
  )
})

test('a custom resolver is named as configured', () => {
  assert.match(
    formatMapperMiss({
      specifier: 'x',
      rule: '/x/',
      declared: ['y'],
      tried: [],
      resolver: '<root>/resolver.cjs',
    }),
    /"resolver": <root>\/resolver\.cjs\n\}$/,
  )
})
