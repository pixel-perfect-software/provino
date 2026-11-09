/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// provino: an extract of jest-regex-util 30.5.0's `src/index.ts` (`escapeStrForRegex` only, body unchanged)
export const escapeStrForRegex = (string: string): string =>
  string.replaceAll(/[$()*+.?[\\\]^{|}]/g, '\\$&');
