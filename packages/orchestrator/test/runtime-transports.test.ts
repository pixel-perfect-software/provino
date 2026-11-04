// The real entry over each transport: the config and the events cross a real link, errors keep
// their `code` through core's serializer, and console output is attributed to the running test.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RuntimeEventOf } from '@provino/types'
import { eventsOf, KINDS, runJobs, runtimeConfig, runtimeJob, trackedProjects } from './support.ts'

const project = trackedProjects()

for (const pool of KINDS) {
  describe(`${pool}: the runtime entry`, () => {
    it('runs a file: statuses, assertion counts, console output tied to its test', async () => {
      const p = await project({
        'a.test.js': [
          "describe('suite', () => {",
          // Inline workers share the coordinator’s stdio, so only the others get a log to capture.
          `  test('passes', () => { expect(1).toBe(1); ${pool === 'inline' ? '' : "console.log('from the test')"} })`,
          "  test('fails', () => { expect(1).toBe(2) })",
          '})',
        ].join('\n'),
      })
      const config = runtimeConfig(p.dir)
      const job = runtimeJob(config, p.path('a.test.js'))
      const run = await runJobs({ pool, config, jobs: [job] })

      assert.deepEqual(run.exit, { type: 'exit', code: 0 })
      assert.equal(run.done.length, 1)
      const names = new Map<string, string>()
      for (const event of eventsOf(run.events, 'file-collect-end')) {
        for (const task of event.tasks) names.set(task.id, task.name)
      }
      const ended = eventsOf(run.events, 'test-end').map((event: RuntimeEventOf<'test-end'>) => [
        names.get(event.id),
        event.result.state,
        event.result.assertions,
        event.result.passingAssertions,
      ])
      assert.deepEqual(ended, [
        ['passes', 'pass', 1, 1],
        ['fails', 'fail', 1, 0],
      ])
      // Every event is the job’s own: the id the test gives matches what core derives.
      for (const event of eventsOf(run.events, 'file-end')) assert.equal(event.fileId, job.fileId)
      if (pool !== 'inline') {
        // Inline workers share the coordinator’s stdio, so nothing is captured there.
        const [log] = eventsOf(run.events, 'console')
        assert.equal(log?.text, 'from the test\n')
        assert.equal(names.get(log?.taskId ?? ''), 'passes')
      }
    })

    it('keeps the code of a startup error across the link, charged to the file', async () => {
      const p = await project({ 'a.test.js': '' })
      const base = runtimeConfig(p.dir)
      const config = { ...base, setupFiles: 'nope' as unknown as readonly string[] }
      const job = runtimeJob(base, p.path('a.test.js'))
      const run = await runJobs({ pool, config, jobs: [job] })
      const [error] = eventsOf(run.events, 'unhandled-error')
      assert.equal(error?.ownerId, job.fileId)
      assert.equal(error?.error.code, 'ORCH_BAD_CONFIG')
      assert.equal(error?.error.name, 'WorkerError')
      assert.deepEqual(run.exit, { type: 'exit', code: 0 })
    })
  })
}
