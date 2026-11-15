// Registers jest-image-snapshot's matcher, and after each file writes `image-hashes.txt`: the path
// and sha256 of every .png under `__image_snapshots__/` (the diffs included), sorted, so the
// golden holds what was written without a binary file.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { toMatchImageSnapshot } from 'jest-image-snapshot'

expect.extend({ toMatchImageSnapshot })

function pngsUnder(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${prefix}${entry.name}`
    if (entry.isDirectory()) return pngsUnder(join(dir, entry.name), `${path}/`)
    return entry.name.endsWith('.png') ? [path] : []
  })
}

afterAll(() => {
  const root = dirname(expect.getState().testPath ?? '')
  const snapshots = join(root, '__image_snapshots__')
  const lines = pngsUnder(snapshots, '')
    .sort()
    .map((path) => {
      const hash = createHash('sha256')
        .update(readFileSync(join(snapshots, path)))
        .digest('hex')
      return `${path} ${hash}\n`
    })
  writeFileSync(join(root, 'image-hashes.txt'), lines.join(''))
})
