// `node tooling/boundaries/src/cli.ts check|write [--root <dir>]`.
// --root: the repo to check or write (default: this checkout), so a test can run the CLI on a
//   small tree of its own.
// check: validates the manifest, the workspace against it, and the generated files, then runs
//   dependency-cruiser over the workspace roots. Every check runs, so one run reports everything.
// write: regenerates the files from the manifest, once the manifest itself validates.
import { spawnSync } from 'node:child_process'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { DEPCRUISE_CONFIG, GENERATED_DIR, generate } from './generate.ts'
import { loadManifest, type Problem, problem, validateManifest } from './manifest.ts'
import { DEPCRUISE_BIN, MANIFEST_REL, ROOT } from './paths.ts'
import { checkWorkspace, ignoredDirs, pluginSuppressions, readWorkspace } from './workspace.ts'

/** The mode and the repo to run on; anything else (an unknown flag, a bare `--root`) is a usage error. */
function parseCommand(): { mode: 'check' | 'write'; root: string } {
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: { root: { type: 'string' } },
    })
    const [mode, ...extra] = positionals
    if ((mode === 'check' || mode === 'write') && extra.length === 0) {
      return { mode, root: values.root === undefined ? ROOT : resolve(values.root) }
    }
  } catch {
    // parseArgs refused the arguments: the usage line below says what is accepted.
  }
  console.error('usage: node tooling/boundaries/src/cli.ts check|write [--root <dir>]')
  process.exit(2)
}

const { mode, root } = parseCommand()

const manifest = await loadManifest(join(root, MANIFEST_REL))
const workspace = await readWorkspace(root)
const manifestProblems = validateManifest(manifest)
const files = generate(manifest, workspace.roots)

// Drift between the generated files and the disk. A CRLF checkout holds the same content.
const stale: [path: string, content: string][] = []
for (const [path, content] of files) {
  const current = await readFile(join(root, path), 'utf8').catch(() => undefined)
  if (current?.replaceAll('\r\n', '\n') !== content) stale.push([path, content])
}
const orphans = (await readdir(join(root, GENERATED_DIR)).catch(() => []))
  .map((name) => `${GENERATED_DIR}/${name}`)
  .filter((path) => !files.has(path))

if (mode === 'write') {
  // Generation depends only on the manifest, so only its own problems block a write.
  if (manifestProblems.length > 0) {
    report(manifestProblems)
    console.error('Fix these before writing.')
    process.exit(1)
  }
  for (const [path, content] of stale) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
    console.log(`wrote ${path}`)
  }
  for (const path of orphans) {
    await rm(join(root, path))
    console.log(`removed ${path}`)
  }
  console.log('boundaries: generated files written')
  process.exit(0)
}

const problems: Problem[] = [
  ...manifestProblems,
  ...checkWorkspace(manifest, workspace),
  ...ignoredDirs(root, manifest),
  ...(await pluginSuppressions(root, workspace)),
  ...stale.map(([path]) =>
    problem(
      'manifest-stale-generated',
      `${path} is out of date with packages.json: run \`pnpm boundaries:write\``,
    ),
  ),
  ...orphans.map((path) =>
    problem(
      'manifest-stale-generated',
      `${path} is no longer generated: run \`pnpm boundaries:write\``,
    ),
  ),
]
report(problems)
const cruise = spawnSync(
  process.execPath,
  [DEPCRUISE_BIN, '--config', DEPCRUISE_CONFIG, ...workspace.roots],
  { cwd: root, stdio: 'inherit' },
)
if (problems.length > 0 || cruise.status !== 0) process.exit(1)
console.log('boundaries: manifest, workspace, generated files and dependencies agree')

function report(list: readonly Problem[]): void {
  for (const { rule, message } of list) console.error(`error ${rule}: ${message}`)
  if (list.length > 0) {
    console.error(`\n${list.length} boundary problem${list.length === 1 ? '' : 's'}\n`)
  }
}
