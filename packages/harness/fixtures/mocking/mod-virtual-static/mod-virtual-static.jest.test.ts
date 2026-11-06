import { who } from './not-on-disk.ts'

jest.mock('./not-on-disk.ts', () => ({ who: 'virtual-relative' }), { virtual: true })

test('a virtual module imported statically', () =>
  observe('a virtual module imported statically', () => ({ who })))
