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
export interface RunResult { diagnostics: Diagnostic[]; stdout: string; trap: Trap | null; exitCode?: number }
