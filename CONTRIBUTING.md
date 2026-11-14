# Contributing

Contributions should preserve the local-first, test-mode-only scope. Before opening a pull request, describe the user-visible behavior and update docs/config schemas when interfaces change. Add focused unit or contract coverage for new behavior. Never include Stripe credentials, webhook signing secrets, customer data, or browser artifacts in commits.

The project uses TypeScript, pnpm workspaces, strict TypeScript settings, and Apache-2.0 licensing. Changes that affect persisted data require a forward migration and a migration test. New Stripe write operations require a test-mode guard and idempotency strategy. New dashboard endpoints must retain loopback/auth/origin protections.
