// The second file: counts the listeners the first file added.
const fs = process.getBuiltinModule('node:fs')

const sameWorker =
  fs.existsSync(`${__dirname}/first-ran.txt`) &&
  fs.readFileSync(`${__dirname}/first-ran.txt`, 'utf8') === String(process.pid)

test(`the first file ran before, in this worker: ${sameWorker}`, () => {})
test(`exit listeners: ${process.listenerCount('exit')}`, () => {})
test(`uncaughtException listeners: ${process.listenerCount('uncaughtException')}`, () => {})
test(`SIGINT listeners: ${process.listenerCount('SIGINT')}`, () => {})
test(`provino-probe listeners: ${process.listenerCount('provino-probe')}`, () => {})
