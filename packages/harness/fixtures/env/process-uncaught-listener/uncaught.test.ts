const fs = process.getBuiltinModule('node:fs')

let heard = 0
process.on('uncaughtException', () => {
  heard += 1
})

afterAll(() => {
  fs.writeFileSync(
    `${__dirname}/heard.txt`,
    `the file's uncaughtException listener was called ${heard} times\n`,
  )
})

test('throws from a timer', (done) => {
  setTimeout(() => {
    throw new Error('thrown from a timer')
  }, 0)
  setTimeout(done, 50)
})
