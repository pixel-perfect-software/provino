// The child of `pty.test.ts`: a program that reads keys from a terminal, as Jest's watch mode does,
// and says what it saw. Not Jest, so the relay's tests run where Jest's `--watch` can't.
//   argv[2] = "stubborn": ignore SIGTERM and start a grandchild in the same group.
import { spawn } from 'node:child_process'

const stubborn = process.argv[2] === 'stubborn'
if (stubborn) {
  process.on('SIGTERM', () => {})
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  process.stdout.write(`GRANDCHILD ${grandchild.pid}\n`)
}
process.stdout.write(
  `READY tty=${process.stdin.isTTY === true && process.stdout.isTTY === true} size=${process.stdout.columns}x${process.stdout.rows}\n`,
)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', (chunk) => {
  const text = chunk.toString('utf8')
  process.stdout.write(`key:${JSON.stringify(text)}\n`)
  if (text === 'q') process.exit(3)
  if (text === '\u0003') process.exit(0)
})
setTimeout(() => process.exit(9), 30_000).unref()
