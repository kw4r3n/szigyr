# Strict-Layer Non-Numeric Workloads and Allocation Micro-Benchmarks

Non-CI benchmark suite comparing Szigyr's strict layer (C dev, C release, Wasm) with matching-layout Rust (`*_same.rs`) and idiomatic stdlib Rust (`*_idiom.rs`) on five non-numeric workloads, plus micro-benchmarks for allocation and managed-to-strict boundary crossings (`m`).

## What is measured

- **Workloads (`t1`–`t5`)** — each builds its input outside the timer, runs the strict core 7 times inside one boundary crossing (`Clock.nowMs()`), and reports `best_ms` (minimum of 7):
  - `t1`: tokenizer over 16,000,000 bytes (checksum `1282472460`)
  - `t2`: word frequency over 4,000,000 words with open-addressing FNV-1a table (checksum `4274193343`)
  - `t3`: iterative unbalanced binary search tree over 800,000 keys (checksum `2574783783`)
  - `t4`: counting-layout grouping of 8,000,000 pairs (checksum `2207450853`)
  - `t5`: stable merge + simulation over 2 x 4,000,000 events (checksum `3321175533`)
- **Micro-benchmarks (`m/m.szigyr`, `m/m.rs`)**:
  - `alloc_small`: create a 16-element `Vec<u32>` and push 16 values `N` times inside one strict call (`m.szigyr` accepts optional `[count]` and `alloc_small` args; defaults to `N = 1000000`)
  - `push_grow`: 20,000,000 `push` calls on one `Vec<u32>` starting at capacity 16
  - `call_scalar`: 2,000,000 managed-to-strict scalar calls (`add1(x: i32)`)
  - `call_slice_small`: 1,000,000 managed-to-strict calls with a 16-element `Ref<Slice<f32>>`
  - `call_slice_large`: 200 managed-to-strict calls with a 4,000,000-element `Ref<Slice<f32>>`

## How to run

```sh
pnpm bench:workloads
```

- Requires a C compiler and `clang`/`lld` (for Wasm). If `rustc` is installed, `rust-same` and `rust-idiom` columns and ratios are included; otherwise `rustc` columns are omitted with a one-line notice.
- Each workload variant (`t1`–`t5`) runs 3 times and reports the minimum `best_ms`. If any variant produces a mismatched checksum, the script exits with code `1`.
- This benchmark is **not** run in CI.

## Pre-fix baseline (`main` `854a30f` / `1f29cb5`, 2026-11-25)

From `eval-20261125-bench/RESULTS.md` (Node 26.13.1, rustc 1.99.1 `-C opt-level=3`, Ryzen 9 5900X, machine not idle; 3 runs except 1 run for Wasm; `Clock.nowMs` has 1 ms resolution):

| Task | rust-same | szigyr C dev | szigyr C release | szigyr Wasm | rust-same-ovf | rust-idiom |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| t1 tokenizer, 16,000,000 bytes | 68.5 | 85.0 (1.24) | 86.0 (1.26) | 131.0 (1.91) | 69.3 (1.01) | 78.5 (1.15) |
| t2 word frequency, 4,000,000 words | 67.5 | 72.0 (1.07) | 71.0 (1.05) | 91.0 (1.35) | 69.2 (1.02) | 172.8 (2.56) |
| t3 binary search tree, 800,000 keys | 176.9 | 195.0 (1.10) | 184.0 (1.04) | 186.0 (1.05) | 181.6 (1.03) | 253.7 (1.43) |
| t4 grouping, 8,000,000 pairs | 33.9 | 39.0 (1.15) | 41.0 (1.21) | 61.0 (1.80) | 38.9 (1.15) | 87.6 (2.58) |
| t5 event merge, 2 x 4,000,000 events | 67.7 | 62.0 (0.92) | 62.0 (0.92) | 112.0 (1.65) | 66.2 (0.98) | 71.1 (1.05) |

Allocation and boundary (`m`), pre-fix:

| Measurement | szigyr C | szigyr JS backend | Rust |
| --- | ---: | ---: | ---: |
| `alloc_small` (1,000,000) | 1576 ns | 933 ns | 7.8 ns |
| `push_grow` (20,000,000) | 4.7 ns | 7.1 ns | 0.91 ns |
| `call_scalar` (2,000,000) | 42 ns | 32 ns | n/a |
| `call_slice_small` (1,000,000) | 426 ns | 8 ns | n/a |
| `call_slice_large` (200) | below clock resolution | below clock resolution | n/a |

Pre-fix Wasm `alloc_small` quadratic scaling inside one strict call:

- 5,000: 77 ms
- 10,000: 275 ms
- 20,000: 1,003 ms
- 40,000: 3,934 ms


## Post-Stage-1 (`agy/native-alloc-stage1-20261125` / `D188`, 2026-11-25)

Measured via `pnpm bench:workloads` after Stage 1 (C native `Vec` chunked bump + `malloc`/`realloc`, non-idle machine, `load average: 15.96`, ratios in parentheses relative to `rust-same` in the same run):

| Task | checksum | szigyr C dev | szigyr C release | szigyr Wasm | rust-same | rust-idiom |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| t1 tokenizer (16,000,000 B) | 1282472460 | 86.0 ms (1.24x) | 86.0 ms (1.24x) | 134.0 ms (1.94x) | 69.2 ms | 79.8 ms (1.15x) |
| t2 word frequency (4,000,000 words) | 4274193343 | 81.0 ms (1.05x) | 83.0 ms (1.08x) | 101.0 ms (1.31x) | 77.2 ms | 193.7 ms (2.51x) |
| t3 binary search tree (800,000 keys) | 2574783783 | 184.0 ms (0.96x) | 180.0 ms (0.94x) | 213.0 ms (1.11x) | 192.1 ms | 476.9 ms (2.48x) |
| t4 grouping (8,000,000 pairs) | 2207450853 | 43.0 ms (1.09x) | 40.0 ms (1.01x) | 65.0 ms (1.65x) | 39.4 ms | 110.6 ms (2.80x) |
| t5 event merge (2 x 4,000,000 events) | 3321175533 | 64.0 ms (0.92x) | 65.0 ms (0.94x) | 112.0 ms (1.61x) | 69.5 ms | 72.5 ms (1.04x) |

Allocation and boundary (`m`), Stage 1:

| Measurement | n | szigyr C | szigyr Wasm | Rust |
| --- | ---: | ---: | ---: | ---: |
| `alloc_small` | 1,000,000 | 51.00 ns (51 ms) | 1,661.0 ns (1,661 ms) | 7.76 ns (7.756 ms) |
| `push_grow` | 20,000,000 | 1.05 ns (21 ms) | 8.45 ns (169 ms) | 1.01 ns (20.131 ms) |
| `call_scalar` | 2,000,000 | 43.00 ns (86 ms) | 245.0 ns (490 ms) | n/a |
| `call_slice_small` | 1,000,000 | 452.0 ns (452 ms) | 493.0 ns (493 ms) | 2.84 ns (2.838 ms) |
| `call_slice_large` | 200 | 0.00 ns (0 ms) | 3,095,000.0 ns (619 ms) | 3.71 ns (0.001 ms) |

Stage 1 Wasm `alloc_small` scaling: `10,000` `25 ms` (`1.00x`), `20,000` `51 ms` (`2.04x`), `40,000` `96 ms` (`3.84x`), `1,000,000` `1,661 ms` (`66.44x`).
