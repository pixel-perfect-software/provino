// `node tooling/boundaries/src/cli.ts check|write`: validates the manifest against itself and the
// workspace, then checks (or writes) the files generated from it.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generate } from './generate.ts'
import { loadManifest, type Problem, validateManifest } from './manifest.ts'
import { checkWorkspace, readWorkspace } from './workspace.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const mode = process.argv[2]
if (mode !== 'check' && mode !== 'write') {
  console.error('usage: node tooling/boundaries/src/cli.ts check|write')
  process.exit(2)
}

const manifest = await loadManifest(join(root, 'tooling/boundaries/packages.json'))
const problems: Problem[] = [
  ...validateManifest(manifest),
  ...checkWorkspace(manifest, await readWorkspace(root)),
]

for (const [path, content] of generate(manifest)) {
  const target = join(root, path)
  const current = await readFile(target, 'utf8').catch(() => undefined)
  if (current === content) continue
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

for (const problem of problems) console.error(`error ${problem.rule}: ${problem.message}`)
if (problems.length > 0) {
  console.error(`\n${problems.length} boundary problem${problems.length === 1 ? '' : 's'}`)
  process.exit(1)
}
console.log('boundaries: manifest, workspace and generated files agree')
