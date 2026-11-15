import Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import type { PaymentDiagnosis } from "@subtest/core";

export type RunStatus = "starting" | "running" | "passed" | "partial" | "failed" | "error" | "interrupted";

const schema = [
  "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, project TEXT NOT NULL, config_path TEXT NOT NULL, config_hash TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, subtest_version TEXT NOT NULL, stripe_account_id TEXT, stripe_api_version TEXT, app_origin TEXT, summary_json TEXT NOT NULL DEFAULT '{}');",
  "CREATE TABLE IF NOT EXISTS scenario_runs (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, scenario_key TEXT NOT NULL, name TEXT NOT NULL, ordinal INTEGER NOT NULL, status TEXT NOT NULL, started_at TEXT, finished_at TEXT, duration_ms INTEGER, error_code TEXT, error_message TEXT, UNIQUE(run_id, scenario_key));",
  "CREATE TABLE IF NOT EXISTS assertions (id INTEGER PRIMARY KEY AUTOINCREMENT, scenario_run_id TEXT NOT NULL REFERENCES scenario_runs(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, assertion_key TEXT NOT NULL, expected_json TEXT NOT NULL, actual_json TEXT, evidence_source TEXT, status TEXT NOT NULL, message TEXT, checked_at TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS stripe_resources (id INTEGER PRIMARY KEY AUTOINCREMENT, scenario_run_id TEXT NOT NULL REFERENCES scenario_runs(id) ON DELETE CASCADE, resource_type TEXT NOT NULL, stripe_id TEXT NOT NULL, created_by_subtest INTEGER NOT NULL, created_at TEXT NOT NULL, status TEXT, metadata_json TEXT NOT NULL DEFAULT '{}');",
  "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, scenario_run_id TEXT NOT NULL REFERENCES scenario_runs(id) ON DELETE CASCADE, stripe_event_id TEXT NOT NULL, event_type TEXT NOT NULL, created_at TEXT NOT NULL, app_evidence_status TEXT, UNIQUE(scenario_run_id, stripe_event_id));",
  "CREATE TABLE IF NOT EXISTS artifacts (id INTEGER PRIMARY KEY AUTOINCREMENT, scenario_run_id TEXT NOT NULL REFERENCES scenario_runs(id) ON DELETE CASCADE, kind TEXT NOT NULL, local_path TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT);",
  "CREATE TABLE IF NOT EXISTS payment_diagnostics (id INTEGER PRIMARY KEY AUTOINCREMENT, scenario_run_id TEXT NOT NULL REFERENCES scenario_runs(id) ON DELETE CASCADE, kind TEXT NOT NULL, title TEXT NOT NULL, explanation TEXT NOT NULL, next_step TEXT NOT NULL, confidence TEXT NOT NULL, source TEXT NOT NULL, code TEXT, decline_code TEXT, field TEXT, payment_intent_id TEXT, created_at TEXT NOT NULL);",
  "CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at DESC);",
  "CREATE INDEX IF NOT EXISTS idx_scenarios_run ON scenario_runs(run_id, ordinal);",
  "CREATE INDEX IF NOT EXISTS idx_resources_scenario ON stripe_resources(scenario_run_id);",
  "CREATE INDEX IF NOT EXISTS idx_assertions_scenario ON assertions(scenario_run_id, ordinal);",
  "CREATE INDEX IF NOT EXISTS idx_events_scenario ON events(scenario_run_id, created_at);",
].join("\n");

