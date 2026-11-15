# SubTest implementation specification

**Status:** local MVP implementation and technical contract, version 0.1.0.  
**Product:** SubTest is a local-first, open-source runner for repeatable Stripe subscription QA.  
**Non-goal:** a hosted control plane, a universal test generator, or a replacement for application integration tests.

## 1. Goals and success criteria

A developer should be able to run a checked-in YAML scenario against an explicitly configured local or staging application, use a Stripe test account to create the required test objects, drive a configured Checkout journey in Chromium, advance a Stripe Test Clock where supported, inspect resulting Stripe state and webhook observations, and retain a useful local run record.

MVP success means:

1. `subtest validate` catches malformed config, missing environment variables, non-test credentials, unreachable app URLs, and impossible feature combinations before creating Stripe objects.
2. `subtest run` has deterministic setup, execution, cleanup policy, timeouts, useful logs, and nonzero exit status on a failed assertion.
3. The run history and dashboard explain each scenario's steps, assertions, event evidence, and failure without retaining secrets or card data.
4. The example shows the application responsibilities that remain application-specific: creating a Checkout Session, receiving/verifying webhooks, and exposing stable UI selectors.
5. All functionality runs locally. The tool makes no background uploads or telemetry calls.

### Explicit exclusions for v0

Hosted run coordination, billing for SubTest, teams and shared projects, Postgres, arbitrary cloud-browser matrices, a simulation of all Stripe billing states, arbitrary natural-language test generation, automatic source-code instrumentation, a general webhook tunnel, production/live mode, and guaranteed cleanup of every object created by a user application.

## 2. System architecture

```text
subtest CLI ── config/validation ── scenario engine ── Stripe adapter ── Stripe test API
      │                                  │                  │
      │                                  ├── Playwright ─── configured app/browser
      │                                  ├── webhook observer (local app endpoint/evidence)
      │                                  └── SQLite history
      └── local dashboard API ── React + Vite UI
```

The CLI is the orchestration entry point. The dashboard starts a loopback-only HTTP server and reads the same SQLite database; the dashboard cannot trigger a run in the first MVP. This avoids hidden mutations from a UI and keeps the runner usable in CI.

### Runtime boundaries

- `@subtest/core`: domain types, config parsing/validation, scenario state machine, assertions, redaction, structured result model. No Stripe or browser SDK dependency.
- `@subtest/stripe-adapter`: Stripe SDK calls, test-mode preflight, Test Clock operations, customer/product/price/subscription/invoice retrieval, event polling. Owns API version pin and retries.
- `@subtest/browser`: Playwright launch/context and configured steps. Stripe-hosted Checkout filling is best-effort and may be blocked by Stripe anti-automation controls; no universal automation guarantee.
- `@subtest/history`: SQLite connection, schema migrations, repositories, retention/pruning, transactional run persistence.
- `@subtest/dashboard`: React + Vite UI and static assets. Dashboard HTTP server/API belongs in CLI or a narrowly scoped `@subtest/dashboard-server` package if separation becomes valuable; keep MVP package count down.
- `@subtest/cli`: command parsing, dependency composition, lifecycle, output, exit codes, local dashboard API/server.
- `examples/nextjs-checkout`: minimal illustrative Next.js app and Stripe webhook example. It is not coupled into the runner.

Dependencies point inward: CLI composes adapters around core interfaces. Core must not import concrete adapters. Each adapter exposes a small interface so tests can replace Stripe, browser, and history implementations with fakes.

## 3. Commands and exit behavior

| Command | Behavior |
|---|---|
| `subtest init [--force]` | Writes a starter `subtest.yml`; refuses to overwrite without `--force`. |
| `subtest validate [--config path]` | Schema validation, configured app connectivity check, and read-only Stripe preflight. No resource creation. |
| `subtest run [--scenario id] [--config path] [--headed] [--browser-smoke] [--strict-browser] [--dry-run] [--json]` | Runs selected scenarios sequentially. Default Checkout mode verifies the app-created Session without entering payment details; `--browser-smoke` opts into hosted UI automation. `--strict-browser` makes a partial smoke result fail the process. |
| `subtest runs [--limit n]` | Lists local run history. |
| `subtest show <run-id>` | Prints a run with assertions, event summaries, timings, and redacted failure details. |
| `subtest dashboard [--host 127.0.0.1] [--port 4178]` | Starts loopback dashboard API and serves Vite assets; rejects non-loopback host by default. |
| `subtest clean [--older-than days]` | Prunes local history using the configured retention by default. Does not delete Stripe resources. |
| `subtest version` | Prints version/build metadata. |

