# SubTest

Open-source, local-first QA for Stripe subscriptions. By default, SubTest drives your app to Stripe Checkout, captures the test Checkout Session, and verifies its subscription mode and Price through Stripe's API without entering payment details. An optional browser smoke test attempts the hosted payment UI and reports partial evidence if that step is blocked.

> **Status:** local MVP implementation. The default Checkout contract check does not automate Stripe's payment form. `--browser-smoke` is an optional best-effort check because the hosted UI can block automation.

## MVP principles

- TypeScript, Node.js 22+, pnpm workspace monorepo; Apache-2.0 core.
- Stripe test mode only, with preflight checks and no live-key acceptance.
- Stripe Test Clocks for provider-level lifecycle scenarios; these cannot be combined with generic app Checkout because SubTest cannot attach an app-created customer to the clock automatically.
- Playwright runs a user-configured flow in Chromium. It does not infer application routes or guarantee automation of Stripe-hosted pages.
- Local SQLite stores run metadata and event summaries. It does not store card data, raw secrets, or full webhook payloads.
- React + Vite local dashboard. No hosted SaaS or telemetry.
- Payment failure diagnosis uses Stripe's structured error and decline codes where available. It distinguishes a confirmed code from an issuer decline with no specific reason; a browser automation block is never described as a payment rejection.
- The Next.js example demonstrates application responsibilities; it is not a universal plugin.

See [the implementation specification](docs/implementation-spec.md), [the YAML reference](docs/configuration.md), [the data model](docs/data-model.md), and [the roadmap](docs/roadmap.md).
The planned public/private boundary is described in [open-source boundary](docs/open-source-boundary.md).

## Quick start

~~~sh
pnpm install
pnpm build
pnpm --filter @subtest/browser exec playwright install chromium
pnpm subtest init
# Set STRIPE_SECRET_KEY to an sk_test_... key in your shell.
pnpm subtest validate
pnpm subtest run --scenario checkout-monthly
pnpm subtest run --browser-smoke --headed
pnpm subtest dashboard
~~~

The default `run` verifies that your app creates a test-mode subscription Checkout Session for the configured Price. It does not claim payment completion. `--browser-smoke` additionally tries the hosted payment form; if that UI step is blocked, or configured payment/webhook checks need a completed payment, SubTest retains the Session evidence and reports `partial`. Use `--strict-browser` when a blocked smoke test should fail CI.

Create a recurring Stripe test Price before validating. To run the browser example, start the included app in examples/nextjs-checkout and configure Stripe CLI forwarding to its webhook route. Set the app's STRIPE_PRICE_ID and Stripe test credentials in its ignored .env.local file.

For a subscription renewal scenario, SubTest creates a clock-backed customer and subscription directly through the Stripe test API, then advances the clock and checks the resulting state. These resources remain in Stripe test mode for debugging.

Never put secrets in subtest.yml or commit them. SubTest rejects live-mode keys before creating Stripe resources.

## License

Apache License 2.0. See [LICENSE](LICENSE).
