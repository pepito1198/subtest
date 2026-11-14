import { describe, expect, it } from "vitest";
import { StripeAdapter } from "./index.js";

describe("StripeAdapter test-mode gate", () => {
  it("rejects live keys before constructing a client", () => {
    expect(() => new StripeAdapter("sk_live_not-a-real-key")).toThrow(/STRIPE_KEY_NOT_TEST/);
  });

  it("rejects publishable keys", () => {
    expect(() => new StripeAdapter("pk_test_not-a-secret-key")).toThrow(/STRIPE_KEY_NOT_TEST/);
  });
});
