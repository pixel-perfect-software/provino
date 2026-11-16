import { describeConfig } from 'esm-pkg'

test('the package loads through its extensionless import', () => {
  expect(describeConfig()).toBe('config: esm')
})
