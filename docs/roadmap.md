# Status and release checklist

## Implemented in the local MVP

- TypeScript and pnpm workspace with core, Stripe adapter, browser, CLI, SQLite history, and dashboard packages.
- Strict YAML configuration, duplicate-scenario detection, test-key preflight, app reachability check, and same-origin browser navigation guard.
- Checkout contract mode that captures a `cs_test_...` Session and verifies its mode, status, and configured Price through Stripe's API without submitting payment details.
- Optional hosted Checkout browser smoke mode. A blocked attempt preserves completed Stripe checks and reports a partial result; `--strict-browser` can make that result fail CI.
- Test Clock subscription lifecycle scenario, application webhook evidence, local run history, read-only dashboard, and Next.js example.
- GitHub Actions workflow that installs Chromium, builds the workspace, typechecks packages, and runs unit and browser contract tests.

## Before calling the first public release complete

1. Run the full GitHub Actions workflow on the public repository and resolve any platform-specific failures.
2. Run an opt-in smoke against a dedicated Stripe test account and the sample Next.js app. Verify session creation, payment completion, subscription assertions, and webhook evidence.
3. Exercise the optional hosted Checkout browser smoke in the intended CI environment. Keep it non-blocking unless it proves stable for that environment.
4. Review the Stripe SDK/API version, supported Checkout forms, Test Clock boundaries, security policy contact, and repository release metadata.
5. Publish a tagged release only after the supported behavior and limitations are documented.

## Explicitly out of scope

Hosted SaaS, live-mode Stripe calls, production payment data, universal app discovery, guaranteed automation of Stripe's hosted payment UI, automatic deletion of Stripe objects, and full parity with every Stripe API feature.
