# Output

What Provino prints while a run goes and when it ends, when it prints Jest's text instead, and the flags and environment variables that change either. This applies to `provino jest` and to `provino run`. [Jest compatibility](compatibility.md) lists what Jest's own text covers.

Provino has two looks. On an interactive terminal it draws its own: a live footer of the busy workers, one line for each file as it ends, failures as they happen, and an end card. Everywhere else it prints Jest's text, byte for byte. The exit code, the file `--json` writes and the snapshot files are the same either way.

The examples on this page are the renderer's output on the fixture run its tests use: a run with passing, failing, skipped and todo files, console output, a snapshot mismatch and a file that fails to load. Each is a golden file committed with the code in `packages/reporters/src/__goldens__/`, with the escape codes taken out where a line says so. They are not captures of a real project.

## What you see on a terminal

While the run goes, the finished files scroll up the screen and a footer stays at the bottom.

**The footer.** A dim rule separates it from the finished files. Under it is one line for each busy worker, up to eight: a spinner, the worker's number, the file's path (cut from the left when it is long) and how long the file has been running. `+ N more workers` counts the rest, and `starting N workers` shows before the first file starts. A file is marked slow once it has run longer than it did last time (read from the results cache, or from the timings file), never under half a second. A file with no recorded time is marked slow after two seconds. The last line is the progress bar, the files done out of the total, the percent, the passed and failed counts (skipped and todo ones appear once there are any), the time so far and the time left. The time left shows once at least half of the files have a recorded time. At a narrow width the line drops the bar first, then the time left, then the file count.

<!-- capture: a frame of the footer on a real terminal, mid-run -->
The footer at 120 columns, 16 busy workers, with the escape codes removed:

```text
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ⠙ 1  src/feature-0/module-0.test.ts                                                                            1.6s 🐢
 ⠙ 2  src/feature-1/module-1.test.ts                                                                            1.6s 🐢
 ⠙ 3  src/feature-2/module-2.test.ts                                                                            1.6s 🐢
 ⠙ 4  src/feature-3/module-3.test.ts                                                                            1.6s
 ⠙ 5  src/feature-4/module-4.test.ts                                                                            1.6s
 ⠙ 6  src/feature-5/module-5.test.ts                                                                            1.6s
 ⠙ 7  src/feature-6/module-6.test.ts                                                                            1.6s
 ⠙ 8  src/feature-7/module-7.test.ts                                                                            1.5s
 + 8 more workers
░░░░░░░░░░░░░░░░░░░░░░░░  0/20 files  0%   ✅ 0  ❌ 0   1.6s · ~4s left
```

**Finished files.** Each file prints one line when it ends: a mark, its path, its test count and its time. A file that failed is followed at once by each failed test (its name path and its error message with the diff) and a code frame with the failing line and a caret under the column. Up to five frames of your own code follow when the error has them, then `… N more`. A file's console output prints under its line. Anything else the run writes to the terminal (a direct write to stdout or stderr, a worker's own stderr) goes above the footer too, so the footer stays in one place.

<!-- capture: a real terminal after a run with one failing file, the footer gone -->
The lines a run leaves on the screen, with no terminal (on a terminal the same lines are drawn above the footer):