Exit codes: `0` all required checks pass, including optional checks recorded as `partial`; `1` an assertion fails or `--strict-browser` is set for a partial result; `2` configuration/usage error; `3` Stripe credential/API preflight failure; `4` local infrastructure failure; `130` interrupted. Run output supports `--json`.

## 4. Configuration and scenario model

Config is YAML, versioned with a required `version: 1`; see [configuration.md](configuration.md) and [subtest.example.yml](../subtest.example.yml). Validate with Zod or TypeBox plus strict unknown-field rejection for config structure (except a deliberately supported `metadata` map). Expand environment placeholders only in values explicitly marked as env references or in secret fields; never shell-expand arbitrary strings. Prefer shell environment for `STRIPE_SECRET_KEY`.

Scenarios are sequential in v0 to avoid clock/customer cross-talk and Stripe rate contention. Every scenario has a stable `id`, human name, optional fixture declarations, browser journey, optional clock advancement, and assertions. Scenario execution builds a per-run context containing IDs of resources it created. Assertions query Stripe as source of truth, and may optionally query configured app health endpoints. A successful browser redirect alone does not prove subscription creation or correct webhook handling.

### Browser flow contract

The runner supports navigate, click, fill, wait for URL/text, assert URL/text, and a best-effort `stripeCheckout` helper. By default it runs app-owned steps, intercepts the Stripe redirect, captures the test Session ID, and verifies mode and line items through the Stripe API. `--browser-smoke` additionally opens hosted Checkout and attempts the configured payment steps. If that attempt fails after Session capture, SubTest retains the Stripe evidence, marks payment-dependent assertions skipped, and records `partial`. Prefer accessible roles and labels; CSS selectors are an explicit escape hatch. No arbitrary JavaScript execution in YAML.

The Checkout helper fills accessible card fields only when the hosted page exposes them to Playwright. Stripe documents protections that can prevent automated testing of Checkout and Payment Element; the helper can fail even with a valid test card. Treat hosted Checkout runs as optional smoke checks. A Session-contract pass verifies only that the app created the expected Session; it does not prove payment completion, subscription activation, or webhook handling. Test those separately with a lifecycle scenario and explicit application webhook evidence. Never use real payment instruments.

### Application contract

The app owns creation of Checkout Sessions and webhook processing. It must expose the configured route and use a test Stripe account/key matching SubTest's account. It should provide stable, accessible labels. For webhook-dependent assertions, the app should optionally expose a test-only health/evidence endpoint (e.g. last processed event IDs) protected to local/test use. SubTest can observe delivery only when the configured local receiver or evidence source is accessible; it cannot inspect internal application state by magic.

## 5. Scenario execution lifecycle

For each invocation:

1. Parse args; load YAML; validate against schema; resolve paths and environment references; redact values for logs.
2. Open/migrate local SQLite; insert `run` row in `starting` state and `scenario_run` rows as selected.
3. Preflight: require `STRIPE_SECRET_KEY` matching `sk_test_`; request Stripe account identity; verify test-mode indicator; check API connectivity and configured price IDs. Do not print key or full account object. Reject live key before any resource write. Warn when app URL is not loopback; require explicit `allowRemoteTestUrl: true` for remote test hosts.
4. Validate feature support: if clock requested, require a lifecycle scenario without generic browser Checkout, check account/API support and scenario object compatibility. If a clock cannot be used, fail before resource creation; no silent wall-clock fallback.
5. Create resources explicitly requested by fixture declarations (customer and, if configured, test clock); record IDs immediately. Do not create products/prices by default; require existing `priceId` or explicit fixture creation flag. Add run/scenario metadata to Stripe objects where supported (`subtest_run_id`, `subtest_scenario_id`); keep values non-sensitive.
6. Start app only when config explicitly provides a command; launch as a child process with bounded startup wait, process group cleanup, inherited minimal environment, and redacted output. MVP may instead require developer to start app separately; make this first release simpler unless needed by the example.
7. Create isolated Playwright context and run app-owned browser steps. In default mode intercept the redirect, capture the `cs_test_...` ID, and retrieve the Session from Stripe. With `--browser-smoke`, continue into the hosted UI and attempt payment entry.
8. Verify the Session's subscription mode and configured Price independently of payment form automation. If optional browser automation is blocked after Session capture, retain these checks, mark payment-dependent assertions skipped, and record a `partial` result. Once Stripe reports a completed Session, inspect its customer/subscription and configured app webhook evidence.
9. If configured, advance Test Clock by the scenario duration and await clock status `ready` with timeout. Poll expected invoices/subscription state and optionally application evidence after clock advancement. Clock advancement is asynchronous; don't assume a fixed delay means completion.
10. Evaluate assertions and persist per-assertion actual/expected/evidence. Mark scenario/run `passed`, `partial`, `failed`, or `error`. Optional browser smoke failures are partial by default; `--strict-browser` returns nonzero to gate CI. Store sanitized error code/message and timing.
11. Cleanup Playwright context, spawned app, and any temporary resources. Stripe resources remain by default to support debugging; mark them with metadata and show a cleanup command hint. Optional later policy may cancel subscriptions and delete only resources proven to be owned by the run. Never delete arbitrary or pre-existing Stripe data.
12. Close DB and return documented exit code. On SIGINT, stop launching new scenarios, mark active work interrupted, close browser/processes, persist partial history, and exit 130.

