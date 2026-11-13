// The first file in the worker: it is the larger of the two, and with no timings a runner starts
// the largest file first. It notes its worker's pid, so the second file can tell it ran before it
// in the same process, then writes `process.env` and reads it back, in the file and in a child
// process started with no `env` option (which inherits the worker's own environment).
const fs = process.getBuiltinModule('node:fs')
const { execFileSync } = process.getBuiltinModule('node:child_process')

process.env.PROVINO_FROM_FIRST = 'set by the first file'
;(process.env as Record<string, unknown>).PROVINO_NUMBER = 42

const inChild = execFileSync(process.execPath, [
  '-e',
  'process.stdout.write(String(process.env.PROVINO_FROM_FIRST))',
]).toString()

fs.writeFileSync(`${__dirname}/first-ran.txt`, String(process.pid))

test(`the file reads its own variable back: ${process.env.PROVINO_FROM_FIRST}`, () => {})
test(`an assigned number reads back as a ${typeof process.env.PROVINO_NUMBER}`, () => {})
test(`a child process started without an env option sees: ${inChild}`, () => {})
