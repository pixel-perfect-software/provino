// A timer no test owns, set as the file loads, fires 300 ms later: the file ended long before, and
// its worker sits idle while `second.test.ts` keeps the run going in the other one.
setTimeout(() => {
  throw new Error('thrown by a timer no test owns')
}, 300)

test('a ends long before its timer fires', () => {})
