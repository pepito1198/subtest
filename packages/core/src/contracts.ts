export type RunStatus = "starting" | "running" | "passed" | "partial" | "failed" | "error" | "interrupted";
export type ScenarioStatus = "pending" | "running" | "passed" | "partial" | "failed" | "error" | "interrupted";

export interface RunSummary {
  id: string;
  project: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  scenarioCount: number;
  passedCount: number;
  failedCount: number;
  errorCount: number;
}

export interface AssertionResult {
  key: string;
  status: "passed" | "failed" | "error";
  expected: unknown;
  actual?: unknown;
  evidenceSource?: "stripe" | "browser" | "application";
  evidenceRef?: string;
  message?: string;
  checkedAt: string;
}

export interface SafeError {
  code: string;
  message: string;
  stage: string;
  retryable: boolean;
  scenarioId?: string;
}

export function runExitCode(failed: number, partial: number, strictBrowser: boolean): 0 | 1 {
  return failed > 0 || (strictBrowser && partial > 0) ? 1 : 0;
}
