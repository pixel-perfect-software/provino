// The first file in the worker: it is the larger of the two, and with no timings a runner starts
// the largest file first. It notes its worker's pid, so the second file can tell it ran before it
// in the same process, then adds listeners to `process` for the second file to count.
const fs = process.getBuiltinModule('node:fs')

const atStart = {
  exit: process.listenerCount('exit'),
  uncaughtException: process.listenerCount('uncaughtException'),
  SIGINT: process.listenerCount('SIGINT'),
}

// Runs only if an `exit` event reaches this `process` while the worker ends.
process.on('exit', () => {
  fs.writeFileSync(`${__dirname}/exit-marker.txt`, 'the exit listener of the first file ran\n')
})
process.on('uncaughtException', () => {})
process.on('SIGINT', () => {})

let heard = 0
process.on('provino-probe', () => {
  heard += 1
})
const emitted = process.emit('provino-probe')

fs.writeFileSync(`${__dirname}/first-ran.txt`, String(process.pid))

test(`exit listeners when the file starts: ${atStart.exit}`, () => {})
test(`uncaughtException listeners when the file starts: ${atStart.uncaughtException}`, () => {})
test(`SIGINT listeners when the file starts: ${atStart.SIGINT}`, () => {})
test(`exit listeners after adding one: ${process.listenerCount('exit')}`, () => {})
test(`a listener of its own hears its own emit: ${emitted && heard === 1}`, () => {})
