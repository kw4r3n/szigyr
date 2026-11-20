# Conformance cases

One case = `name.ts`, or a directory `name/` whose entry is `name/main.ts` (other files in it are imports).
Put it in `accept/`, `reject/` or `run/`. The header lives in the entry file, from line 1, with no blank lines:

1. Expectation (by directory):
   - accept: `// expect: ok` (zero diagnostics)
   - reject: `// expect: E3001 @ 12:9` (the first diagnostic, i.e. the head of all diagnostics sorted by (line, col, code), has this code and `range.start`;
     line and column are 1-based, line 1 is the header line itself; the position must be the first character of a token)
   - run: one or more consecutive `// expect-output: <text>` lines (stdout lines, in order, exact; one space after the colon is dropped),
     or `// expect-no-output`; optionally followed by `// expect-trap: T001 @ 8:14`
     (trap code and position; stdout up to the trap is still compared). Run also requires zero diagnostics.
     No trap line means no trap is allowed. A case with only `expect-trap` (no output lines) does not compare stdout.
2. `// stage: N` directly after: the ROADMAP stage that must pass this case (required).
   `STS_STAGE=N` runs only cases with stage <= N.
3. Optional `// backend: c` directly after the `// stage: N` line (SPEC §14.7): the case is
   C-only. A run case then runs on the C backend alone; on the JS backend it must execute
   nothing and stop with E4009. If a pkg-config package named by the case's `c:` specifiers
   is unavailable in this environment, the case is skipped (and counted in the output),
   never failed. A reject case for E4009 is verified through `run` (which reports it before
   executing), since `check` never reports E4009.
4. Optional `// open-question: Q012` lines (ignored by the harness).

Messages are never compared. Commands: `pnpm conformance` (run), `pnpm verify:conformance` (static checks). A versioned pre-push hook runs `pnpm typecheck && pnpm test`: enable it with `git config core.hooksPath scripts/hooks` (skip once with `git push --no-verify`); it does not run the conformance suite.
