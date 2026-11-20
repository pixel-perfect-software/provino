import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('.', import.meta.url))

export default {
  resolve: {
    alias: [
      { find: /^~(.*)$/, replacement: `${dir}home$1` },
      { find: /^@old\/(.+)\/index$/, replacement: `${dir}new/$1.js` },
      { find: /(a)(b)/, replacement: `${dir}x-$2$1.js` },
    ],
  },
}
