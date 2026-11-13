import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { runCommand } from './exec.ts'
import { packPackage } from './pack.ts'
import { readManifest } from './package-json.ts'

describe('runCommand', () => {
  test('keeps stdout and stderr apart, and joins them as output', () => {
    const result = runCommand(
      process.execPath,
      ['-e', "process.stdout.write('out'); process.stderr.write('err')"],
      { cwd: tmpdir() },
    )
    assert.equal(result.status, 0)
    assert.equal(result.stdout, 'out')
    assert.equal(result.stderr, 'err')
    assert.equal(result.output, 'outerr')
    assert.equal(result.error, undefined)
  })

  test('a command that cannot be started says so, and is not an empty or "nullnull" result', () => {
    const result = runCommand('provino-no-such-command', ['--x'], { cwd: tmpdir() })
    assert.equal(result.status, null)
    assert.equal(result.error?.code, 'ENOENT')
    assert.match(result.output, /provino-no-such-command: spawnSync provino-no-such-command ENOENT/)
    assert.doesNotMatch(result.output, /null/)
  })

  test('a command that outruns its deadline is killed, and says so', () => {
    const result = runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: tmpdir(),
      timeoutMs: 300,
    })
    assert.equal(result.status, null)
    assert.equal(result.error?.code, 'ETIMEDOUT')
    assert.match(result.output, /did not end within 300 ms and was killed/)
  })

  test('a failing exit status is a status, not an error', () => {
    const result = runCommand(process.execPath, ['-e', 'process.exit(3)'], { cwd: tmpdir() })
    assert.equal(result.status, 3)
    assert.equal(result.error, undefined)
  })
})

describe('packPackage reads pnpm pack --json from stdout only', () => {
  /** A package, and a stand-in for pnpm that writes `stderr` and the JSON `stdout`. */
  function setup(stderr: string, stdout: string, exit = 0) {
    const dir = mkdtempSync(join(tmpdir(), 'pack-'))
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@provino/planted', version: '1.2.3' }),
    )
    const fake = join(dir, 'fake-pnpm.cjs')
    writeFileSync(
      fake,
      `process.stderr.write(${JSON.stringify(stderr)}); process.stdout.write(${JSON.stringify(stdout)}); process.exit(${exit})`,
    )
    chmodSync(fake, 0o755)
    return {
      pkg: { dir, rel: 'planted', manifest: readManifest(dir) },
      fake,
      out: join(dir, 'out'),
    }
  }

  const before = process.env.npm_execpath
  afterEach(() => {
    if (before === undefined) delete process.env.npm_execpath
    else process.env.npm_execpath = before
  })

  const JSON_RESULT = JSON.stringify({
    name: '@provino/planted',
    version: '1.2.3',
    filename: '/x/provino-planted-1.2.3.tgz',
    files: [{ path: 'package.json' }],
  })

  test('a warning on stderr, before or after the JSON, does not break the parse', () => {
    for (const stderr of [
      ' WARN  deprecated thing: 1.0\n',
      '{ not json }\n',
      ' WARN  the tarball is large\n'.repeat(3),
    ]) {
      const { pkg, fake, out } = setup(stderr, `${JSON_RESULT}\n`)
      process.env.npm_execpath = fake
      const packed = packPackage(pkg, out)
      assert.equal(packed.name, '@provino/planted')
      assert.equal(packed.tarball, '/x/provino-planted-1.2.3.tgz')
      assert.deepEqual(packed.files, ['package.json'])
    }
  })

  test('a pnpm that cannot be started is reported as that, with the cause', () => {
    const { pkg, out } = setup('', '')
    mkdirSync(out, { recursive: true })
    process.env.npm_execpath = join(pkg.dir, 'missing-pnpm.cjs')
    // node runs the missing script: a non-zero exit, with node's own message in the output.
    assert.throws(() => packPackage(pkg, out), /pnpm pack failed in planted/)
  })

  test('a pnpm that fails says why, with its stderr', () => {
    const { pkg, fake, out } = setup(' ERR_PNPM_NOPE  broken\n', '', 1)
    process.env.npm_execpath = fake
    assert.throws(() => packPackage(pkg, out), /pnpm pack failed in planted:[\s\S]*ERR_PNPM_NOPE/)
  })
})
