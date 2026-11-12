// `node tooling/packaging/src/cli.ts <command>`, through the root scripts:
//   hygiene [--base <ref>] [--update-api] [--only <section>]…   (pnpm hygiene, hygiene:update-api)
//   pack --out <dir>                                            (pnpm pack:all)
//   smoke [--keep]                                              (pnpm smoke:install)
// Every command expects the packages to be built: the root scripts run `turbo run build` first.
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { hygiene, SECTIONS, type Section } from './hygiene.ts'
import { packAll } from './pack.ts'
import { installSmoke } from './smoke.ts'
import { publicPackages, ROOT } from './workspace.ts'

const [command, ...rest] = process.argv.slice(2)

function usage(message: string): never {
  console.error(
    `${message}\nusage: cli.ts hygiene|pack|smoke (see the header of tooling/packaging/src/cli.ts)`,
  )
  process.exit(2)
}

function isSection(name: string): name is Section {
  return (SECTIONS as readonly string[]).includes(name)
}

if (command === 'hygiene') {
  const { values } = parseArgs({
    args: rest,
    options: {
      base: { type: 'string', default: 'origin/main' },
      'update-api': { type: 'boolean', default: false },
      only: { type: 'string', multiple: true },
    },
  })
  const only = (values.only ?? []).map((name) => {
    if (!isSection(name)) usage(`unknown section "${name}" (${SECTIONS.join(', ')})`)
    return name
  })
  const results = hygiene({
    root: ROOT,
    base: values.base,
    updateApi: values['update-api'],
    ...(only.length > 0 ? { only } : {}),
  })
  let failed = 0
  for (const { section, problems, notes } of results) {
    console.log(`${problems.length === 0 ? 'ok  ' : 'FAIL'} ${section}`)
    for (const note of notes) console.log(`       ${note}`)
    for (const problem of problems)
      console.log(`       error: ${problem.replaceAll('\n', '\n       ')}`)
    failed += problems.length
  }
  console.log(failed === 0 ? '\nhygiene: every check passed' : `\nhygiene: ${failed} problem(s)`)
  process.exitCode = failed === 0 ? 0 : 1
} else if (command === 'pack') {
  const { values } = parseArgs({ args: rest, options: { out: { type: 'string' } } })
  if (values.out === undefined) usage('pack needs --out <dir>')
  const packs = packAll(publicPackages(ROOT), resolve(values.out))
  for (const packed of packs) console.log(packed.tarball)
} else if (command === 'smoke') {
  const { values } = parseArgs({
    args: rest,
    options: { keep: { type: 'boolean', default: false } },
  })
  const result = installSmoke({ root: ROOT, keep: values.keep })
  for (const { name, ok, output } of result.steps) {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
    if (!ok) console.log(output.trim().replaceAll(/^/gm, '       '))
  }
  if (result.kept !== undefined) console.log(`kept: ${result.kept}`)
  console.log(
    result.ok ? '\nsmoke: provino installed from its tarball and ran 3 files' : '\nsmoke: failed',
  )
  process.exitCode = result.ok ? 0 : 1
} else {
  usage(`unknown command "${command ?? ''}"`)
}
