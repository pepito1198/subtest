#!/usr/bin/env node
import { Command } from "commander";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { extname, resolve, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, isLocalUrl, redact, type Scenario, type SubtestConfig } from "@subtest/core";
import { StripeAdapter } from "@subtest/stripe-adapter";
import { runBrowserScenario } from "@subtest/browser";
import { HistoryStore } from "@subtest/history";

const program = new Command();
program.name("subtest").description("Local-first Stripe subscription QA").version("0.1.0");

function secretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_KEY_MISSING: Set STRIPE_SECRET_KEY to an sk_test_... key in your shell.");
  if (!key.startsWith("sk_test_")) throw new Error("STRIPE_KEY_NOT_TEST: SubTest accepts only Stripe test secret keys (sk_test_...).");
  return key;
}

function checkTarget(config: SubtestConfig) {
  if (!isLocalUrl(config.baseUrl) && !config.allowRemoteTestUrl) {
    throw new Error("REMOTE_APP_NOT_ALLOWED: Set allowRemoteTestUrl: true only for a staging/test URL you control.");
  }
  if (config.stripe.webhook.endpoint && !isLocalUrl(config.stripe.webhook.endpoint)) {
    throw new Error("WEBHOOK_EVIDENCE_MUST_BE_LOCAL: The app evidence endpoint must use localhost or 127.0.0.1.");
  }
  for (const scenario of config.scenarios) {
    if (scenario.clock && scenario.checkout) throw new Error("SCENARIO_INVALID: A Test Clock lifecycle scenario cannot also use generic browser Checkout; the app-created customer cannot be attached to the clock generically.");
    if (scenario.clock && !config.stripe.clock.enabled) throw new Error("CLOCK_DISABLED: Enable stripe.clock.enabled.");
    if (scenario.clock && !scenario.customer) throw new Error("CUSTOMER_EMAIL_REQUIRED: A clock scenario needs customer.email.");
    if (scenario.checkout && !scenario.customer) throw new Error("CUSTOMER_EMAIL_REQUIRED: A Checkout scenario needs customer.email so SubTest can find the resulting Stripe subscription.");
  }
}

async function readConfig(file: string) {
  const { config, path } = await loadConfig(file);
  checkTarget(config);
  return { config, path };
}

function durationSeconds(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) throw new Error("Invalid duration: " + value);
  const factor: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return Number(match[1]) * factor[match[2]!]!;
}

async function stripePreflight(config: SubtestConfig) {
  const stripe = new StripeAdapter(secretKey());
  const account = await stripe.preflight();
  for (const scenario of config.scenarios) await stripe.validatePrice(scenario.product.priceId);
  return { stripe, account };
}

function assertionValue(state: Awaited<ReturnType<StripeAdapter["subscriptionState"]>>, key: string): unknown {
  if (key === "subscription.status") return state.status;
  if (key === "subscription.interval") return state.interval;
  if (key === "invoice.count") return state.invoices;
  if (key === "invoice.latest.status") return state.latestInvoiceStatus;
  return undefined;
}

function assertionsOf(scenario: Scenario): Array<{ key: string; expected: unknown }> {
  return scenario.assertions.map((entry) => {
    const pair = Object.entries(entry)[0]!;
    return { key: pair[0], expected: pair[1] };
  });
}

async function waitForStripeEvents(stripe: StripeAdapter, customerId: string, since: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let events = await stripe.eventsForCustomer(customerId, since);
  while (!events.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    events = await stripe.eventsForCustomer(customerId, since);
  }
  if (!events.length) throw new Error("WEBHOOK_PROVIDER_EVENT_TIMEOUT: Stripe did not expose a related event before the deadline.");
  return events;
}

