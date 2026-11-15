#!/usr/bin/env node
import { Command } from "commander";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { extname, resolve, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, isLocalUrl, redact, runExitCode, diagnosePaymentFailure, type PaymentDiagnosis, type Scenario, type SubtestConfig } from "@subtest/core";
import { StripeAdapter } from "@subtest/stripe-adapter";
import { runBrowserScenario, type BrowserScenarioResult } from "@subtest/browser";
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
    const appOrigin = new URL(config.baseUrl).origin;
    const appPaths = scenario.checkout ? [scenario.checkout.path, ...scenario.checkout.steps.flatMap((step) => "navigate" in step ? [step.navigate] : [])] : [];
    for (const path of appPaths) {
      const target = new URL(path, config.baseUrl);
      if (target.origin !== appOrigin || target.username || target.password) {
        throw new Error("SCENARIO_NAVIGATION_ORIGIN_NOT_ALLOWED: Browser navigation steps must stay on the configured application origin.");
      }
    }
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

async function appPreflight(config: SubtestConfig): Promise<number> {
  try {
    const response = await fetch(config.baseUrl, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5000) });
    const status = response.status;
    await response.body?.cancel();
    if (status >= 500) throw new Error("APP_UNREACHABLE: The application returned a server error during preflight.");
    return status;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("APP_UNREACHABLE:")) throw error;
    throw new Error("APP_UNREACHABLE: Could not reach the configured application before the preflight timeout.");
  }
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

function checkoutAssertionValue(state: Awaited<ReturnType<StripeAdapter["checkoutSessionState"]>>, key: string): unknown {
  if (key === "checkout.session.mode") return state.mode;
  if (key === "checkout.session.status") return state.status;
  if (key === "checkout.session.payment_status") return state.paymentStatus;
  if (key === "checkout.session.price") return state.priceIds;
  return undefined;
}

function hasSubscriptionAssertion(scenario: Scenario): boolean {
  return assertionsOf(scenario).some((item) => item.key.startsWith("subscription.") || item.key.startsWith("invoice."));
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
    try {
      const response = await fetch(endpoint, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))) });
      if (response.ok) {
        const payload: unknown = await response.json();
        if (payload && typeof payload === "object" && "processedEventIds" in payload && Array.isArray(payload.processedEventIds)) {
          processed = new Set(payload.processedEventIds.filter((value): value is string => typeof value === "string"));
          if (eventIds.every((id) => processed.has(id))) return processed;
        } else {
          throw new Error("WEBHOOK_EVIDENCE_INVALID: Endpoint must return { processedEventIds: string[] }.");
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("WEBHOOK_EVIDENCE_INVALID:")) throw error;
      if (Date.now() >= deadline) break;
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
    "        - stripeCheckout: { paymentMethod: \"4242424242424242\" }", "      expect:", "        urlIncludes: /success", "",
  ].join("\n");
  await writeFile(target, source, { flag: options.force ? "w" : "wx" });
  console.log("Created " + target + ". Set STRIPE_SECRET_KEY before validate.");
});

program.command("validate").description("Validate config and do a read-only Stripe preflight").option("-c, --config <path>", "config file", "subtest.yml").action(async (options) => {
  const { config } = await readConfig(options.config);
  const appStatus = await appPreflight(config);
  const { account } = await stripePreflight(config);
  console.log(JSON.stringify({ valid: true, project: config.project, appHttpStatus: appStatus, stripeAccountId: account.accountId, stripeApiVersion: account.apiVersion, mode: "test", scenarios: config.scenarios.length }, null, 2));
});

