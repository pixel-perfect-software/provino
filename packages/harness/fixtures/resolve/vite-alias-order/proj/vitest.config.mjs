import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('.', import.meta.url))

export default {
  resolve: {
    alias: [
      { find: '@first', replacement: `${dir}one` },
      { find: '@first', replacement: `${dir}two` },
      { find: '@both', replacement: `${dir}one` },
    ],
  },
  test: { alias: { '@both': `${dir}two`, '@only-test': `${dir}two` } },
}
