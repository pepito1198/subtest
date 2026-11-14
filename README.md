# SubTest

Open-source, local-first QA for Stripe subscriptions. SubTest coordinates Stripe test-mode resources, configured browser journeys, webhook observations, and a local run history so teams can repeat subscription lifecycle checks against their own application.

> **Status:** local MVP implementation. Browser Checkout automation is best-effort because Stripe's hosted UI can block automation. Review the documented limits before using it in CI.

## MVP principles

- TypeScript, Node.js 22+, pnpm workspace monorepo; Apache-2.0 core.
- Stripe test mode only, with preflight checks and no live-key acceptance.
- Stripe Test Clocks for provider-level lifecycle scenarios; these cannot be combined with generic app Checkout because SubTest cannot attach an app-created customer to the clock automatically.
- Playwright runs a user-configured flow in Chromium. It does not infer application routes or guarantee automation of Stripe-hosted pages.
- Local SQLite stores run metadata and event summaries. It does not store card data, raw secrets, or full webhook payloads.
- React + Vite local dashboard. No hosted SaaS or telemetry.
- The Next.js example demonstrates application responsibilities; it is not a universal plugin.

See [the implementation specification](docs/implementation-spec.md), [the YAML reference](docs/configuration.md), [the data model](docs/data-model.md), and [the roadmap](docs/roadmap.md).

## Quick start

~~~sh
pnpm install
pnpm build
pnpm exec playwright install chromium
pnpm subtest init
# Set STRIPE_SECRET_KEY to an sk_test_... key in your shell.
pnpm subtest validate
pnpm subtest run --scenario checkout-monthly
pnpm subtest dashboard
~~~

Create a recurring Stripe test Price before validating. To run the browser example, start the included app in examples/nextjs-checkout and configure Stripe CLI forwarding to its webhook route. Set the app's STRIPE_PRICE_ID and Stripe test credentials in its ignored .env.local file.

For a subscription renewal scenario, SubTest creates a clock-backed customer and subscription directly through the Stripe test API, then advances the clock and checks the resulting state. These resources remain in Stripe test mode for debugging.

Never put secrets in subtest.yml or commit them. SubTest rejects live-mode keys before creating Stripe resources.

## License

Apache License 2.0. See [LICENSE](LICENSE).
