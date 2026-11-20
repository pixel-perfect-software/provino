import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('.', import.meta.url))

export default {
  resolve: {
    alias: [
      { find: '@', replacement: `${dir}src` },
      { find: 'lib/', replacement: `${dir}lib/` },
      { find: 'exact', replacement: `${dir}src/exact.js` },
    ],
  },
}
