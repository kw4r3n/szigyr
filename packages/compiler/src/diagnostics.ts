export interface Position { line: number; col: number } // 1-based
export interface Range { start: Position; end: Position }
export interface Edit { range: Range; newText: string }
export interface Fix { title: string; edits: Edit[] }
export interface Diagnostic {
  code: string;
  severity: "error" | "warning";
  message: string;
  file: string;
  range: Range;
  data?: Record<string, unknown>;
  fixes?: Fix[];
}
export interface Trap { code: string; file: string; line: number; col: number; message?: string }
export interface RunResult { diagnostics: Diagnostic[]; stdout: string; stderr?: string; trap: Trap | null; exitCode?: number }

/** Deduplicates identical diagnostics across multiple entry files while preserving first-seen order. */
export function dedupeDiagnostics(ds: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of ds) {
    const k = `${d.file}\0${d.range.start.line}:${d.range.start.col}-${d.range.end.line}:${d.range.end.col}\0${d.severity}\0${d.code}\0${d.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out;
}
