# What SubTest publishes

## First public release

Publish the complete locally useful product under Apache-2.0: the core, Stripe adapter, browser runner, CLI, SQLite history, local dashboard, Next.js example, tests, documentation, and CI workflow. Keep the basic Stripe error-code diagnosis in this free edition so users can understand a failure without an account or network service.

Do not add default telemetry. Measure adoption with public or voluntary signals such as release downloads, repeat CI use when users share it, GitHub issues, and opt-in feedback. Do not collect Stripe error details, app URLs, configs, or test results without an explicit opt-in.

## Keep out of the public repository

- Real Stripe, GitHub, or signing credentials; local `.env` files; customer data; production test logs; browser profiles; and private keys.
- A future paid cloud control plane: user and team accounts, report ingestion/storage, entitlements, subscription billing, notifications, and hosted retention.

The cloud service should live in a separate private repository and must not contain copied Apache-licensed code unless its license obligations are followed. The public repository should not have a hidden feature gate or a nonfunctional “Pro” stub.

## Future paid boundary

Keep local test execution, local dashboard/history, CI exit codes, and basic deterministic Stripe error explanations free. A paid service can add team-shared history across CI machines, run comparisons, shareable reports, alerts, and guided diagnosis that correlates Stripe codes with browser, webhook, and prior-run evidence. That paid layer is a product hypothesis; build it after the public MVP shows repeated use.
