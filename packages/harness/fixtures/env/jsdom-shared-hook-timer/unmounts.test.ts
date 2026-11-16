// The largest file, so it runs first: a jsdom file whose test mounts a view through a package that
// unmounts it from its own `afterEach`. The unmount sets a timer that reads `window`, still pending
// when the file ends. No frame of this file is on that timer's stack: only the two packages' and
// the runner's call of the hook.
import { mount } from 'auto-cleanup'
import { createView } from 'deferred-destroy'

test('unmounts: a view the package unmounts after the test', () => {
  mount(createView())
})
