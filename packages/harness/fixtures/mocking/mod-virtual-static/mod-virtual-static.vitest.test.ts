import { who } from './not-on-disk.ts'

vi.mock('./not-on-disk.ts', () => ({ who: 'virtual-relative' }))

test('a virtual module imported statically', () =>
  observe('a virtual module imported statically', () => ({ who })))
