# Configuration reference

SubTest reads `subtest.yml` or `subtest.yaml` from the current directory. `subtest validate` should reject unknown keys so typos fail early. Keep credentials out of this file; set `STRIPE_SECRET_KEY` in the environment.

## Top-level fields

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `version` | `1` | yes | Config format version. |
| `project` | string | yes | Display name; not a secret. |
| `baseUrl` | URL | yes | App origin. Localhost recommended; remote test host requires explicit opt-in. |
| `stripe.clock.enabled` | boolean | no | Whether scenarios may create Test Clocks. Default false. |
| `stripe.clock.advanceTimeoutMs` | positive integer | no | Maximum wait for clock to become ready after advance. |
| `stripe.webhook.endpoint` | loopback URL | no | Optional application evidence endpoint returning processed event IDs; it is not a Stripe webhook destination. |
| `stripe.webhook.waitForEvents` | boolean | no | Whether to wait for provider events related to created objects. |
| `stripe.webhook.timeoutMs` | positive integer | no | Event/evidence polling deadline. |
| `browser.engine` | `chromium` | no | MVP browser engine. |
| `browser.headless` | boolean | no | Defaults true; CLI `--headed` overrides for a run. |
| `browser.actionTimeoutMs` | positive integer | no | Per-step timeout. |
| `browser.navigationTimeoutMs` | positive integer | no | Navigation timeout. |
| `history.database` | path | no | SQLite path, default `.subtest/history.sqlite`. |
| `history.retainDays` | positive integer | no | Local history retention policy. |
| `allowRemoteTestUrl` | boolean | no | Explicit acknowledgement that app URL is remote. Never permits live Stripe mode. |
| `scenarios` | array | yes | Ordered scenario definitions. |

## Scenario fields

Each scenario has unique `id`, `name`, optional `customer.email`, `product.priceId`, `checkout`, optional `clock`, and `assertions`. Existing Stripe `priceId` is preferred. Creating products/prices is intentionally not implicit.

`checkout.path` is resolved against `baseUrl`. `steps` use a constrained action grammar. Example:

```yaml
steps:
  - navigate: /pricing
  - click: { role: link, name: "Choose monthly" }
  - fill: { label: "Email", value: "${scenario.customer.email}" }
  - stripeCheckout: { paymentMethod: "4242424242424242" }
  - waitFor: { urlIncludes: "/success" }
```

Supported selectors should be role/name, label, placeholder, or text. Raw CSS is an explicitly discouraged escape hatch. No `eval`, arbitrary JavaScript, or shell command step is allowed.

Assertions use a finite, documented path vocabulary such as `subscription.status`, `subscription.interval`, `invoice.count`, `invoice.latest.status`, and `customer.email`. Unknown assertion paths are configuration errors. Expected values are typed. The runner records actual value and evidence source (Stripe API, browser, or application endpoint).

`clock.advanceBy` accepts a duration such as `32d` only when Test Clocks are enabled and the relevant objects support it. A clock scenario must not also define browser Checkout: the runner cannot attach a generic app-created customer to the clock. No silent fallback from a clock to waiting in real time.

The optional webhook endpoint is polled by SubTest and must return a JSON object with a processedEventIds array of Stripe event IDs. It is application evidence only; Stripe CLI forwarding and signature verification remain the application's responsibility. The sample app exposes this endpoint only in local test mode.

Checkout and Test Clock are separate scenario modes. Checkout scenarios use browser automation and identify the resulting Stripe customer by email. Clock scenarios create their own test customer and subscription directly through the Stripe test API, then advance the clock. Do not combine both modes in one scenario.

## Environment references

`STRIPE_SECRET_KEY` is read only from the process environment. Other secret values (for example the example app's webhook secret) are never copied into the SubTest config/history. `${...}` interpolation is limited to documented value fields and must resolve at runtime. Unknown or unset variables fail validation with the variable name but never its value.