async function waitForAppEvidence(endpoint: string, eventIds: string[], timeoutMs: number): Promise<Set<string>> {
  const deadline = Date.now() + timeoutMs;
  let processed = new Set<string>();
  while (Date.now() < deadline) {
    const response = await fetch(endpoint, { headers: { accept: "application/json" } });
    if (response.ok) {
      const payload: unknown = await response.json();
      if (payload && typeof payload === "object" && "processedEventIds" in payload && Array.isArray(payload.processedEventIds)) {
        processed = new Set(payload.processedEventIds.filter((value): value is string => typeof value === "string"));
        if (eventIds.every((id) => processed.has(id))) return processed;
      } else {
        throw new Error("WEBHOOK_EVIDENCE_INVALID: Endpoint must return { processedEventIds: string[] }.");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("WEBHOOK_EVIDENCE_TIMEOUT: The application did not report all expected Stripe event IDs.");
}

program.command("init").description("Create a starter subtest.yml").option("--force", "overwrite an existing config").action(async (options) => {
  const target = resolve("subtest.yml");
  const source = [
    "version: 1", "project: my-app", "baseUrl: http://localhost:3000", "stripe:", "  clock:", "    enabled: false",
    "browser:", "  engine: chromium", "  headless: true", "history:", "  database: .subtest/history.sqlite", "scenarios:",
    "  - id: checkout-monthly", "    name: Checkout creates a subscription", "    customer:", "      email: subtest+checkout@example.invalid",
    "    product:", "      priceId: price_replace_with_test_price_id", "    checkout:", "      path: /", "      steps:",
    "        - click: { role: link, name: Choose monthly }",
    "        - fill: { label: Email, value: \"${scenario.customer.email}\" }",
    "        - stripeCheckout: { paymentMethod: 4242424242424242 }", "      expect:", "        urlIncludes: /success",
    "    assertions:", "      - subscription.status: active", "",
  ].join("\n");
  await writeFile(target, source, { flag: options.force ? "w" : "wx" });
  console.log("Created " + target + ". Set STRIPE_SECRET_KEY before validate.");
});

program.command("validate").description("Validate config and do a read-only Stripe preflight").option("-c, --config <path>", "config file", "subtest.yml").action(async (options) => {
  const { config } = await readConfig(options.config);
  const { account } = await stripePreflight(config);
  console.log(JSON.stringify({ valid: true, project: config.project, stripeAccountId: account.accountId, stripeApiVersion: account.apiVersion, mode: "test", scenarios: config.scenarios.length }, null, 2));
});

program.command("run").description("Run configured scenarios").option("-c, --config <path>", "config file", "subtest.yml").option("-s, --scenario <id>", "run one scenario").option("--headed", "show browser").option("--dry-run", "show plan without resource writes").action(async (options) => {
  const { config, path } = await readConfig(options.config);
  const selected = options.scenario ? config.scenarios.filter((item) => item.id === options.scenario) : config.scenarios;
  if (!selected.length) throw new Error("SCENARIO_NOT_FOUND: No scenario matches " + options.scenario);
  const { stripe, account } = await stripePreflight({ ...config, scenarios: selected });
  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, project: config.project, stripeAccountId: account.accountId, stripeApiVersion: account.apiVersion, scenarios: selected.map((s) => ({ id: s.id, kind: s.clock ? "test-clock-lifecycle" : "browser-checkout" })) }, null, 2));
    return;
  }
  const history = new HistoryStore(config.history.database);
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const hash = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  history.createRun({ id: runId, project: config.project, configPath: path, configHash: hash, startedAt, appOrigin: new URL(config.baseUrl).origin, stripeAccountId: account.accountId, stripeApiVersion: account.apiVersion });
  let passed = 0;
  let failed = 0;
  try {
    for (const [ordinal, scenario] of selected.entries()) {
      const scenarioRunId = randomUUID();
      const began = Date.now();
      history.createScenario({ id: scenarioRunId, runId, key: scenario.id, name: scenario.name, ordinal, startedAt: new Date(began).toISOString() });
      try {
        await stripe.validatePrice(scenario.product.priceId);
        let customerId: string | undefined;
        const evidenceStart = Math.floor(Date.now() / 1000);
        if (scenario.clock) {
          const clockId = await stripe.createClock("subtest-" + scenario.id + "-" + runId.slice(0, 8), runId + "-" + scenario.id + "-clock");
          history.resource(scenarioRunId, "test_clock", clockId, true);
          customerId = await stripe.createCustomer(scenario.customer!.email, runId + "-" + scenario.id + "-customer", clockId);
          history.resource(scenarioRunId, "customer", customerId, true);
          const subscriptionId = await stripe.createSubscription(customerId, scenario.product.priceId, runId + "-" + scenario.id + "-subscription");
          history.resource(scenarioRunId, "subscription", subscriptionId, true);
          await stripe.advanceClock(clockId, durationSeconds(scenario.clock.advanceBy), config.stripe.clock.advanceTimeoutMs);
        } else if (scenario.checkout) {
          await runBrowserScenario(config, scenario, Boolean(options.headed));
          if (scenario.customer) {
            const deadline = Date.now() + config.stripe.webhook.timeoutMs;
            while (Date.now() < deadline && !customerId) {
              customerId = await stripe.customerByEmail(scenario.customer.email, evidenceStart);
              if (!customerId) await new Promise((resolve) => setTimeout(resolve, 1500));
            }
          }
        }
        if (!customerId) throw new Error("STRIPE_CUSTOMER_NOT_FOUND: Could not find a test customer; set customer.email to the email used in Checkout.");
        if (scenario.checkout) history.resource(scenarioRunId, "customer", customerId, false);
        let state = await stripe.subscriptionState(customerId, scenario.product.priceId);
        if (scenario.checkout && !state.status) {
          const deadline = Date.now() + config.stripe.webhook.timeoutMs;
          while (Date.now() < deadline && !state.status) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            state = await stripe.subscriptionState(customerId, scenario.product.priceId);
          }
        }
        if (scenario.checkout && state.subscriptionId) history.resource(scenarioRunId, "subscription", state.subscriptionId, false);
        const shouldWaitForWebhook = config.stripe.webhook.waitForEvents || Boolean(config.stripe.webhook.endpoint);
        const events = shouldWaitForWebhook
          ? await waitForStripeEvents(stripe, customerId, evidenceStart, config.stripe.webhook.timeoutMs)
          : await stripe.eventsForCustomer(customerId, evidenceStart);
        const processedEventIds = config.stripe.webhook.endpoint
          ? await waitForAppEvidence(config.stripe.webhook.endpoint, events.map((event) => event.id), config.stripe.webhook.timeoutMs)
          : undefined;
        history.addEvents(scenarioRunId, events, processedEventIds);
        const checks = assertionsOf(scenario);
        if (!checks.length) checks.push({ key: "subscription.status", expected: "active" });
        let scenarioPassed = Boolean(state.status);
        for (const [index, check] of checks.entries()) {
          const actual = assertionValue(state, check.key);
          const ok = actual === check.expected;
          scenarioPassed = scenarioPassed && ok;
          history.assertion({ scenarioRunId, ordinal: index, key: check.key, expected: check.expected, actual, status: ok ? "passed" : "failed", evidenceSource: "stripe", ...(ok ? {} : { message: "Expected " + String(check.expected) + ", received " + String(actual) + "." }) });
        }
        if (!scenarioPassed) throw new Error("ASSERTION_FAILED: " + scenario.id + " did not satisfy the configured Stripe assertions. See subtest show " + runId + ".");
        passed++;
        history.finishScenario({ id: scenarioRunId, status: "passed", finishedAt: new Date().toISOString(), durationMs: Date.now() - began });
        if (!program.opts().json) console.log("PASS " + scenario.id + " · " + state.status + " · " + state.invoices + " invoice(s) · " + events.length + " Stripe event(s)");
      } catch (error) {
        failed++;
        const message = redact(error instanceof Error ? error.message : String(error));
        history.finishScenario({ id: scenarioRunId, status: "failed", finishedAt: new Date().toISOString(), durationMs: Date.now() - began, errorCode: message.split(":")[0] ?? "INTERNAL_ERROR", errorMessage: message.slice(0, 1000) });
        if (!program.opts().json) console.error("FAIL " + scenario.id + " · " + message);
      }
    }
    history.finishRun(runId, failed ? "failed" : "passed");
    if (program.opts().json) console.log(JSON.stringify({ schemaVersion: 1, runId, status: failed ? "failed" : "passed", passed, failed }, null, 2));
    else console.log(passed + " passed, " + failed + " failed. Run ID: " + runId);
    if (failed) process.exitCode = 1;
  } finally {
    history.close();
  }
});

