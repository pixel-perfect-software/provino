// The sandbox's pure parts (D40): the Seatbelt profile text, the environment allowlist, and the
// fail-closed judgement of the probe. Nothing here applies a profile or touches the network: Claude
// Code's sandbox cannot nest `sandbox-exec`, and the real probe is Tyler's `corpus probe`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HarnessError } from '../errors.ts'
import {
  assertSandboxPlatform,
  BLOCKED_ATTEMPTS,
  evaluateProbe,
  type ProbeAttempt,
  parseProbeOutput,
  sandboxEnv,
  sandboxed,
  seatbeltProfile,
} from './sandbox.ts'

const HOME = '/Users/someone'

test('the profile denies the network but loopback and unix sockets, and the DNS services', () => {
  const profile = seatbeltProfile({ home: HOME, writable: ['/work/run'] })
  assert.match(profile, /^\(version 1\)\n\(allow default\)/)
  assert.ok(profile.includes('(deny network*)'))
  assert.ok(profile.includes('(allow network* (remote ip "localhost:*"))'))
  assert.ok(profile.includes('(allow network* (remote unix-socket))'))
  assert.ok(profile.includes('(deny mach-lookup (global-name "com.apple.dnssd.service"))'))
  // A rule later in a profile wins, so the deny comes before the allows that carve holes in it.
  assert.ok(profile.indexOf('(deny network*)') < profile.indexOf('(allow network*'))
})

test('the profile denies reading the credential paths under the real home', () => {
  const profile = seatbeltProfile({
    home: HOME,
    writable: ['/work/run'],
    deniedReads: ['/work/_canary'],
  })
  for (const denied of [
    '.ssh',
    '.aws',
    '.config',
    '.npmrc',
    'Library/Keychains',
    'Library/Group Containers/2BUA8C4S2C.com.1password',
  ]) {
    assert.ok(profile.includes(`(deny file-read* (subpath "${HOME}/${denied}"))`), denied)
  }
  assert.ok(profile.includes('(deny file-read* (subpath "/work/_canary"))'))
})

test('the profile writes only to the run directory', () => {
  const profile = seatbeltProfile({ home: HOME, writable: ['/work/run', '/work/run-2'] })
  assert.ok(profile.includes('(deny file-write*)'))
  assert.ok(profile.indexOf('(deny file-write*)') < profile.indexOf('(allow file-write* (subpath'))
  assert.ok(profile.includes('(allow file-write* (subpath "/work/run"))'))
  assert.ok(profile.includes('(allow file-write* (subpath "/work/run-2"))'))
  const allowed = profile.split('\n').filter((line) => line.startsWith('(allow file-write*'))
  assert.equal(allowed.filter((line) => line.includes('subpath')).length, 2)
})

test('a profile path that is relative or could break out of its string is refused', () => {
  for (const bad of ['relative/run', '/work/"run', '/work/run\\x', '/work/run\n(allow default)']) {
    assert.throws(
      () => seatbeltProfile({ home: HOME, writable: [bad] }),
      (error) => error instanceof HarnessError && error.code === 'HARNESS_CORPUS_NO_SANDBOX',
      bad,
    )
  }
})