Use idempotency keys for Stripe create calls derived from run ID + operation key. Persist returned IDs before subsequent calls so a process restart doesn't blindly duplicate resources. A resumed-run feature is out of MVP.

## 6. Stripe safeguards and known limitations

- Accept only secret keys with the `sk_test_` prefix; reject `sk_live_`, restricted keys not clearly test-only, malformed values, and absent values. Do not permit an override for live credentials in v0.
- Confirm account and test mode using Stripe API response metadata where available. Prefix checks alone are not a sufficient future-proof safeguard.
- Pin a supported Stripe API version in adapter; display configured account and API version, not secrets.
- Use Stripe Test Clocks only for supported test-mode customers and supported Billing resources. API support and object compatibility can evolve; capability-check and link docs to the exact current Stripe constraints. Test Clock advancement is asynchronous, has limits on duration/frequency, and may cause webhook events that must be awaited by the app separately.
- Stripe test mode is not identical to live behavior. It does not guarantee card-network behavior, bank settlement, production risk decisions, live webhook latency, or every Billing edge case. Some asynchronous payment methods, proration situations, schedules, tax, entitlements, Connect, and custom pricing may require separate setup or may not be supported by the first release.
- Browser selectors and hosted Checkout pages can change. The runner should version its helper behavior, report unsupported layouts, and avoid promising arbitrary app compatibility.
- Stripe API rate limits and transient errors exist. Retry safe reads with bounded exponential backoff and jitter; create operations only with idempotency keys. Do not retry hard declines or invalid requests.
- Make no statement that SubTest fully verifies a user's webhook handler unless it receives explicit application-level evidence. Stripe API event existence is only provider-side evidence.

## 7. Webhook observation

Support three evidence channels, separately labeled:

1. **Stripe event evidence:** query/poll Stripe for events related to known objects. Establishes that Stripe generated an event, not that the user's receiver accepted it.
2. **Local forwarding evidence:** if the user configured a local Stripe CLI forwarder, observe the configured app's test-only event receipt endpoint/log integration. SubTest itself does not bind a public tunnel.
3. **Application evidence:** optional configured HTTP endpoint returns an allowlisted response (processed event IDs and statuses). The endpoint must be explicitly documented as test-only and should bind/authenticate locally. The runner validates response shape and records only event IDs/status.

The implementation includes Stripe event polling and an optional loopback application-evidence endpoint that returns processed event IDs. This distinguishes provider event generation from app processing. Do not silently start Stripe CLI, register remote webhook endpoints, or store signing secrets. The Next.js example demonstrates signature verification using the app's own webhook secret and raw request body. In local development the operator configures Stripe CLI forwarding and provides `whsec_...` to the example environment; never persist this value to history.

## 8. Local storage and migration policy

SQLite file defaults to `.subtest/history.sqlite` in project root and is ignored by Git. Enable foreign keys, WAL mode, busy timeout, and transactional migrations. Store UTC timestamps as ISO 8601 text. The v1 schema is applied transactionally and recorded in `schema_migrations`. See [data-model.md](data-model.md) for DDL.

Retention defaults to 30 days for history, configurable; pruning is explicit at startup or via `clean`, with a clear summary. Don't store raw card data, secret keys, full session cookies, full webhook bodies, or full Stripe objects. Store only object IDs, selected status fields, event type/ID, sanitized error details, config hash, and short config snapshot with secret refs removed. Screenshots/traces are local opt-in artifacts outside the DB and have a documented retention policy.

## 9. Dashboard and API

Dashboard server binds to `127.0.0.1` by default, serves same-origin assets and JSON under `/api/v1`, checks loopback Host and exact local Origin values, and sets security headers. It has no mutation endpoints. Non-loopback binding is rejected.

Initial routes:

