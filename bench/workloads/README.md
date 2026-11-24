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