program.command("runs").description("List local run history").option("-c, --config <path>", "config file", "subtest.yml").option("--limit <n>", "maximum rows", "25").action(async (options) => {
  const { config } = await loadConfig(options.config);
  const store = new HistoryStore(config.history.database);
  console.log(JSON.stringify(store.listRuns(Number(options.limit)), null, 2));
  store.close();
});

program.command("show <run-id>").description("Show one saved run").option("-c, --config <path>", "config file", "subtest.yml").action(async (runId, options) => {
  const { config } = await loadConfig(options.config);
  const store = new HistoryStore(config.history.database);
  const run = store.getRun(runId);
  store.close();
  if (!run) throw new Error("RUN_NOT_FOUND: " + runId);
  console.log(JSON.stringify(run, null, 2));
});

program.command("clean").description("Prune local history").option("-c, --config <path>", "config file", "subtest.yml").option("--older-than <days>", "retention override").action(async (options) => {
  const { config } = await loadConfig(options.config);
  const store = new HistoryStore(config.history.database);
  const count = store.prune(Number(options.olderThan ?? config.history.retainDays));
  store.close();
  console.log("Removed " + count + " local run(s). Stripe objects were not changed.");
});

program.command("dashboard").description("Serve the read-only local dashboard").option("--host <host>", "bind host", "127.0.0.1").option("--port <port>", "port", "4178").option("-c, --config <path>", "config file", "subtest.yml").action(async (options) => {
  const host = options.host;
  const port = Number(options.port);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host)) throw new Error("DASHBOARD_HOST_UNSAFE: Bind only to loopback.");
  const { config } = await loadConfig(options.config);
  const store = new HistoryStore(config.history.database);
  const staticRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../dashboard/dist");
  const server = createServer(async (req, res) => {
    try {
      const authority = req.headers.host ?? "";
      const hostname = authority.startsWith("[") ? authority.slice(1, authority.indexOf("]")) : authority.split(":")[0] ?? "";
      if (!new Set(["127.0.0.1", "localhost", "::1"]).has(hostname)) { res.writeHead(403).end("Forbidden"); return; }
      const allowedOrigins = new Set(["http://127.0.0.1:" + port, "http://localhost:" + port, "http://[::1]:" + port]);
      if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) { res.writeHead(403).end("Origin denied"); return; }
      const url = new URL(req.url ?? "/", "http://localhost");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'");
      if (req.method !== "GET") { res.writeHead(405).end("Method not allowed"); return; }
      if (url.pathname === "/api/v1/health") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ status: "ok", version: "0.1.0" })); return; }
      if (url.pathname === "/api/v1/runs") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(store.listRuns(Number(url.searchParams.get("limit") ?? 25)))); return; }
      const match = /^\/api\/v1\/runs\/([0-9a-f-]+)$/.exec(url.pathname);
      if (match) {
        const run = store.getRun(match[1]!);
        if (!run) { res.writeHead(404).end("Not found"); return; }
        res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(run)); return;
      }
      const filePath = url.pathname === "/" ? join(staticRoot, "index.html") : resolve(staticRoot, "." + decodeURIComponent(url.pathname));
      if (filePath !== staticRoot && !filePath.startsWith(staticRoot + sep)) { res.writeHead(403).end("Forbidden"); return; }
      let data: Buffer;
      try { data = await readFile(filePath); } catch { data = await readFile(join(staticRoot, "index.html")); }
      const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
      res.setHeader("Content-Type", types[extname(filePath)] ?? "application/octet-stream");
      res.end(data);
    } catch (error) { res.writeHead(500).end(redact(error instanceof Error ? error.message : "Internal error")); }
  });
  server.listen(port, host, () => console.log("Dashboard running at http://" + host + ":" + port + " (Ctrl+C to stop)"));
  const close = () => server.close(() => { store.close(); process.exit(0); });
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
});

program.command("version").description("Show SubTest version").action(() => console.log("SubTest 0.1.0"));
program.parseAsync(process.argv).catch((error: unknown) => {
  const message = redact(error instanceof Error ? error.message : String(error));
  console.error(message);
  process.exitCode = message.startsWith("STRIPE_") ? 3 : message.startsWith("SQLITE_") ? 4 : 2;
});
