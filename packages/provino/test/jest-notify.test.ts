// `--notify` and `--notifyMode` (B23d A4): `provino jest` calls `node-notifier` as Jest's
// `NotifyReporter` does, held to what Jest 30.5.2 sent a fake `node-notifier` in the project
// (`cli/notify-*`: title, message and options, its icon path left out). `node-notifier` is never a
// dependency of Provino: the project's own copy is found from its root.
import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'provino'
import { loadFixture, materialize, underRoot } from './recorded.ts'
import { spawnCli } from './support.ts'

/** The calls a fake `node-notifier` wrote, with the icon taken out (a path of the machine). */
function withoutIcon(calls: unknown, ours = false): unknown {
  assert.ok(Array.isArray(calls), 'the calls are an array')
  return calls.map((call: Record<string, unknown>) => {
    const { icon, ...rest } = call
    // Ours is a path to Jest's logo, or none when no `@jest/reporters` is installed; the golden's is masked.
    if (ours)
      assert.ok(icon === undefined || (typeof icon === 'string' && icon.endsWith('jest_logo.png')))
    return rest
  })
}

describe('provino jest --notify sends what Jest 30.5.2 sent', () => {
  for (const [id, what] of [
    ['cli/notify-pass', 'a passing run: `<name> - 100% Passed`, `<n> tests passed`'],
    ['cli/notify-fail', 'a failing run: `<name> - 34% Failed`, `1 of 3 tests failed`'],
    [
      'cli/notify-no-manifest',
      'no package.json: the title starts with the root directory (Jest’s haste map finds no module name)',
    ],
    ['cli/notify-nameless-package', 'a package.json with no name: no prefix at all'],
    ['cli/notify-mode-success', '--notifyMode=success on a failing run: nothing is sent'],
  ] as const) {
    it(`${what} (${id})`, async () => {
      const fixture = await loadFixture(id)
      const project = await materialize(fixture)
      try {
        const ended = await spawnCli(
          [
            'jest',
            `--config=${join(project.root, 'jest.config.json')}`,
            '--ci',
            ...(fixture.manifest.run?.argv?.jest ?? []),
          ],
          { cwd: project.root },
        )
        assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr)
        let sent: unknown = null
        try {
          sent = withoutIcon(
            JSON.parse(
              underRoot(await readFile(join(project.root, 'notify.json'), 'utf8'), project.root),
            ),
            true,
          )
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        const expected = fixture.golden.observed?.json?.['notify.json'] ?? null
        assert.deepEqual(sent, expected === null ? null : withoutIcon(expected))
      } finally {
        await project.dispose()
      }
    })
  }

  it('the config file’s `notify` and `notifyMode` keys do the same as the flags (cli/notify-fail)', async () => {
    const fixture = await loadFixture('cli/notify-fail')
    const project = await materialize(fixture)
    try {
      const configPath = join(project.root, 'jest.config.json')
      const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
      await writeFile(configPath, JSON.stringify({ ...config, notify: true, notifyMode: 'always' }))
      const ended = await spawnCli(['jest', `--config=${configPath}`, '--ci'], {
        cwd: project.root,
      })
      assert.equal(ended.code, 1, ended.stderr)
      const calls = JSON.parse(await readFile(join(project.root, 'notify.json'), 'utf8'))
      const expected = fixture.golden.observed?.json?.['notify.json']
      assert.deepEqual(withoutIcon(calls, true), withoutIcon(expected))
      // The mode is read from the file: `success` there sends nothing for this failing run.
      await rm(join(project.root, 'notify.json'), { force: true })
      await writeFile(
        configPath,
        JSON.stringify({ ...config, notify: true, notifyMode: 'success' }),
      )
      const quiet = await spawnCli(['jest', `--config=${configPath}`, '--ci'], {
        cwd: project.root,
      })
      assert.equal(quiet.code, 1, quiet.stderr)
      await assert.rejects(readFile(join(project.root, 'notify.json'), 'utf8'), { code: 'ENOENT' })
    } finally {
      await project.dispose()
    }
  })

  it('no node-notifier anywhere: the run ends with Jest’s message and exit 1, before a file runs (cli/notify-missing)', async () => {
    const fixture = await loadFixture('cli/notify-missing')
    const project = await materialize(fixture)
    try {
      const ended = await spawnCli(
        ['jest', `--config=${join(project.root, 'jest.config.json')}`, '--ci', '--notify'],
        { cwd: project.root },
      )
      assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr)
      const line = ended.stderr
        .split('\n')
        .find((text) => text.includes('notify reporter requires'))
      assert.equal(line, fixture.golden.observed?.stderr)
      assert.ok(!/^Test Suites:/m.test(ended.stderr), 'no file ran')
    } finally {
      await project.dispose()
    }
  })
})
