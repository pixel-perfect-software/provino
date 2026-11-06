// A support file: its jest.mock is written below its require and still applies to it.
const dep = require('./dep.ts') as { who: string }

jest.mock('./dep.ts', () => ({ who: 'helper-mock' }))

module.exports = { depWho: dep.who }