export class HistoryStore {
  readonly db: Database.Database;
  constructor(path: string) {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });
    this.db = new Database(absolute);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }
  private migrate() {
    const apply = this.db.transaction(() => {
      this.db.exec(schema);
      this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES(1,?,?)")
        .run("initial", new Date().toISOString());
      this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES(2,?,?)")
        .run("payment_diagnostics", new Date().toISOString());
    });
    apply();
  }
  createRun(input: { id: string; project: string; configPath: string; configHash: string; startedAt: string; appOrigin: string; stripeAccountId: string; stripeApiVersion: string }) {
    this.db.prepare("INSERT INTO runs(id,project,config_path,config_hash,status,started_at,subtest_version,app_origin,stripe_account_id,stripe_api_version) VALUES(@id,@project,@configPath,@configHash,'running',@startedAt,'0.1.0',@appOrigin,@stripeAccountId,@stripeApiVersion)").run(input);
  }
  createScenario(input: { id: string; runId: string; key: string; name: string; ordinal: number; startedAt: string }) {
    this.db.prepare("INSERT INTO scenario_runs(id,run_id,scenario_key,name,ordinal,status,started_at) VALUES(@id,@runId,@key,@name,@ordinal,'running',@startedAt)").run(input);
  }
  finishScenario(input: { id: string; status: string; finishedAt: string; durationMs: number; errorCode?: string; errorMessage?: string }) {
    this.db.prepare("UPDATE scenario_runs SET status=@status,finished_at=@finishedAt,duration_ms=@durationMs,error_code=@errorCode,error_message=@errorMessage WHERE id=@id").run(input);
  }
  resource(scenarioRunId: string, type: string, stripeId: string, createdBySubtest: boolean) {
    this.db.prepare("INSERT INTO stripe_resources(scenario_run_id,resource_type,stripe_id,created_by_subtest,created_at) VALUES(?,?,?,?,?)")
      .run(scenarioRunId, type, stripeId, createdBySubtest ? 1 : 0, new Date().toISOString());
  }
  assertion(input: { scenarioRunId: string; ordinal: number; key: string; expected: unknown; actual: unknown; status: string; message?: string; evidenceSource: string }) {
    this.db.prepare("INSERT INTO assertions(scenario_run_id,ordinal,assertion_key,expected_json,actual_json,evidence_source,status,message,checked_at) VALUES(@scenarioRunId,@ordinal,@key,@expected,@actual,@evidenceSource,@status,@message,@checkedAt)")
      .run({ ...input, expected: JSON.stringify(input.expected), actual: JSON.stringify(input.actual), checkedAt: new Date().toISOString() });
  }
  paymentDiagnosis(scenarioRunId: string, diagnosis: PaymentDiagnosis) {
    this.db.prepare("INSERT INTO payment_diagnostics(scenario_run_id,kind,title,explanation,next_step,confidence,source,code,decline_code,field,payment_intent_id,created_at) VALUES(@scenarioRunId,@kind,@title,@explanation,@nextStep,@confidence,@source,@code,@declineCode,@field,@paymentIntentId,@createdAt)")
      .run({ scenarioRunId, ...diagnosis, nextStep: diagnosis.nextStep, code: diagnosis.code ?? null, declineCode: diagnosis.declineCode ?? null, field: diagnosis.field ?? null, paymentIntentId: diagnosis.paymentIntentId ?? null, createdAt: new Date().toISOString() });
  }
  addEvents(scenarioRunId: string, events: Array<{ id: string; type: string; created: number }>, processedEventIds?: Set<string>) {
    const insert = this.db.prepare("INSERT OR IGNORE INTO events(scenario_run_id,stripe_event_id,event_type,created_at,app_evidence_status) VALUES(?,?,?,?,?)");
    const tx = this.db.transaction(() => events.forEach((event) => insert.run(
      scenarioRunId, event.id, event.type, new Date(event.created * 1000).toISOString(),
      processedEventIds ? (processedEventIds.has(event.id) ? "confirmed" : "not_confirmed") : null,
    )));
    tx();
  }
  finishRun(id: string, status: RunStatus, finishedAt = new Date().toISOString()) {
    this.db.prepare("UPDATE runs SET status=?,finished_at=? WHERE id=?").run(status, finishedAt, id);
  }
  listRuns(limit = 25): unknown[] {
    return this.db.prepare("SELECT r.*, COUNT(s.id) AS scenario_count, SUM(CASE WHEN s.status='passed' THEN 1 ELSE 0 END) AS passed_count, SUM(CASE WHEN s.status='partial' THEN 1 ELSE 0 END) AS partial_count, SUM(CASE WHEN s.status IN ('failed','error') THEN 1 ELSE 0 END) AS failed_count FROM runs r LEFT JOIN scenario_runs s ON s.run_id=r.id GROUP BY r.id ORDER BY r.started_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(limit, 100)));
  }
  getRun(id: string): unknown {
    const run = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!run) return undefined;
    const scenarios = this.db.prepare("SELECT * FROM scenario_runs WHERE run_id=? ORDER BY ordinal").all(id) as Array<Record<string, unknown>>;
    return { ...run, scenarios: scenarios.map((scenario) => ({
      ...scenario,
      assertions: this.db.prepare("SELECT * FROM assertions WHERE scenario_run_id=? ORDER BY ordinal").all(scenario.id),
      stripeResources: this.db.prepare("SELECT * FROM stripe_resources WHERE scenario_run_id=? ORDER BY id").all(scenario.id),
      events: this.db.prepare("SELECT * FROM events WHERE scenario_run_id=? ORDER BY created_at").all(scenario.id),
      paymentDiagnostics: this.db.prepare("SELECT * FROM payment_diagnostics WHERE scenario_run_id=? ORDER BY created_at").all(scenario.id),
      artifacts: this.db.prepare("SELECT * FROM artifacts WHERE scenario_run_id=? ORDER BY created_at").all(scenario.id),
    })) };
  }
  prune(days: number): number {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    return this.db.prepare("DELETE FROM runs WHERE started_at < ?").run(cutoff).changes;
  }
  close() { this.db.close(); }
}
