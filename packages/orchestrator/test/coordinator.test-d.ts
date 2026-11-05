// The coordinator entry's public API that has no other type test.
import { fileIdOf } from '@provino/orchestrator'
import type { TaskId } from '@provino/types'
import { expectTypeOf } from 'expect-type'

// A file's id is a `TaskId` made from the project name and the file's relative path (D23).
expectTypeOf(fileIdOf).parameters.toEqualTypeOf<[project: string, relativePath: string]>()
expectTypeOf(fileIdOf).returns.toEqualTypeOf<TaskId>()

// @ts-expect-error the relative path is required: the id is made of both
fileIdOf('web')
// @ts-expect-error the project name is a string
fileIdOf(undefined, 'a.test.ts')