test('the environment is an allowlist with HOME and TMPDIR inside the run directory', () => {
  const env = sandboxEnv({
    runDir: '/work/run',
    pathPrefix: ['/work/run/tree/node_modules/.bin'],
    nodeDir: '/opt/node/bin',
    extra: { TEST_SCOPE: 'node' },
  })
  assert.deepEqual(Object.keys(env).toSorted(), [
    'CI',
    'FORCE_COLOR',
    'HOME',
    'LANG',
    'PATH',
    'TEST_SCOPE',
    'TMPDIR',
    'TZ',
  ])
  assert.equal(env.HOME, '/work/run/home')
  assert.equal(env.TMPDIR, '/work/run/tmp')
  assert.equal(env.CI, '1')
  assert.equal(env.TZ, 'UTC')
  assert.equal(
    env.PATH,
    '/work/run/tree/node_modules/.bin:/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  )
  for (const name of ['HTTPS_PROXY', 'http_proxy', 'NODE_OPTIONS', 'NPM_TOKEN', 'GH_TOKEN']) {
    assert.equal(env[name], undefined, name)
  }
})

test('the subject env comes last, so it can set what a repository script sets', () => {
  const env = sandboxEnv({ runDir: '/r', nodeDir: '/n', extra: { TZ: 'America/New_York' } })
  assert.equal(env.TZ, 'America/New_York')
})

test('sandboxed wraps a command in sandbox-exec with the profile file', () => {
  assert.deepEqual(sandboxed('/work/run/sandbox.sb', '/usr/bin/node', ['a.js']), {
    command: '/usr/bin/sandbox-exec',
    args: ['-f', '/work/run/sandbox.sb', '/usr/bin/node', 'a.js'],
  })
})

test('only macOS has a sandbox yet', () => {
  assert.doesNotThrow(() => assertSandboxPlatform('darwin'))
  assert.throws(
    () => assertSandboxPlatform('linux'),
    (error) => error instanceof HarnessError && error.code === 'HARNESS_CORPUS_NO_SANDBOX',
  )
})

test('probe output is read one JSON object per line, and noise is dropped', () => {
  const output = [
    '{"name":"tcp","outcome":"error","code":"EPERM"}',
    'not json',
    '{"name":"mystery","outcome":"ok"}',
    '{"name":"loopback","outcome":"ok"}',
    '{"name":"dns","outcome":"sideways"}',
  ].join('\n')
  assert.deepEqual(parseProbeOutput(output), [
    { name: 'tcp', outcome: 'error', code: 'EPERM' },
    { name: 'loopback', outcome: 'ok' },
  ])
})

const BLOCKED: ProbeAttempt[] = [
  { name: 'tcp', outcome: 'error', code: 'EPERM' },
  { name: 'dns', outcome: 'error', code: 'ENOTFOUND' },
  { name: 'https', outcome: 'error', code: 'EPERM' },
  { name: 'canary', outcome: 'error', code: 'EPERM' },
  { name: 'ssh', outcome: 'error', code: 'EPERM' },
  { name: 'loopback', outcome: 'ok' },
]
const CONTROL: ProbeAttempt[] = [
  { name: 'tcp', outcome: 'ok' },
  { name: 'dns', outcome: 'ok' },
  { name: 'https', outcome: 'ok' },
]

function without(attempts: readonly ProbeAttempt[], name: string): ProbeAttempt[] {
  return attempts.filter((attempt) => attempt.name !== name)
}

test('a probe passes when every blocked attempt failed for a reason the sandbox explains', () => {
  const verdict = evaluateProbe(BLOCKED, CONTROL)
  assert.equal(verdict.ok, true, verdict.problems.join('; '))
  assert.equal(verdict.lines.length, BLOCKED_ATTEMPTS.length + 1)
})

test('an attempt that worked inside the profile is a leak', () => {
  for (const name of BLOCKED_ATTEMPTS) {
    const inside = [...without(BLOCKED, name), { name, outcome: 'ok' } satisfies ProbeAttempt]
    const verdict = evaluateProbe(inside, CONTROL)
    assert.equal(verdict.ok, false, name)
    assert.match(verdict.problems.join('\n'), new RegExp(`${name}: succeeded`))
  }
})

test('an attempt the probe did not report counts as having succeeded', () => {
  for (const name of BLOCKED_ATTEMPTS) {
    const verdict = evaluateProbe(without(BLOCKED, name), CONTROL)
    assert.equal(verdict.ok, false, name)
    assert.match(verdict.problems.join('\n'), new RegExp(`${name}: the probe did not report`))
  }
  assert.equal(evaluateProbe([], CONTROL).ok, false)
})

test('a timeout does not show the profile blocked anything', () => {
  const inside = [
    ...without(BLOCKED, 'tcp'),
    { name: 'tcp', outcome: 'timeout' } satisfies ProbeAttempt,
  ]
  const verdict = evaluateProbe(inside, CONTROL)
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join('\n'), /tcp: timed out/)
})

test('a network failure that is no denial needs the control to have worked', () => {
  const inside: ProbeAttempt[] = [
    ...without(BLOCKED, 'dns'),
    { name: 'dns', outcome: 'error', code: 'ENOTFOUND' },
  ]
  assert.equal(evaluateProbe(inside, CONTROL).ok, true)
  assert.equal(evaluateProbe(inside, without(CONTROL, 'dns')).ok, false)
  assert.equal(evaluateProbe(inside, undefined).ok, false)
})

test('a file read must be denied: "no such file" proves nothing, even with a control', () => {
  for (const name of ['canary', 'ssh'] as const) {
    const inside: ProbeAttempt[] = [
      ...without(BLOCKED, name),
      { name, outcome: 'error', code: 'ENOENT' },
    ]
    const verdict = evaluateProbe(inside, [...CONTROL, { name, outcome: 'ok' }])
    assert.equal(verdict.ok, false, name)
  }
})

test('loopback must work: a profile that cuts it off would break every test server', () => {
  const inside: ProbeAttempt[] = [
    ...without(BLOCKED, 'loopback'),
    { name: 'loopback', outcome: 'error', code: 'EPERM' },
  ]
  const verdict = evaluateProbe(inside, CONTROL)
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join('\n'), /loopback/)
  assert.equal(evaluateProbe(without(BLOCKED, 'loopback'), CONTROL).ok, false)
})