```text
✅ math.test.ts · 3 tests · 12ms
❌ fails.test.ts · 1 of 2 failed · 9ms
   ● group › fails
     expect(received).toBe(expected) // Object.is equality

     Expected: 2
     Received: 1
     › fails.test.ts:3:15
       1 │ import { expect, test } from 'provino'
       2 │ test('fails', () => {
     > 3 │   expect(compute()).toBe(2)
         │               ^
       4 │ })
       5 │ 

✅ skipped.test.ts · 3 tests · 2 skipped · 3ms
⏩ all-skipped.test.ts · 2 tests skipped · 1ms
✅ todo-only.test.ts · 1 test · 1 skipped · 1ms
✅ console.test.ts · 1 test · 6ms
   at import time
   from the test
   a warning
   a direct write
❌ snapshot.test.ts · 1 of 1 failed · 7ms
   ● matches a stored snapshot
     expect(received).toMatchSnapshot()

     Snapshot name: `matches a stored snapshot 1`

     - Snapshot  - 1
     + Received  + 1

       {
     -   "value": "old",
     +   "value": "new",
       }
     › snapshot.test.ts:2:28
       1 │ test('matches a stored snapshot', () => {
     > 2 │   expect({ value: makeValue() }).toMatchSnapshot()
         │                            ^
       3 │ })
       4 │ 

❌ broken.test.ts · failed to run · 2ms
   ● Test suite failed to run
     ImportError: Cannot find module './missing.ts'

💥 2 failed · 6 passed · 3 skipped · 2 todo · 8 files · 1.23s
🐢 slowest: math.test.ts 12ms · fails.test.ts 9ms · snapshot.test.ts 7ms
snapshots: 1 failed

failed:
  ❌ group › fails  fails.test.ts:3:15
  ❌ matches a stored snapshot  snapshot.test.ts:2:28
  ❌ broken.test.ts
```

**The end card.** The footer is erased and the run ends with a verdict mark and headline (green when the run passed, red when it did not), the counts, the files and the time, the three slowest files, the snapshot totals, the command that updates them when a snapshot failed or is obsolete, the seed when the run shows one (`--showSeed`, `--randomize`) and every failure again, one line each, with its location.

<!-- capture: the end card of a real passing run and of a failing run with snapshots -->
A passing run, and a failing one with snapshots and a seed:

```text
🎉 4,000 tests passed in 1,980 files · 12.4s
🐢 slowest: src/a.test.ts 4.20s · src/b.test.ts 3.90s · src/c.test.ts 3.10s
```

```text
💥 1 failed · 3,999 passed · 1,980 files · 12.4s
🐢 slowest: src/a.test.ts 4.20s · src/b.test.ts 3.90s · src/c.test.ts 3.10s
snapshots: 1 failed · 2 written · 3 obsolete · 1 obsolete file · 8 passed
  re-run with `-u` to update them
seed: 1234

failed:
  ❌ cart › matches  src/cart.test.ts:4:7
```

Without a terminal there is no footer and no timer: finished files are written as plain lines in batches, and the end card closes the output.

## When Provino's output is chosen

With no reporter named, Provino prints its own output when all of these hold:

- stderr is an interactive terminal;
- the run is not on CI (the `CI` variable, or `--ci`) and is not under an AI agent (`CLAUDECODE`, `AI_AGENT`, …);
- `TERM` is not `dumb`;
- the run is not `--verbose` and its config is not verbose;
- the run is not `--watch` or `--watchAll`;
- under `provino jest`, the run is not one file that Jest's single-file rule lists (Jest prints that file's tests, and so does Provino).

When one of these fails, `provino jest` prints Jest's text byte for byte, and `provino run` prints its `default` reporter's text. Under an AI agent Provino prints the compact `agent` reporter (failures and totals), and on GitHub Actions it adds `github-actions` annotations.

Naming a reporter keeps the text of that reporter. `--reporters default`, `--reporters verbose`, a `reporters` key in the config and `provino run --reporter default` all print Jest's or the policy's text on a terminal too. Name `provino` to ask for Provino's output anywhere: `--reporters provino` or `reporters: ['provino']` under `provino jest`, `--reporter provino` under `provino run`. Off a terminal it prints plain lines, with no footer.

A path such as `./provino` or `./html` is still a reporter module.

## Flags

