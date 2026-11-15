import { describe, expect, it } from "vitest";
import { ConfigSchema, isLocalUrl, redact } from "./config.js";
import { runExitCode } from "./contracts.js";

const base = {
  version: 1,
  project: "sample",
  baseUrl: "http://localhost:3000",
  scenarios: [{
    id: "checkout",
    name: "Monthly checkout",
    customer: { email: "test@example.invalid" },
    product: { priceId: "price_test_monthly" },
    checkout: { path: "/pricing", steps: [] },
    assertions: [{ "subscription.status": "active" }],
  }],
};

describe("config", () => {
  it("accepts a minimal supported scenario and applies safe defaults", () => {
    const result = ConfigSchema.parse(base);
    expect(result.browser.headless).toBe(true);
    expect(result.history.database).toBe(".subtest/history.sqlite");
  });

  it("rejects unknown keys instead of silently ignoring typos", () => {
    expect(ConfigSchema.safeParse({ ...base, basUrl: "http://localhost" }).success).toBe(false);
  });

  it("rejects duplicate scenario IDs before a run can reach Stripe", () => {
    const duplicate = { ...base.scenarios[0]!, name: "A second scenario with the same id" };
    expect(ConfigSchema.safeParse({ ...base, scenarios: [...base.scenarios, duplicate] }).success).toBe(false);
  });

  it("rejects arbitrary payment card values in the Checkout helper", () => {
    const input: unknown = {
      ...base,
      scenarios: [{
        ...base.scenarios[0],
        checkout: { path: "/pricing", steps: [{ stripeCheckout: { paymentMethod: "4111111111111111" } }] },
      }],
    };
    expect(ConfigSchema.safeParse(input).success).toBe(false);
  });

  it("identifies loopback targets and redacts credential patterns", () => {
    expect(isLocalUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isLocalUrl("https://example.com")).toBe(false);
    expect(redact("key sk_test_abc and secret whsec_xyz")).toContain("[REDACTED_STRIPE_KEY]");
    expect(redact("key sk_test_abc and secret whsec_xyz")).toContain("[REDACTED_WEBHOOK_SECRET]");
  });

  it("keeps optional partial runs green unless strict browser mode is enabled", () => {
    expect(runExitCode(0, 1, false)).toBe(0);
    expect(runExitCode(0, 1, true)).toBe(1);
    expect(runExitCode(1, 0, false)).toBe(1);
  });
});
