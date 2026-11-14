# Implementation roadmap

## Milestone 0 — repository foundation

Create the public repository after the owner chooses GitHub organization/name; commit Apache-2.0 license, contribution/security docs, pnpm workspace, TypeScript config, CI, package conventions, and versioning. Confirm Node support floor, Stripe API/SDK version, and SQLite driver. Outcome: clean public scaffold and reproducible build.

## Milestone 1 — config and safe CLI

Implement command shell, YAML schema, `init`, `validate`, redaction, JSON output contracts, local URL policy, `sk_test_` enforcement and Stripe account preflight. Add core fakes and docs. No resource writes until preflight is complete. Outcome: users can validate real config safely.

## Milestone 2 — Stripe fixtures and history

Implement Stripe adapter with idempotent customer creation, existing-price validation, subscription/session lookup, event polling, optional Test Clock lifecycle, timeouts, SQLite migrations and run recording. Add cleanup guidance but retain remote resources by default. Outcome: repeatable provider-side lifecycle setup with evidence.

## Milestone 3 — Playwright checkout journey

Implement browser lifecycle, minimal role/label action grammar, explicit hosted Checkout helper for documented test flows, timeout diagnostics and failure artifacts with redaction. Provide fixture app and demonstrate local Stripe CLI forwarding separately. Outcome: end-to-end checkout against the sample app.

## Milestone 4 — assertions and dashboard

Add typed assertions against Stripe state and configured app evidence; local dashboard API and React/Vite UI for runs and details; bind/auth/origin controls. Outcome: readable local audit trail.

## Milestone 5 — release hardening

Document compatibility matrix and limitations; run opt-in test-account smoke; verify packaging on supported OSes; security review of secrets/artifacts/dashboard; changelog, provenance and release automation. Outcome: v0.1 public release with known support boundaries.

## MVP acceptance checklist

- A live key is rejected before any Stripe write.
- Invalid config and unsupported clock requests stop before resource creation.
- Idempotency protects create calls from transient retries.
- Browser flow failure records a useful sanitized error and partial run.
- Subscription/invoice assertions are based on Stripe API retrieval, not just a success URL.
- Webhook evidence clearly distinguishes provider event generation from app processing.
- Dashboard binds to loopback by default and exposes no secrets.
- Local DB and artifacts are ignored; no telemetry is emitted.
- Public docs identify the sample app as a contract example and explain app-specific setup.
