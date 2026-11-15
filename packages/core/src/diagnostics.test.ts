import { describe, expect, it } from "vitest";
import { diagnosePaymentFailure } from "./diagnostics.js";

describe("payment failure diagnosis", () => {
  it("explains a specific Stripe decline code and preserves the evidence code", () => {
    expect(diagnosePaymentFailure({ errorCode: "card_declined", declineCode: "insufficient_funds", paymentIntentId: "pi_test_1" })).toMatchObject({
      kind: "decline",
      title: "Insufficient funds",
      declineCode: "insufficient_funds",
      confidence: "confirmed",
      paymentIntentId: "pi_test_1",
    });
  });

  it("does not invent a bank reason when Stripe only reports a generic decline", () => {
    expect(diagnosePaymentFailure({ errorCode: "card_declined", declineCode: "generic_decline" })).toMatchObject({
      title: "Generic issuer decline",
      confidence: "limited",
    });
  });

  it("separates required authentication from a decline", () => {
    expect(diagnosePaymentFailure({ paymentIntentStatus: "requires_action" })).toMatchObject({ kind: "authentication_required", code: "requires_action" });
  });

  it("never calls a blocked browser smoke a Stripe payment failure", () => {
    expect(diagnosePaymentFailure({ sessionStatus: "open", browserError: "Automation was blocked" })).toMatchObject({ kind: "browser_blocked", source: "browser" });
  });

  it("includes Stripe's safe message while masking an email and card number", () => {
    const explanation = diagnosePaymentFailure({ errorCode: "card_declined", errorMessage: "Payment declined for qa@example.com card 4242424242424242" })?.explanation;
    expect(explanation).toContain("[email]");
    expect(explanation).toContain("[number]");
    expect(explanation).not.toContain("qa@example.com");
    expect(explanation).not.toContain("4242424242424242");
  });

  it("returns no diagnosis when there is no failure evidence", () => {
    expect(diagnosePaymentFailure({ sessionStatus: "complete", paymentStatus: "paid", paymentIntentStatus: "succeeded" })).toBeUndefined();
  });
});
