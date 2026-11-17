// A listener of the process's own, as a library loaded outside the test files adds one (Next.js's
// transformer installs its unhandled-rejection filter in the process that runs the tests). It notes
// each rejection it hears in heard.txt, next to this file, as `String(reason)` (a test's error is of
// another realm under Jest, so `instanceof Error` would tell the runners apart).
const { appendFileSync } = require('node:fs') as typeof import('node:fs')
const { join } = require('node:path') as typeof import('node:path')

module.exports = function globalSetup(): void {
  process.on('unhandledRejection', (reason: unknown) => {
    appendFileSync(join(__dirname, 'heard.txt'), `${String(reason)}\n`)
  })
}
