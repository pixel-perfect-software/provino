// Each title holds what an installed package's own `require`s gave when the test file loaded it.
const pkg = require('next-like') as {
  readonly context: string
  readonly styled: string
  readonly unknown: string
}

test(`a .shared-runtime request gives ${pkg.context}`, () => {})

test(`styled-like is ${pkg.styled}`, () => {})

test(`a request no package installs gives ${pkg.unknown}`, () => {})