- `GET /api/v1/health` → `{status, version}`.
- `GET /api/v1/runs?limit=&cursor=` → paginated run summary list.
- `GET /api/v1/runs/:runId` → run, scenario outcomes, assertion evidence, event summaries, artifact paths (local paths may be omitted in UI).
- The current UI reads `GET /api/v1/runs` and `GET /api/v1/runs/:runId`; health is exposed at `GET /api/v1/health`.

Types are defined in `packages/core/src/contracts.ts` and serialized with ISO timestamps. UI screens: run list/status/duration; run detail with scenario timeline, assertions and event evidence; config/preflight status. No user management or remote sync. Dashboard reads existing DB and cannot rerun or delete remote Stripe objects.

## 10. Error model and observability

Use stable error codes: `CONFIG_INVALID`, `STRIPE_KEY_NOT_TEST`, `STRIPE_PREFLIGHT_FAILED`, `STRIPE_RATE_LIMITED`, `STRIPE_RESOURCE_NOT_FOUND`, `CLOCK_UNSUPPORTED`, `CLOCK_TIMEOUT`, `APP_UNREACHABLE`, `BROWSER_STEP_FAILED`, `CHECKOUT_UNSUPPORTED`, `WEBHOOK_EVIDENCE_TIMEOUT`, `ASSERTION_FAILED`, `SQLITE_FAILURE`, `INTERRUPTED`, `INTERNAL_ERROR`. Include remediation, stage, scenario ID, retryable flag, and redacted cause. Never include request authorization headers, secret values, payment details, cookie values, or full query strings.

Structured log fields: timestamp, level, runId, scenarioId, stage, code, durationMs. Human output should show progress with one line per stage. `--verbose` adds sanitized provider request IDs and retry count. A `--json` result schema is stable and versioned.

## 11. Security and privacy

Threats include accidental live-mode calls, secret leakage into config/logs/history, a malicious project config executing local commands, dashboard cross-origin access, sensitive browser artifacts, and mistaken deletion of user Stripe data.

Controls: test-key-only preflight before writes; no arbitrary shell steps in YAML; optional app start command requires explicit opt-in and clear execution warning; all secret resolution via environment; redaction at logger boundary; local-only dashboard/token/origin checks; minimal stored data; no network telemetry; no automatic remote deletion; dependencies and lockfile reviewed; sanitize HTML/text in dashboard; no secrets rendered in UI. Document that running a config may launch a browser and can contact configured app URLs and Stripe test APIs.

## 12. Testing strategy (implementation work)

Test design, not an instruction to run tests in this specification task:

- Core unit tests: strict config parsing, defaults, env resolution, redaction, assertion evaluation, state-machine transitions, exit codes.
- Adapter contract tests with fake Stripe client: test-key rejection before writes, idempotency keys, retries only for safe operations, clock lifecycle/timeouts, object lookup and pagination.
- History tests using temp SQLite DB: migrations from empty/current schema, FK behavior, transaction rollback, retention, sanitized serialization.
- Browser tests against a local fixture app: role-based actions, timeout messages, unsupported Checkout page, trace/screenshot redaction policy. Keep most tests independent from Stripe network.
- End-to-end smoke test behind an opt-in CI secret using a dedicated Stripe test account and non-production app; don't run by default on forks or pull requests.
- Dashboard API contract and UI component tests; verify loopback and auth behavior.

Use deterministic fakes for clock progression and API responses. Tests that need Stripe must be opt-in, isolated, rate-aware, and clean only objects created by their own run.

## 13. CI and release

GitHub Actions on pull requests and main: checkout; setup Node 22; setup pnpm; frozen lockfile install; install Chromium; build workspace packages; run typechecks and unit tests. Do not expose Stripe secrets to PR workflows. A manually dispatched protected smoke workflow may use dedicated test credentials. Release workflow tags `v*`, builds CLI bundles/packages, attaches provenance/SBOM and changelog; publish npm only after package name and ownership are confirmed. Repository public identity and npm namespace remain project-owner decisions; this scaffold uses the neutral `@subtest/*` scope and `subtest` command.

Branch protections, CODEOWNERS, security reporting, contribution guide, and release process should be established before inviting external contributions.

## 14. Remaining release decisions

The local implementation is in place. Before publishing, choose the GitHub organization and repository owner, confirm the npm package scope, and configure repository branch protections and private vulnerability reporting. A public repository has not been created or published from this workspace.

## References

- [Stripe automated testing guidance](https://docs.stripe.com/automated-testing) describes protections that can prevent automation of Checkout and Payment Element.
- [Stripe Test Clocks](https://docs.stripe.com/billing/testing/test-clocks) documents supported lifecycle simulation and clock constraints.
- [Stripe Node SDK](https://github.com/stripe/stripe-node) documents SDK setup and its bundled API version behavior.