| Flag | What it does |
| --- | --- |
| `--reporters provino` (`provino run`: `--reporter provino`) | Provino's output where it isn't chosen, such as a pipe or CI |
| `--tree` | After the run's lines and before the end card, the files folder by folder: a passing file is one row, and a file with a failure opens to its suites and failed tests |
| `--map` | After the end card, one cell for each file, a row for each folder |
| `--no-emoji` (or `PROVINO_EMOJI=0`) | Plain symbols in place of emoji |
| `--reporters html` (`provino run`: `--reporter html`) | The [HTML report](#the-html-report) |

`--tree` and `--map` choose Provino's output when no reporter is named, wherever the run is: on a pipe they print as plain lines. Named beside other reporters and without `provino`, they are a usage error. Provino takes `--no-emoji`, `--tree`, `--map`, `--timings` and `--update-timings` out of a `provino jest` command line before Jest's parser sees it.

`--tree` keeps the failed files' trees, and both views keep a row for every file until the run ends, which a plain run does not.

<!-- capture: --tree on a real run, one failing folder open -->
A folder of the `--tree` view with a failing file, from the golden that holds the whole run:

```text
❌ src/cart/ · 4 files · 11 tests · 3 failed                                                                      138ms
├─ ❌ broken.test.ts · failed to run                                                                                2ms
│     ImportError: Cannot find module './missing.ts'
├─ ❌ fails.test.ts · 1 of 2 failed                                                                                 9ms
│  └─ ❌ group · 1 of 2 failed                                                                                      5ms
│     ├─ ❌ fails                                                                                                   4ms
│     │     expect(received).toBe(expected) // Object.is equality
│     └─ ✅ 1 more test                                                                                             1ms
├─ ❌ snapshot.test.ts · 1 of 1 failed                                                                              7ms
│  └─ ❌ matches a stored snapshot                                                                                  5ms
│        expect(received).toMatchSnapshot()
└─ ❌ total.test.ts · 1 of 8 failed                                                                               120ms
   └─ ❌ cart · 1 of 8 failed                                                                                      14ms
      ├─ ❌ total · 1 of 3 failed                                                                                   8ms
      │  ├─ ❌ applies the discount                                                                                 5ms
      │  │     expected 90, received 100
      │  └─ ✅ 2 more tests                                                                                         3ms
      ├─ ✅ empty · 2 tests                                                                                         2ms
      ├─ ⏩ tax · 2 tests skipped                                                                                   2ms
      └─ ✅ 1 more test                                                                                             2ms
```

<!-- capture: --map on a real run -->
The end of the `--map` view, a legend and one row for each folder:

```text
🟩 pass  🟥 fail  🟨 skip  ⬜ todo
src/cart/        🟥🟥🟥🟥
src/components/  🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩
src/math/        🟩🟩
tests/           🟨🟩🟩⬜
```

## Symbols, colour and links

Provino reads the environment and asks the terminal nothing.

- **Symbols.** Emoji are the default. `--no-emoji`, `PROVINO_EMOJI=0` (or `false`) and `TERM=dumb` give plain symbols (`✓ ✕ ○ ✎`, and the letters `. X s t` for the map). `TERM=linux`, and on Windows any terminal other than a known Unicode one (Windows Terminal, the VS Code terminal, ConEmu with Cmder, Terminus, JetBrains' terminal, or `TERM` set to `xterm-256color`, `alacritty` or `rxvt-unicode`), give ASCII: `ok`, `x`, `-`, `*`, a `#` bar and `|-` tree guides.
- **Colour.** `FORCE_COLOR` turns it on and wins over `NO_COLOR`; a non-empty `NO_COLOR` turns it off. Otherwise a terminal that is not `TERM=dumb` and not an agent's gets colour. CI alone does not turn it on.
- **Links.** A failure's `path:line:col` is a hyperlink to the file on a terminal that is not CI and is known to draw them: iTerm2, WezTerm, the VS Code terminal, Ghostty, Windows Terminal, kitty, and terminals built on VTE 0.50 or later. `FORCE_HYPERLINK=1` turns them on anywhere, and `FORCE_HYPERLINK=0` turns them off. The text stays `path:line:col`; the link points at the file.

<!-- capture: the same footer under --no-emoji, and in a terminal that gets the ASCII set -->
The footer at 40 columns in the ASCII set, with the escape codes removed:

```text
---------------------------------------
 \ 1  …e-0/module-0.test.ts   1.6s slow
 \ 2  …e-1/module-1.test.ts   1.6s slow
 \ 3  …e-2/module-2.test.ts   1.6s slow
 \ 4  …e-3/module-3.test.ts   1.6s
 \ 5  …e-4/module-4.test.ts   1.6s
 \ 6  …e-5/module-5.test.ts   1.6s
 \ 7  …e-6/module-6.test.ts   1.6s
 \ 8  …e-7/module-7.test.ts   1.5s
 + 8 more workers
0/20 files  0%   ok 0  x 0   1.6s
```

## A slow terminal

On POSIX systems a write to a terminal is synchronous: the run waits until the terminal takes it. Provino times every write it makes. It draws a frame at most every 60 ms, and only when something changed. The wait between frames is 100 times the average write time, up to two seconds, so a terminal that is slow to draw gets fewer frames and the run is not held up by it. When a stream does not take a write at once, no frame is drawn until it drains, and the finished lines wait for it in order, never dropped. Each frame is one write, wrapped in the escape codes for synchronized output, which terminals without it ignore.

The footer is erased and the cursor shown again when the run ends, when a signal ends it and when the process exits.

## The HTML report

`--reporters html` (or `reporters: ['html']`) under `provino jest`, and `--reporter html` under `provino run`, write one file when the run ends. It holds the whole run. It is not a server, and it fetches nothing: its content policy is `default-src 'none'`, and the page's own script runs only because its hash is in that policy. Open it from disk, attach it to a CI job or send it to a teammate.

<!-- capture: screenshot of the HTML report -->

The page has, top to bottom:

- **A verdict bar and a run overview.** The verdict, the counts, the time, the number of workers, the seed when the run shows one, and the snapshot totals. Under them every worker's files drawn along one time axis. Dragging across it, or a From and To field for the keyboard, limits every view to that range.
- **Failures,** the first view on a failing run: a row for each failed test and for each file that failed to run, the first one open with its message and code frame.
- **Tests,** a tree of every file, suite and test, with passing suites folded and failures open. A search box filters by path and title, and chips filter by Failed, Skipped and Todo.
- **Map,** a square for each file, grouped by folder.
- **Folders,** the time by folder: a table sorted by time with a bar for each folder, the share of the run and the slowest file.
- **Timeline,** a lane for each worker with a block for each file, so idle gaps show. A worker that was replaced after a crash is labelled with the worker it took over from. "Show as a table" lists the same data.

Every status is a symbol and a word as well as a pattern and a colour, the page follows the system's light or dark setting, and each view works from the keyboard. A failure's text is cut at 16 KB, and a run keeps the text of its first 1,000 failures: the rest are counted and their tests are listed without text.

**Where it is written.** The default is `provino-report.html` in the project's root. It is never written to stdout.

- Under `provino run`, `--outputFile <path>` names it. Beside `json` or `junit`, `--outputFile` is theirs and the page goes to `provino-report.html`.
- Under `provino jest`, `--outputFile` is Jest's (for `--json`), so name the page in the config: `reporters: [['html', { outputFile: 'reports/run.html' }]]`. A relative path is taken from the working directory. `outputFile` is the only option.
- The page is not a terminal reporter: named alone it prints nothing. Name a terminal reporter beside it to see the run too, for example `reporters: ['default', ['html', { outputFile: 'run.html' }]]` or `provino run --reporter provino --reporter html`.

## Environment variables

| Variable | Effect |
| --- | --- |
| `PROVINO_EMOJI=0` | Plain symbols in place of emoji, as `--no-emoji` |
| `FORCE_HYPERLINK=1` or `0` | Failure locations as hyperlinks on any output, or never |
| `FORCE_COLOR`, `NO_COLOR` | Colour on or off; `FORCE_COLOR` wins |
| `CI` | Provino's own output is not chosen, as with `--ci` |
| `TERM=dumb`, `TERM=linux` | Plain symbols, and ASCII |
| `CLAUDECODE`, `AI_AGENT`, … | Under an agent, the compact `agent` reporter |