program.command("run").description("Run configured scenarios").option("-c, --config <path>", "config file", "subtest.yml").option("-s, --scenario <id>", "run one scenario").option("--headed", "show browser").option("--browser-smoke", "attempt automated entry on Stripe Checkout").option("--strict-browser", "exit nonzero if the optional browser smoke test is blocked").option("--dry-run", "show plan without resource writes").option("--json", "emit a machine-readable summary").action(async (options) => {
  const { config, path } = await readConfig(options.config);
  const selected = options.scenario ? config.scenarios.filter((item) => item.id === options.scenario) : config.scenarios;
  if (!selected.length) throw new Error("SCENARIO_NOT_FOUND: No scenario matches " + options.scenario);
  const { stripe, account } = await stripePreflight({ ...config, scenarios: selected });
  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, project: config.project, stripeAccountId: account.accountId, stripeApiVersion: account.apiVersion, browserSmoke: Boolean(options.browserSmoke || options.strictBrowser), scenarios: selected.map((s) => ({ id: s.id, kind: s.clock ? "test-clock-lifecycle" : "checkout-contract" })) }, null, 2));
    return;
  }
  await appPreflight(config);
  const history = new HistoryStore(config.history.database);
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const hash = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  history.createRun({ id: runId, project: config.project, configPath: path, configHash: hash, startedAt, appOrigin: new URL(config.baseUrl).origin, stripeAccountId: account.accountId, stripeApiVersion: account.apiVersion });
  let passed = 0;
  let partial = 0;
  let failed = 0;
  const diagnoses: Array<{ scenarioId: string; diagnosis: PaymentDiagnosis }> = [];
  try {
    for (const [ordinal, scenario] of selected.entries()) {
      const scenarioRunId = randomUUID();
      const began = Date.now();
      history.createScenario({ id: scenarioRunId, runId, key: scenario.id, name: scenario.name, ordinal, startedAt: new Date(began).toISOString() });
      try {
        await stripe.validatePrice(scenario.product.priceId);
        let customerId: string | undefined;
        let state: Awaited<ReturnType<StripeAdapter["subscriptionState"]>> | undefined;
        let browserResult: BrowserScenarioResult | undefined;
        let checkoutState: Awaited<ReturnType<StripeAdapter["checkoutSessionState"]>> | undefined;
        const evidenceStart = Math.floor(Date.now() / 1000);
        if (scenario.clock) {
          const clockId = await stripe.createClock("subtest-" + scenario.id + "-" + runId.slice(0, 8), runId + "-" + scenario.id + "-clock");
          history.resource(scenarioRunId, "test_clock", clockId, true);
          customerId = await stripe.createCustomer(scenario.customer!.email, runId + "-" + scenario.id + "-customer", clockId);
          history.resource(scenarioRunId, "customer", customerId, true);
          const subscriptionId = await stripe.createSubscription(customerId, scenario.product.priceId, runId + "-" + scenario.id + "-subscription");
          history.resource(scenarioRunId, "subscription", subscriptionId, true);
          await stripe.advanceClock(clockId, durationSeconds(scenario.clock.advanceBy), config.stripe.clock.advanceTimeoutMs);
          state = await stripe.subscriptionState(customerId, scenario.product.priceId);
        } else if (scenario.checkout) {
          browserResult = await runBrowserScenario(config, scenario, Boolean(options.headed), Boolean(options.browserSmoke || options.strictBrowser));
          history.resource(scenarioRunId, "checkout_session", browserResult.checkoutSessionId, false);
          checkoutState = await stripe.checkoutSessionState(browserResult.checkoutSessionId);
          const diagnosis = diagnosePaymentFailure({
            sessionStatus: checkoutState.status,
            paymentStatus: checkoutState.paymentStatus,
            ...(checkoutState.paymentIntent?.id ? { paymentIntentId: checkoutState.paymentIntent.id } : {}),
            ...(checkoutState.paymentIntent?.status ? { paymentIntentStatus: checkoutState.paymentIntent.status } : {}),
            ...(checkoutState.paymentIntent?.errorCode ? { errorCode: checkoutState.paymentIntent.errorCode } : {}),
            ...(checkoutState.paymentIntent?.declineCode ? { declineCode: checkoutState.paymentIntent.declineCode } : {}),
            ...(checkoutState.paymentIntent?.errorMessage ? { errorMessage: checkoutState.paymentIntent.errorMessage } : {}),
            ...(checkoutState.paymentIntent?.errorParam ? { errorParam: checkoutState.paymentIntent.errorParam } : {}),
            ...(browserResult.checkoutStatus === "blocked" ? { browserError: browserResult.warning ?? "Hosted Checkout automation was blocked." } : {}),
            ...(browserResult.visibleError ? { browserMessage: browserResult.visibleError } : {}),
          });
          if (diagnosis) {
            history.paymentDiagnosis(scenarioRunId, diagnosis);
            diagnoses.push({ scenarioId: scenario.id, diagnosis });
            if (!options.json) console.error("DIAGNOSIS " + scenario.id + " · " + diagnosis.title + " · " + diagnosis.explanation + " Next: " + diagnosis.nextStep);
          }
          if ((options.browserSmoke || options.strictBrowser) && browserResult.checkoutStatus === "completed" && checkoutState.status !== "complete") {
            browserResult.checkoutStatus = "blocked";
            browserResult.warning = "The browser flow ended, but Stripe still reports the Checkout Session as " + String(checkoutState.status) + ".";
          }
          customerId = checkoutState.customerId;
          if (!customerId && checkoutState.status === "complete" && scenario.customer) {
            const deadline = Date.now() + config.stripe.webhook.timeoutMs;
            while (Date.now() < deadline && !customerId) {
              customerId = await stripe.customerByEmail(scenario.customer.email, evidenceStart);
              if (!customerId) await new Promise((resolve) => setTimeout(resolve, 1500));
            }
          }
          if (checkoutState.subscriptionId) history.resource(scenarioRunId, "subscription", checkoutState.subscriptionId, false);
        }
        if (customerId && scenario.checkout) history.resource(scenarioRunId, "customer", customerId, false);
        const expectedSubscriptionId = scenario.checkout ? checkoutState?.subscriptionId : undefined;
        if (customerId && !state) state = await stripe.subscriptionState(customerId, scenario.product.priceId, expectedSubscriptionId);
        if (scenario.checkout && customerId && checkoutState?.status === "complete" && !state?.status) {
          const deadline = Date.now() + config.stripe.webhook.timeoutMs;
          while (Date.now() < deadline && !state?.status) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            state = await stripe.subscriptionState(customerId, scenario.product.priceId, expectedSubscriptionId);
          }
        }
        if (scenario.checkout && state?.subscriptionId) history.resource(scenarioRunId, "subscription", state.subscriptionId, false);
        let events: Array<{ id: string; type: string; created: number }> = [];
        if (customerId && (!scenario.checkout || checkoutState?.status === "complete")) {
          const shouldWaitForWebhook = config.stripe.webhook.waitForEvents || Boolean(config.stripe.webhook.endpoint);
          events = shouldWaitForWebhook
            ? await waitForStripeEvents(stripe, customerId, evidenceStart, config.stripe.webhook.timeoutMs)
            : await stripe.eventsForCustomer(customerId, evidenceStart);
          const processedEventIds = config.stripe.webhook.endpoint
            ? await waitForAppEvidence(config.stripe.webhook.endpoint, events.map((event) => event.id), config.stripe.webhook.timeoutMs)
            : undefined;
          history.addEvents(scenarioRunId, events, processedEventIds);
        }
        const checks = assertionsOf(scenario);
        let assertionOrdinal = 0;
        let assertionFailures = 0;
        let skippedAssertions = 0;
        if (browserResult?.checkoutStatus === "not_attempted") {
          history.assertion({ scenarioRunId, ordinal: assertionOrdinal++, key: "browser.smoke", expected: "opt-in", actual: null, status: "skipped", evidenceSource: "browser", message: "Hosted Checkout automation was not requested. The Session contract was checked through Stripe's API." });
        } else if (browserResult?.checkoutStatus === "blocked") {
          history.assertion({ scenarioRunId, ordinal: assertionOrdinal++, key: "browser.smoke", expected: "completed Checkout", actual: checkoutState?.status ?? null, status: "blocked", evidenceSource: "browser", message: browserResult.warning ?? "Hosted Checkout automation did not complete." });
        } else if (browserResult?.checkoutStatus === "completed") {
          history.assertion({ scenarioRunId, ordinal: assertionOrdinal++, key: "browser.smoke", expected: "completed Checkout", actual: checkoutState?.status ?? null, status: "passed", evidenceSource: "browser" });
        }
        if (scenario.checkout && checkoutState?.status !== "complete" && (config.stripe.webhook.endpoint || config.stripe.webhook.waitForEvents)) {
          skippedAssertions++;
          history.assertion({ scenarioRunId, ordinal: assertionOrdinal++, key: config.stripe.webhook.endpoint ? "webhook.application.events" : "webhook.stripe.events", expected: "events from a completed Checkout", actual: null, status: "skipped", evidenceSource: config.stripe.webhook.endpoint ? "application" : "stripe", message: "Webhook delivery is not evaluated until Checkout completes. Use a separate lifecycle scenario to test webhook processing without the hosted payment form." });
        }
        if (scenario.checkout && checkoutState) {
          const sessionChecks = [
            { key: "checkout.session.mode", expected: "subscription" },
            { key: "checkout.session.status", expected: ["open", "complete"] },
            { key: "checkout.session.price", expected: scenario.product.priceId },
          ];
          for (const check of sessionChecks) {
            if (checks.some((item) => item.key === check.key)) continue;
            const actual = checkoutAssertionValue(checkoutState, check.key);
            const ok = Array.isArray(check.expected) ? check.expected.includes(actual as string) : check.key === "checkout.session.price" && Array.isArray(actual) ? actual.includes(check.expected) : actual === check.expected;
            if (!ok) assertionFailures++;
            history.assertion({ scenarioRunId, ordinal: assertionOrdinal++, key: check.key, expected: check.expected, actual, status: ok ? "passed" : "failed", evidenceSource: "stripe", ...(ok ? {} : { message: "Checkout Session did not match the expected subscription configuration." }) });
          }
        }
        if (!checks.length && scenario.clock) checks.push({ key: "subscription.status", expected: "active" });
        if (checkoutState?.status === "complete" && !hasSubscriptionAssertion(scenario) && !checks.some((item) => item.key === "checkout.session.status")) {
          checks.push({ key: "subscription.status", expected: "active" });
        }
        for (const check of checks) {
          const isCheckoutCheck = check.key.startsWith("checkout.session.");
          const actual = isCheckoutCheck && checkoutState
            ? checkoutAssertionValue(checkoutState, check.key)
            : state && !isCheckoutCheck ? assertionValue(state, check.key) : undefined;
          const shouldSkip = !isCheckoutCheck && (!state?.status || (scenario.checkout && checkoutState?.status !== "complete"));
          if (shouldSkip) {
            skippedAssertions++;
            history.assertion({ scenarioRunId, ordinal: assertionOrdinal++, key: check.key, expected: check.expected, actual: null, status: "skipped", evidenceSource: "stripe", message: "Not evaluated because Checkout has not completed." });
            continue;
          }
          const ok = Array.isArray(check.expected) ? check.expected.includes(actual) : check.key === "checkout.session.price" && Array.isArray(actual) ? actual.includes(check.expected) : actual === check.expected;
          if (!ok) assertionFailures++;
          history.assertion({ scenarioRunId, ordinal: assertionOrdinal++, key: check.key, expected: check.expected, actual, status: ok ? "passed" : "failed", evidenceSource: isCheckoutCheck ? "stripe" : "stripe", ...(ok ? {} : { message: "Expected " + String(check.expected) + ", received " + String(actual) + "." }) });
        }
        if (assertionFailures) throw new Error("ASSERTION_FAILED: " + scenario.id + " did not satisfy " + assertionFailures + " Stripe assertion(s). See subtest show " + runId + ".");
        const isPartial = skippedAssertions > 0 || browserResult?.checkoutStatus === "blocked";
        if (isPartial) partial++;
        else passed++;
        const finalStatus = isPartial ? "partial" : "passed";
        const warning = browserResult?.warning;
        history.finishScenario({ id: scenarioRunId, status: finalStatus, finishedAt: new Date().toISOString(), durationMs: Date.now() - began, ...(isPartial ? { errorCode: browserResult?.checkoutStatus === "blocked" ? "BROWSER_SMOKE_BLOCKED" : "CHECKS_SKIPPED", errorMessage: warning ?? "Checkout was created and verified, but payment-dependent assertions were skipped." } : {}) });
        if (!options.json) {
          const resultSummary = scenario.checkout
            ? "Checkout Session " + checkoutState?.status + " · " + (browserResult?.checkoutStatus === "blocked" ? "browser smoke blocked; Stripe checks retained" : browserResult?.checkoutStatus === "not_attempted" ? "browser payment not attempted" : (state?.status ?? "no subscription"))
            : "subscription " + (state?.status ?? "not found") + " · " + (state?.invoices ?? 0) + " invoice(s) · " + events.length + " Stripe event(s)";
          console.log((isPartial ? "PARTIAL " : "PASS ") + scenario.id + " · " + resultSummary);
        }
      } catch (error) {
        failed++;
        const message = redact(error instanceof Error ? error.message : String(error));
        history.finishScenario({ id: scenarioRunId, status: "failed", finishedAt: new Date().toISOString(), durationMs: Date.now() - began, errorCode: message.split(":")[0] ?? "INTERNAL_ERROR", errorMessage: message.slice(0, 1000) });
        if (!options.json) console.error("FAIL " + scenario.id + " · " + message);
      }
    }
    const status = failed ? "failed" : partial ? "partial" : "passed";
    history.finishRun(runId, status);
    if (options.json) console.log(JSON.stringify({ schemaVersion: 1, runId, status, passed, partial, failed, diagnoses }, null, 2));
    else console.log(passed + " passed, " + partial + " partially verified, " + failed + " failed. Run ID: " + runId);
    process.exitCode = runExitCode(failed, partial, Boolean(options.strictBrowser));
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
  process.exitCode = message.startsWith("STRIPE_") ? 3 : message.startsWith("SQLITE_") || message.startsWith("APP_") ? 4 : 2;
});
