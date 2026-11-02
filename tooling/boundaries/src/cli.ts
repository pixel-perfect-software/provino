// `node tooling/boundaries/src/cli.ts check|write`.
// check: validates the manifest, the workspace against it, and the generated files, then runs
//   dependency-cruiser over the workspace roots. Every check runs, so one run reports everything.
// write: regenerates the files from the manifest, once the manifest itself validates.
import { spawnSync } from 'node:child_process'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DEPCRUISE_CONFIG, GENERATED_DIR, generate } from './generate.ts'
import { loadManifest, type Problem, problem, validateManifest } from './manifest.ts'
import { DEPCRUISE_BIN, MANIFEST_PATH, ROOT } from './paths.ts'
import { checkWorkspace, ignoredDirs, pluginSuppressions, readWorkspace } from './workspace.ts'

const mode = process.argv[2]
if (mode !== 'check' && mode !== 'write') {
  console.error('usage: node tooling/boundaries/src/cli.ts check|write')
  process.exit(2)
}

const manifest = await loadManifest(MANIFEST_PATH)
const workspace = await readWorkspace(ROOT)
const manifestProblems = validateManifest(manifest)
const files = generate(manifest, workspace.roots)

// Drift between the generated files and the disk. A CRLF checkout holds the same content.
const stale: [path: string, content: string][] = []
for (const [path, content] of files) {
  const current = await readFile(join(ROOT, path), 'utf8').catch(() => undefined)
  if (current?.replaceAll('\r\n', '\n') !== content) stale.push([path, content])
}
const orphans = (await readdir(join(ROOT, GENERATED_DIR)).catch(() => []))
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
    await mkdir(dirname(join(ROOT, path)), { recursive: true })
    await writeFile(join(ROOT, path), content)
    console.log(`wrote ${path}`)
  }
  for (const path of orphans) {
    await rm(join(ROOT, path))
    console.log(`removed ${path}`)
  }
  console.log('boundaries: generated files written')
  process.exit(0)
}

const problems: Problem[] = [
  ...manifestProblems,
  ...checkWorkspace(manifest, workspace),
  ...ignoredDirs(ROOT, manifest),
  ...(await pluginSuppressions(ROOT, workspace)),
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
  { cwd: ROOT, stdio: 'inherit' },
)
if (problems.length > 0 || cruise.status !== 0) process.exit(1)
console.log('boundaries: manifest, workspace, generated files and dependencies agree')

function report(list: readonly Problem[]): void {
  for (const { rule, message } of list) console.error(`error ${rule}: ${message}`)
  if (list.length > 0) {
    console.error(`\n${list.length} boundary problem${list.length === 1 ? '' : 's'}\n`)
  }
}
