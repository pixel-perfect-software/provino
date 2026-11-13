// The second file: reads the variable the first file set.
const fs = process.getBuiltinModule('node:fs')

const sameWorker =
  fs.existsSync(`${__dirname}/first-ran.txt`) &&
  fs.readFileSync(`${__dirname}/first-ran.txt`, 'utf8') === String(process.pid)

test(`the first file ran before, in this worker: ${sameWorker}`, () => {})
test(`the first file's variable: ${process.env.PROVINO_FROM_FIRST}`, () => {})
