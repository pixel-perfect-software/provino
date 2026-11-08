// Text that the normalization rules exist for, thrown and printed, so the rules fire on recorded
// output (`src/normalize.fixtures.test.ts`). `windows-separators` can't fire on a POSIX machine,
// so its cases there are written by hand.
import { pathToFileURL } from 'node:url'

const fileUrl = (): string => pathToFileURL(expect.getState().testPath ?? '').href

describe('text the normalization rules exist for', () => {
  it('colour codes', () => {
    throw new Error('\u001b[31mred\u001b[39m and \u001b[1mbold\u001b[22m')
  })

  it('CRLF line ends', () => {
    throw new Error('first line\r\nsecond line')
  })

  it('a file URL', () => {
    throw new Error(`see ${fileUrl()}`)
  })

  it('a UUID', () => {
    throw new Error('request 123e4567-e89b-12d3-a456-426614174000 failed')
  })

  it('a hex address', () => {
    throw new Error('segfault at 0x00007ffd5e8c1a40')
  })

  it('a temp path', () => {
    throw new Error('cannot write /tmp/x/report.json')
  })

  it('a duration', () => {
    throw new Error('the step took (12 ms)')
  })

  it('prints the same kinds of text', () => {
    console.log('\u001b[32mgreen\u001b[39m')
    console.log(`url ${fileUrl()}`)
    console.log('id 123e4567-e89b-12d3-a456-426614174000 at 0x00007ffd5e8c1a40')
    console.log('wrote /tmp/x/out.txt')
    console.log('done (3 ms)')
    console.log('windows line\r\nend')
    expect(true).toBe(true)
  })
})
