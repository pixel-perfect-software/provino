import * as dnsPrefixed from 'node:dns'
import { EOL } from 'node:os'
import * as prefixed from 'node:zlib'
// biome-ignore lint/style/useNodejsImportProtocol: the bare spelling is what the case tests
import * as dnsBare from 'dns'
// biome-ignore lint/style/useNodejsImportProtocol: the bare spelling is what the case tests
import * as osBare from 'os'
// biome-ignore lint/style/useNodejsImportProtocol: the bare spelling is what the case tests
import * as bare from 'zlib'

jest.mock('zlib', () => ({ tag: 'mock-zlib' }))
jest.mock('node:dns', () => ({ tag: 'mock-dns' }))

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('a root __mocks__/os file with no mock call is not applied to the core module', () => ({
  eol: EOL,
  bareEol: osBare.EOL,
}))

c("mock('zlib') applies to 'zlib' and 'node:zlib'", () => ({
  bare: (bare as { tag?: string }).tag,
  prefixed: (prefixed as { tag?: string }).tag,
}))

c("mock('node:dns') applies to 'dns' and 'node:dns'", () => ({
  bare: (dnsBare as { tag?: string }).tag,
  prefixed: (dnsPrefixed as { tag?: string }).tag,
}))
