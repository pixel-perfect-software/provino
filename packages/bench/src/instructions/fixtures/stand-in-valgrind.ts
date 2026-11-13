// A stand-in for `valgrind --tool=cachegrind` in `run.test.ts` (valgrind is Linux only): it reads
// the options the bench passes, runs the program after them, and writes one cachegrind output file
// to the documented format where `--cachegrind-out-file` says (`%p` is its own pid), counting
// 1,000 instructions per byte the program printed, so the count follows the work. It checks the
// options it was given, so a change to them fails the test.
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const firstProgramArg = args.findIndex((arg) => !arg.startsWith('--'))
const options = args.slice(0, firstProgramArg)
const [program = '', ...programArgs] = args.slice(firstProgramArg)
for (const required of ['--tool=cachegrind', '--cache-sim=no', '--trace-children=yes']) {
  if (!options.includes(required)) {
    process.stderr.write(`stand-in valgrind: missing ${required}\n`)
    process.exit(3)
  }
}
const outFile = options.find((option) => option.startsWith('--cachegrind-out-file='))
if (outFile === undefined || !outFile.includes('%p')) {
  process.stderr.write('stand-in valgrind: no --cachegrind-out-file with %p\n')
  process.exit(3)
}
const run = spawnSync(program, programArgs, { encoding: 'utf8', env: process.env })
process.stdout.write(run.stdout)
process.stderr.write(run.stderr)
const instructions = 1000 * (run.stdout.length + run.stderr.length)
writeFileSync(
  outFile.slice('--cachegrind-out-file='.length).replace('%p', String(process.pid)),
  `desc: stand-in\ncmd: ${[program, ...programArgs].join(' ')}\nevents: Ir\nfl=???\nfn=main\n0 ${instructions}\nsummary: ${instructions}\n`,
)
process.exit(run.status ?? 1)
