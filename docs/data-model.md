# Local SQLite data model

The history database is created at the configured path (default .subtest/history.sqlite). Timestamps are UTC ISO 8601 text. Foreign keys and WAL mode are enabled. Schema migrations are embedded in the history package and applied transactionally when the CLI opens the database.

~~~sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  config_path TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  subtest_version TEXT NOT NULL,
  stripe_account_id TEXT,
  stripe_api_version TEXT,
  app_origin TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE scenario_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  scenario_key TEXT NOT NULL,
  name TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  UNIQUE(run_id, scenario_key)
);

CREATE TABLE stripe_resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_run_id TEXT NOT NULL REFERENCES scenario_runs(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,
  stripe_id TEXT NOT NULL,
  created_by_subtest INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE assertions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_run_id TEXT NOT NULL REFERENCES scenario_runs(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  assertion_key TEXT NOT NULL,
  expected_json TEXT NOT NULL,
  actual_json TEXT,
  evidence_source TEXT,
  status TEXT NOT NULL,
  message TEXT,
  checked_at TEXT NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_run_id TEXT NOT NULL REFERENCES scenario_runs(id) ON DELETE CASCADE,
  stripe_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  app_evidence_status TEXT,
  UNIQUE(scenario_run_id, stripe_event_id)
);

CREATE TABLE artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_run_id TEXT NOT NULL REFERENCES scenario_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  local_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE payment_diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_run_id TEXT NOT NULL REFERENCES scenario_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  explanation TEXT NOT NULL,
  next_step TEXT NOT NULL,
  confidence TEXT NOT NULL,
  source TEXT NOT NULL,
  code TEXT,
  decline_code TEXT,
  field TEXT,
  payment_intent_id TEXT,
  created_at TEXT NOT NULL
);
~~~

## Data rules

- config_hash is a SHA-256 hash of the parsed config. Secrets are not accepted in config fields.
- Expected and actual assertion values are serialized from the allowlisted assertion paths.
- Do not persist raw Stripe objects, secret key material, webhook bodies, cookies, or payment fields.
- created_by_subtest distinguishes clock/customer/subscription fixtures created by the runner from a customer discovered after an app-owned Checkout flow. It does not authorize remote deletion.
- `scenario_runs.status` may be `partial` when the Checkout Session contract was verified but payment-dependent assertions were skipped or optional browser automation was blocked. A partial run is distinct from a failed assertion.
- `payment_diagnostics` stores only normalized Stripe error/decline codes, a deterministic explanation, confidence, and a suggested next step. It never stores raw Stripe objects, card data, or unfiltered browser page text.
- Stripe event rows contain provider-generated event IDs and types. app_evidence_status is confirmed/not_confirmed only when the local evidence endpoint is configured; otherwise it is null.
- Screenshots and Playwright traces are not currently captured. The artifacts table is reserved for opt-in local artifacts in a later release.
- Pruning deletes local run rows and dependent evidence only. It never deletes Stripe resources.
