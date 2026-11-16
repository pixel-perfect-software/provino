// The larger of the two files, so a runner with no history runs it first. Its test ends at once
// and leaves a timer that throws 200 ms later, while `second.test.ts` is running in the same
// process: circus's handlers are the second file's by then, and no test of that file raised it.
test('a schedules a timer and ends first', () => {
  setTimeout(() => {
    throw new Error('thrown by a timer of the first file')
  }, 200)
})
