---
name: "autoresearch-stream-opt"
description: "Autonomous experimentation loop for TmuxGo streaming transport optimization. Adapts karpathy/autoresearch methodology to maximize kb/s throughput and eliminate flicker. Invoke when optimizing stream-binary, terminal-grid cell diff, gzip compression, or fixing refresh flicker in the terminal streaming pipeline."
---

# autoresearch-stream-opt

Autonomous research loop for TmuxGo streaming transport, adapted from karpathy/autoresearch `program.md`. The agent modifies code, restarts/rebuilds via `./start.sh --restart --rebuild`, smoke-tests, measures, keeps or discards, and repeats — indefinitely until interrupted.

## In-scope files

Gateway (server-side encoding/sending):
- `apps/gateway/src/routes/stream.ts` — flush loop, caps negotiation, cell/compress wiring
- `apps/gateway/src/lib/stream-binary.ts` — binary frame encode, gzip strategy
- `apps/gateway/src/lib/terminal-grid/ansi-parser.ts` — ANSI → cells
- `apps/gateway/src/lib/terminal-grid/grid.ts` — grid state, diff source
- `apps/gateway/src/lib/terminal-grid/diff.ts` — diff algorithm
- `apps/gateway/src/lib/terminal-grid/encode-cell.ts` — cell snapshot/diff binary encoder
- `apps/gateway/src/lib/terminal-grid/decode-cell.ts` — symmetric decoder (roundtrip tests)
- `apps/gateway/src/lib/perf-metrics.ts` — counters exposed via `/api/system`

Frontend (client-side decode/apply):
- `apps/frontend/src/hooks/useWebSocket.ts` — binary message queue, caps, cell_resync
- `apps/frontend/src/lib/stream-binary.ts` — gunzip + frame decode
- `apps/frontend/src/lib/terminal-grid/apply-cell.ts` — snapshot/diff → ANSI (DEC 2026 sync)

Fixtures & bench:
- `tests/fixtures/terminal-streams/*` — frozen corpora
- `scripts/bench-stream-transport.ts` — offline wire-size bench
- `tests/stream-binary.test.ts`, `tests/terminal-grid.test.ts` — roundtrip correctness

Out-of-scope (do not edit unless absolutely necessary):
- `docs/stream-transport-opt/PROTOCOL.md` — frozen wire protocol
- `start.sh` — service orchestration
- `apps/gateway/src/lib/terminal-output.ts` — sanitizer (only touch if sanitizer causes flicker)

## Setup

1. **Agree on a run tag** based on today's date (e.g. `jul24`). `git rev-parse --verify autoresearch/<tag>` must fail — fresh run.
2. **Create branch**: `git checkout -b autoresearch/<tag>` from current `main`/`master`.
3. **Read in-scope files**: read all gateway stream-binary/terminal-grid files and frontend useWebSocket/stream-binary/apply-cell files for full context.
4. **Initialize results.tsv**: create `docs/stream-transport-opt/results-<tag>.tsv` with header row only. Baseline is recorded after the first run.
5. **Verify services can start**: `./start.sh --restart --rebuild` once to confirm baseline boots.
6. **Confirm and go**: confirm setup looks good before entering the loop.

## Metrics

Primary metric: **kbps** (kilobytes per second of useful terminal payload delivered to the client). Higher is better. This is the inverse of autoresearch's `val_bpb`.

Secondary metric: **flicker_score** (0 = no flicker, 10 = severe). Subjective but anchored:
- 0: rock-solid, no visible flashing
- 3: occasional flicker on large updates
- 6: frequent flicker on attach/resize
- 10: constant screen clearing storm

Tertiary observables (from `/api/system`):
- `compressBytesOut / compressBytesIn` ratio (lower = better compression)
- `cellFallbackAnsi` count (lower = more cell mode stability)
- `outputResyncRequests` (lower = more stable)
- `droppedOutputChars` (lower = less backpressure loss)

## Experiment loop

LOOP FOREVER:

1. **Inspect state**: `git status`, current branch/commit.
2. **Form a hypothesis**: state what should improve kb/s or reduce flicker, and why.
3. **Edit in-scope file(s)**: implement the change. Match surrounding code style. No new dependencies.
4. **Typecheck**: `npx tsc -p apps/gateway/tsconfig.json` and `npx tsc -p apps/frontend/tsconfig.json` must pass.
5. **Unit tests**: `npx tsx --test tests/stream-binary.test.ts tests/terminal-grid.test.ts` must be green.
6. **Commit**: `git commit -m "<short description>"` on the experiment branch.
7. **Restart + rebuild**: `./start.sh --restart --rebuild` (or `scripts/restart-rebuild.sh "<msg>"`). Wait for `Systemd services ready` or equivalent.
8. **Smoke test**: open a tmux session, attach via web UI, run a noisy workload (`yes`, `find /`, `htop`, color scripts), trigger resize, switch tabs. Observe flicker subjectively (record flicker_score).
9. **Measure kb/s**: sample `/api/system` over 30s during the noisy workload. Compute `delta(outputBytes) / 30 / 1024`. Also pull `compressBytesOut/In`, `cellFallbackAnsi`, `outputResyncRequests`.
10. **Record** in results-<tag>.tsv (tab-separated, NOT comma):
    ```
    commit<TAB>kbps<TAB>flicker_score<TAB>status<TAB>description
    ```
    - `status`: `keep` | `discard` | `crash`
    - crash: build failed, runtime panic, or services won't start → record `0.0` kbps, `10` flicker, `crash`
11. **Decide**:
    - kbps improved AND flicker_score ≤ previous → **keep** (advance branch)
    - kbps improved but flicker worse → **discard** (revert) unless flicker is still ≤ 3
    - kbps flat but flicker improved AND code simpler → **keep**
    - kbps flat and flicker flat → **discard**
    - kbps worse → **discard**
12. **If discard**: `git reset --hard HEAD~1` to drop the experimental commit.
13. **NEVER STOP**. Do not ask the human whether to continue. The human may be away. Run indefinitely until manually interrupted. If out of ideas, re-read in-scope files, check `docs/stream-transport-opt/WORKLOG.md` for prior near-misses, try combining ideas, try more radical changes (different flush cadence, different cell dirty threshold, different gzip threshold, dropping cell path entirely if it never wins).

## Constraints

- **No new npm dependencies.** Use only what's already in package.json.
- **Protocol frozen.** Do not change `STREAM_BINARY_VERSION`, type codes 1–8, or the header layout in `PROTOCOL.md`.
- **VRAM-equivalent: socket buffer.** `socketBufferedBytes` must not blow up. If a change causes persistent >1MB buffered, discard.
- **Simplicity criterion**: all else equal, simpler is better. A 0.5% kb/s gain from 30 lines of convoluted code is not worth it. A 0% gain from deleting code is a win.
- **Backwards compat**: a client with `binaryOutput:false` must still work (JSON path). A client with `compressOutput:false` must still work.
- **No skipping rebuild**: every experiment that touches gateway/frontend source MUST run `./start.sh --restart --rebuild` before measuring. Measuring against a stale build invalidates the result.

## Flicker root causes (known, from WORKLOG)

1. Concurrent `await decode` of binary frames → out-of-order application → cell seq mismatch → `cell_resync` storm → snapshot clearing screen.
2. Cell snapshot contains `\x1b[H\x1b[2J` full-screen clear; at high frequency this is visible as flicker.
3. Cell mode enabled by default in systemd drop-in but frontend didn't declare cell caps correctly.
4. Mitigations already applied: serial `binaryMessageQueue`, frontend `cellOutput:false` default, cell apply uses DEC 2026 sync region (`\x1b[?2026h...\x1b[?2026l`), snapshot uses `\x1b[J` instead of `\x1b[2J` where possible.

When experimenting with cell mode re-enablement, always keep the serial queue and DEC 2026 wrapping.

## results.tsv example

```
commit	kbps	flicker_score	status	description
a1b2c3d	120.5	2	keep	baseline: gzip only, cell off
b2c3d4e	135.2	2	keep	raise compress threshold to 8192
c3d4e5f	118.0	6	discard	re-enable cell mode (flicker regression)
d4e5f6g	0.0	10	crash	broke stream.ts import path
```

## Stopping conditions

- Human interrupts (STOP command, new message, etc.).
- 5 consecutive discards with no improvement → step back, re-read everything, try a different angle. Do NOT stop.
- Branch diverged >50 commits from main without a clear winner → consider rewinding to last keep and trying a different family of ideas. Do NOT stop.

The loop runs until the human interrupts, period.
