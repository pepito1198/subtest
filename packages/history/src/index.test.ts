import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryStore } from "./index.js";

const temporaryDirectories: string[] = [];
afterEach(() => temporaryDirectories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("HistoryStore", () => {
  it("persists run and scenario summaries in a local SQLite file", () => {
    const dir = mkdtempSync(join(tmpdir(), "subtest-history-"));
    temporaryDirectories.push(dir);
    const store = new HistoryStore(join(dir, "history.sqlite"));
    store.createRun({ id: "run-1", project: "demo", configPath: "/tmp/subtest.yml", configHash: "hash", startedAt: new Date().toISOString(), appOrigin: "http://localhost:3000", stripeAccountId: "acct_test", stripeApiVersion: "test" });
    store.createScenario({ id: "scenario-1", runId: "run-1", key: "monthly", name: "Monthly plan", ordinal: 0, startedAt: new Date().toISOString() });
    expect(store.listRuns()).toHaveLength(1);
    expect(store.getRun("run-1")).toMatchObject({ id: "run-1", scenarios: [{ scenario_key: "monthly" }] });
    store.close();
  });

  it("prunes old local runs without contacting Stripe", () => {
    const dir = mkdtempSync(join(tmpdir(), "subtest-history-"));
    temporaryDirectories.push(dir);
    const store = new HistoryStore(join(dir, "history.sqlite"));
    store.createRun({ id: "old-run", project: "demo", configPath: "/tmp/subtest.yml", configHash: "hash", startedAt: "2000-01-01T00:00:00.000Z", appOrigin: "http://localhost:3000", stripeAccountId: "acct_test", stripeApiVersion: "test" });
    expect(store.prune(30)).toBe(1);
    expect(store.listRuns()).toHaveLength(0);
    store.close();
  });
});
