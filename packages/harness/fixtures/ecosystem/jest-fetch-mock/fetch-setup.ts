// Jest's `setupFiles` run once per test file, before the framework: the package binds its mocks to
// the global `jest` it finds when it loads.
;(require('jest-fetch-mock') as typeof import('jest-fetch-mock')).enableMocks()
