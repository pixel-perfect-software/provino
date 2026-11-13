// DV80 (B21f, D7): `import()` from a CommonJS test file. Jest 30.5.2 without
// `--experimental-vm-modules` fails the call (`cli/cjs-dynamic-import`, recorded from the real
// runner); `provino jest` loads the module through the file's registry, so the same project passes.
// Where Jest throws, working is an improvement, and no passing suite can rely on the throw: a test
// that awaits the call fails there, so the only suites that differ are ones that failed under Jest.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadFixture, materialize } from './recorded.ts'
import { spawnCli } from './support.ts'

describe('import() from a CommonJS test file (DV80)', () => {
  it('fails under Jest 30.5.2 and passes under provino jest', async () => {
    const fixture = await loadFixture('cli/cjs-dynamic-import')
    const jest = fixture.golden.observed
    assert.equal(jest?.exitCode, 1, 'Jest fails the test')
    assert.match(jest?.stderr ?? '', /dynamic import callback was invoked without --experimental/)
    assert.match(
      fixture.golden.files[0]?.tests?.[0]?.status ?? '',
      /failed/,
      'Jest records the test as failed',
    )
    const project = await materialize(fixture)
    try {
      const ended = await spawnCli(['jest', `--config=${join(project.root, 'jest.config.json')}`], {
        cwd: project.root,
      })
      assert.equal(ended.signal, null)
      assert.equal(ended.code, 0, ended.stderr)
      assert.match(ended.stderr, /Tests:\s+1 passed, 1 total/)
    } finally {
      await project.dispose()
    }
  })
})
