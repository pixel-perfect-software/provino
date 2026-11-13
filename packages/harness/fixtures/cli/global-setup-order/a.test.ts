const fs = process.getBuiltinModule('node:fs')

test('runs between the setup and the teardown', () => {
  fs.appendFileSync('order.txt', 'test\n')
})
