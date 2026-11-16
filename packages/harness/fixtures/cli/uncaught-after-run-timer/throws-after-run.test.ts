// The timer waits for the whole results file, which the runner writes once the run is over, so it
// throws after the run on any machine (a file still being written does not parse yet). It gives up
// after 20 s, so a runner that writes no results file still exits.
const { readFileSync } = require('node:fs') as typeof import('node:fs')
const { join } = require('node:path') as typeof import('node:path')

function resultsWritten(): boolean {
  try {
    JSON.parse(readFileSync(join(__dirname, '.harness-out', 'jest.json'), 'utf8'))
    return true
  } catch {
    return false
  }
}

test('schedules a timer that throws once the run is over', () => {
  const started = Date.now()
  const poll = setInterval(() => {
    if (Date.now() - started > 20_000) clearInterval(poll)
    if (!resultsWritten()) return
    clearInterval(poll)
    throw new Error('thrown once the run is over')
  }, 5)
})
