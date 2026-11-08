/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// provino: a stand-in for the two type sources array.ts reads. `Global` is the `Col`, `Row`,
// `Table` and `ArrayTable` members of @jest/types 30.5.2's `Global.ts`; `EachTests` is the type
// jest-each's `bind.ts` exports. Same shapes, no runtime code.
export declare namespace Global {
  type Col = unknown;
  type Row = ReadonlyArray<Col>;
  type Table = ReadonlyArray<Row>;
  type ArrayTable = Table | Row;
}

export type EachTests = ReadonlyArray<{
  title: string;
  arguments: ReadonlyArray<unknown>;
}>;
