# Third-party notices

Provino includes code copied from the projects below. Each vendor directory has an `UPSTREAM.md` naming the source, the version and every local change.

This file is the license notice for that code. Source files keep the license header they had upstream, but the build does not carry every header into a package's `dist`: it keeps some and drops others, and a few copied files never had one (`natural-compare`'s only says `@license MIT License`; Vitest's `jsdom-keys.ts` and `.each` title code have none). So the published `provino` package, and every other package whose `dist` holds copied code (`@provino/dialect-jest`, `@provino/dialect-vitest`, `@provino/snapshot`, `@provino/env-shared` and `@provino/coverage`), ships this file as `THIRD_PARTY_NOTICES.md`, and `pnpm hygiene` fails a package that holds copied code without it. Each of those copies must equal this file.

## Jest

`packages/dialect-jest/src/runtime/vendor/jest-expect/` is copied from Jest v30.5.2 (https://github.com/jestjs/jest).

`packages/dialect-jest/src/runtime/vendor/jest-circus/` is copied from Jest v30.5.2 (`jest-circus`'s `src/formatNodeAssertErrors.ts`).

`packages/dialect-jest/src/each/vendor/jest-each/` is copied from Jest v30.5.2 (`jest-each`'s `table/array.ts` and `table/interpolation.ts`, and one function of `jest-regex-util`).

`packages/dialect-jest/src/runtime/vendor/jest-snapshot/` and `packages/snapshot/src/vendor/deep-merge.ts` are copied from Jest v30.5.2, `packages/jest-snapshot/src/mockSerializer.ts` and `utils.ts`.

Smaller copies from Jest v30.5.x that have no vendor directory, each with its source named in the file's own comments:

- `packages/dialect-jest/src/node/cli-table.ts` is jest-cli's table of command-line options, with each option's description (`src/args.ts`).
- `packages/dialect-jest/src/node/valid-config.ts` is jest-config's example configs that validation checks against (`ValidConfig.ts`).
- `packages/dialect-jest/src/node/text.ts` holds message texts from jest-config and jest-validate.
- `packages/dialect-jest/src/node/docblock.ts` and `packages/orchestrator/src/worker/internal/runtime/pragmas.ts` hold the regular expressions of jest-docblock's `extract` and `parse` (`index.ts`).

`packages/harness/src/hoist-corpus/vendor/jest.json` holds test inputs copied from Jest v30.5.2, `packages/babel-plugin-jest-hoist/src/__tests__/hoistPlugin.nodejs18.test.ts`. Same MIT license as below. It is not part of any published package.

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

`packages/dialect-vitest/src/vendor/pretty-format/` is copied from Vitest v5.0.5 (https://github.com/vitest-dev/vitest), `packages/pretty-format/src/` and `packages/snapshot/src/port/mockSerializer.ts`; the files keep the Meta Platforms license header they were forked with (`mockSerializer.ts` is Jest's, under its older "Facebook, Inc." name: the Jest license above).

`packages/harness/src/hoist-corpus/vendor/vitest.json` holds test inputs copied from Vitest v5.0.5 (https://github.com/vitest-dev/vitest), `test/unit/test/injector-mock.test.ts`. It is not part of any published package.

`packages/dialect-vitest/src/each/vendor/` is copied from Vitest v5.0.5: `formatTitle` from the runner's `suite.ts`.

`packages/dialect-vitest/src/runtime/vendor/vitest-expect/` is copied from Vitest v5.0.5: `@vitest/expect`'s matchers, asymmetric matchers, custom matchers, sinon-chai names, equality and matcher utilities (`packages/expect/src/`, with an extract of `jest-extend.ts`).

`packages/dialect-vitest/src/vendor/vitest-utils/` is copied from Vitest v5.0.5: `@vitest/utils`' `diff/`, `display.ts`, `error.ts`, `serialize.ts`, `helpers.ts` and the files they import (`packages/utils/src/`; the diff files keep Meta's MIT header: they are forked from Jest's). Its `diff-sequences.ts` is Jest v30.5.2's `packages/diff-sequences/src/index.ts` (the Jest license above), which `@vitest/utils` bundles, and its `tinyrainbow.ts` is tinyrainbow (below).

`packages/env-shared/src/vendor/vitest/jsdom-keys.ts` is copied unchanged from Vitest v5.0.5, `packages/vitest/src/integrations/env/jsdom-keys.ts`: the keys jsdom's interfaces and window add. The file has no license header. `provino` ships it, through `@provino/env-shared`.

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

## tinyrainbow

`packages/dialect-vitest/src/vendor/vitest-utils/tinyrainbow.ts` is tinyrainbow 3.2.0 (https://github.com/tinylibs/tinyrainbow), the colours `@vitest/utils` and `@vitest/expect` 5.0.5 print with, ported to TypeScript from the package's published `dist/index.js`.

```
MIT License

Copyright (c) 2022 Tinylibs

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

## @vitest/istanbul-lib-instrument

`packages/coverage/src/vendor/istanbul-lib-instrument/` is copied from `@vitest/istanbul-lib-instrument` 2.1.0 (https://github.com/vitest-dev/istanbuljs, tag `v2.1.0`), Vitest's fork of `istanbul-lib-instrument` that parses with Oxc. It instruments the code for `--coverage`. The package's `LICENSE` holds two licenses: the original `istanbuljs` BSD-3-Clause license (Yahoo! Inc.) and the Vitest MIT license, and both apply.

```
Copyright 2012-2015 Yahoo! Inc.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * Neither the name of the Yahoo! Inc. nor the
      names of its contributors may be used to endorse or promote products
      derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL YAHOO! INC. BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

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

## Jenkins xunit plugin

`packages/reporters/src/junit/vendor/junit-10.xsd` is the JUnit schema of the Jenkins xunit plugin (https://github.com/jenkinsci/xunit-plugin, commit `ae25da5089d4f94ac6c4669bf736e4d416cc4665`), copied unchanged. It is used only by the JUnit reporter's test, to check the reporter's output with `xmllint-wasm`. It is not part of any published package. The file carries its own license header:

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

## vscode-jest

`packages/harness/fixtures/cli/reporters-twenty/fixture.json` holds, as the text of a file, the reporter vscode-jest 6.4.4 ships (`extension/out/reporter.js`, from the `vscode-jest-6.4.4.vsix` release asset of the jest-community/vscode-jest repository, tag `v6.4.4`), unmodified; `UPSTREAM.md` beside it has the asset's checksum. The same reporter, unmodified, is the `fixture.json` of each IDE-replay fixture in `packages/harness/fixtures/ide/vscode-jest-all`, `packages/harness/fixtures/ide/vscode-jest-dashed`, `packages/harness/fixtures/ide/vscode-jest-file`, `packages/harness/fixtures/ide/vscode-jest-pattern`, `packages/harness/fixtures/ide/vscode-jest-coverage`, `packages/harness/fixtures/ide/vscode-jest-related`, `packages/harness/fixtures/ide/vscode-jest-watch`, `packages/harness/fixtures/ide/vscode-jest-watch-all`, `packages/harness/fixtures/ide/vscode-jest-test-pattern`, `packages/harness/fixtures/ide/vscode-jest-test`, `packages/harness/fixtures/ide/vscode-jest-update-snapshot`, with an `UPSTREAM.md` beside each. All of these are test fixtures: none is part of any published package. The extension's license:

```
MIT License

Copyright (c) 2016 Orta

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

## Unicode Character Database

`packages/reporters/src/live/terminal/vendor/width-table.ts` is generated from the Unicode Character Database 16.0.0 (`EastAsianWidth.txt` and `emoji-data.txt`, https://www.unicode.org/Public/16.0.0/ucd/) by `packages/reporters/scripts/width-table.ts`, with an `UPSTREAM.md` beside it. It is part of `@provino/reporters` and so of `provino`. The data files' license:

```
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```
