# Upstream: vscode-jest's reporter

`fixture.json` holds, as the text of `vscode-jest-reporter.js`, the reporter vscode-jest ships to
read a Jest run: `extension/out/reporter.js`, **unmodified**, from the published VSIX.

- Repository: https://github.com/jest-community/vscode-jest (MIT)
- Tag: `v6.4.4`
- Release asset: `vscode-jest-6.4.4.vsix` (394,125 bytes, sha256
  `6804b9da7c00b68331ac5a160f63b0e0b48a802881119bc03fa1f6c585cc5336`), taken from the extension's
  `extension/out/reporter.js` on 2026-11-13.

The file is webpack output (713 bytes), kept in `fixture.json` rather than as a `.js` file (D13).
Fixtures don't ship, so the MIT notice is not carried into a package.

The file is the one `cli/reporters-twenty` holds, byte for byte (`ide-vscode-jest.test.ts` checks it).
