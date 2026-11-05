// D23: the coordinator assigns file ids with `fileIdOf`, and a core runtime used on its own computes
// them itself. The two must agree, or a standalone run and a coordinated one would name the same
// file differently (`@provino/core` does not export its formula, so this is where they meet).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRuntime } from '@provino/core'
import { fileIdOf } from '@provino/orchestrator'
import { createBehaviourLoader, neutralPolicy } from '@provino/policy'
import type { RuntimeEvent } from '@provino/types'

describe('fileIdOf', () => {
  for (const [project, path] of [
    ['', 'a.test.ts'],
    ['web', 'src/deep/a.test.ts'],
    ['bench', 'tests/app-0/file-12.test.js'],
  ] as const) {
    it(`is the id a standalone core runtime gives ${path} in project "${project}"`, async () => {
      const events: RuntimeEvent[] = []
      const runtime = await createRuntime({
        policy: neutralPolicy.core,
        behaviours: createBehaviourLoader(),
        sink: { emit: (event) => void events.push(event) },
        importFile: async () => {},
        rootDir: '/project',
        projectName: project,
      })
      await runtime.runFile(`/project/${path}`)
      const ids = events.flatMap((event) => (event.type === 'file-end' ? [event.fileId] : []))
      assert.deepEqual(ids, [fileIdOf(project, path)])
    })
  }
})
