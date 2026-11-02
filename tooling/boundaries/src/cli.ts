// `node tooling/boundaries/src/cli.ts check|write`.
// check: validates the manifest, the workspace against it, and the generated files, then runs
//   dependency-cruiser over the workspace roots. Every check runs, so one run reports everything.
// write: regenerates the files from the manifest, once the manifest and workspace check clean.
import { spawnSync } from 'node:child_process'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEPCRUISE_CONFIG, GENERATED_DIR, generate } from './generate.ts'
import { loadManifest, type Problem, validateManifest } from './manifest.ts'
import { checkWorkspace, ignoredDirs, pluginSuppressions, readWorkspace } from './workspace.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const mode = process.argv[2]
if (mode !== 'check' && mode !== 'write') {
  console.error('usage: node tooling/boundaries/src/cli.ts check|write')
  process.exit(2)
}

const manifest = await loadManifest(join(root, 'tooling/boundaries/packages.json'))
const workspace = await readWorkspace(root)
const problems: Problem[] = [
  ...validateManifest(manifest),
  ...checkWorkspace(manifest, workspace),
  ...ignoredDirs(root, manifest),
  ...(await pluginSuppressions(root, workspace)),
]

if (mode === 'write' && problems.length > 0) {
  report(problems)
  console.error('Fix these before writing.')
  process.exit(1)
}

const files = generate(manifest, workspace.roots)
for (const [path, content] of files) {
  const target = join(root, path)
  const current = await readFile(target, 'utf8').catch(() => undefined)
  // A CRLF checkout (core.autocrlf) holds the same content.
  if (current?.replaceAll('\r\n', '\n') === content) continue
  if (mode === 'write') {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
    console.log(`wrote ${path}`)
  } else {
    problems.push({
      rule: 'manifest-stale-generated',
      message: `${path} is out of date with packages.json: run \`pnpm boundaries:write\``,
    })
  }
}
for (const name of await readdir(join(root, GENERATED_DIR)).catch(() => [])) {
  const path = `${GENERATED_DIR}/${name}`
  if (files.has(path)) continue
  if (mode === 'write') {
    await rm(join(root, path))
    console.log(`removed ${path}`)
  } else {
    problems.push({
      rule: 'manifest-stale-generated',
      message: `${path} is no longer generated: run \`pnpm boundaries:write\``,
    })
  }
}

if (mode === 'write') {
  console.log('boundaries: generated files written')
  process.exit(0)
}

report(problems)
// Run the JS entry with this Node, so it works where node_modules/.bin holds .cmd shims.
const depcruise = join(root, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs')
const cruise = spawnSync(
  process.execPath,
  [depcruise, '--config', DEPCRUISE_CONFIG, ...workspace.roots],
  { cwd: root, stdio: 'inherit' },
)
if (problems.length > 0 || cruise.status !== 0) process.exit(1)
console.log('boundaries: manifest, workspace, generated files and dependencies agree')

function report(list: readonly Problem[]): void {
  for (const problem of list) console.error(`error ${problem.rule}: ${problem.message}`)
  if (list.length > 0) {
    console.error(`\n${list.length} boundary problem${list.length === 1 ? '' : 's'}\n`)
  }
}
