# Third-party notices

Provino includes code copied from the projects below. Each copy keeps its original license header, and each vendor directory has an `UPSTREAM.md` naming the source, the version and every local change.

## Jest

`packages/dialect-jest/src/runtime/vendor/jest-expect/` is copied from Jest v30.5.2 (https://github.com/jestjs/jest).

`packages/dialect-jest/src/each/vendor/jest-each/` is copied from Jest v30.5.2 (`jest-each`'s `table/array.ts` and `table/interpolation.ts`, and one function of `jest-regex-util`).
`packages/dialect-jest/src/runtime/vendor/jest-snapshot/` and `packages/snapshot/src/vendor/deep-merge.ts` are copied from Jest v30.5.2, `packages/jest-snapshot/src/mockSerializer.ts` and `utils.ts`.

`packages/harness/src/hoist-corpus/vendor/jest.json` holds test inputs copied from Jest v30.5.2, `packages/babel-plugin-jest-hoist/src/__tests__/hoistPlugin.nodejs18.test.ts`. Same MIT license as below.

```
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.
Copyright Contributors to the Jest project.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Vitest

`packages/dialect-vitest/src/vendor/pretty-format/` is copied from Vitest v5.0.5 (https://github.com/vitest-dev/vitest), `packages/pretty-format/src/` and `packages/snapshot/src/port/mockSerializer.ts`; the files keep the Meta Platforms license header they were forked with.

`packages/harness/src/hoist-corpus/vendor/vitest.json` holds test inputs copied from Vitest v5.0.5 (https://github.com/vitest-dev/vitest), `test/unit/test/injector-mock.test.ts`.

`packages/dialect-vitest/src/each/vendor/` is copied from Vitest v5.0.5: `formatTitle` from the runner's `suite.ts`, `display.ts` and parts of `helpers.ts` from `@vitest/utils`, and `@vitest/pretty-format` (a fork of Jest's pretty-format, so its files keep Meta's MIT header).

```
MIT License

Copyright (c) 2021-Present VoidZero Inc. and Vitest contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## natural-compare

`packages/snapshot/src/vendor/natural-compare.ts` is natural-compare 1.4.0 by Lauri Rooden (https://github.com/litejs/natural-compare-lite), ported to TypeScript. It orders the keys of a `.snap` file as Jest and Vitest do.

```
MIT License

Copyright (c) 2015 Lauri Rooden

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Jenkins xunit plugin

`packages/reporters/src/junit/vendor/junit-10.xsd` is the JUnit schema of the Jenkins xunit plugin (https://github.com/jenkinsci/xunit-plugin, commit `ae25da5089d4f94ac6c4669bf736e4d416cc4665`), copied unchanged. It is used only by the JUnit reporter's test, to check the reporter's output with `xmllint`. The file carries its own license header:

```
The MIT License (MIT)

Copyright (c) 2014, Gregory Boissinot

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
