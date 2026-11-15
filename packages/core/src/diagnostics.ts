export interface PaymentFailureEvidence {
  sessionStatus?: string | null;
  paymentStatus?: string | null;
  paymentIntentId?: string;
  paymentIntentStatus?: string | null;
  errorCode?: string | null;
  declineCode?: string | null;
  errorMessage?: string | null;
  errorParam?: string | null;
  browserError?: string | null;
  browserMessage?: string | null;
}

export type PaymentDiagnosis = {
  kind: "decline" | "authentication_required" | "payment_method_required" | "checkout_expired" | "browser_blocked" | "unknown";
  title: string;
  explanation: string;
  nextStep: string;
  confidence: "confirmed" | "limited" | "unknown";
  source: "stripe" | "browser";
  code?: string;
  declineCode?: string;
  field?: string;
  paymentIntentId?: string;
};

const declineReasons: Record<string, Omit<PaymentDiagnosis, "kind" | "source" | "code" | "declineCode" | "field" | "paymentIntentId">> = {
  insufficient_funds: { title: "Insufficient funds", explanation: "Stripe received an issuer decline indicating insufficient funds or credit.", nextStep: "Use a test payment method that succeeds, or verify how your app handles a declined payment.", confidence: "confirmed" },
  expired_card: { title: "Expired card", explanation: "Stripe's decline code indicates that the card has expired.", nextStep: "Check the message shown to the customer and confirm they can update their payment method.", confidence: "confirmed" },
  incorrect_number: { title: "Invalid card number", explanation: "Stripe reported that the card number is invalid.", nextStep: "Check that your app fills and validates the card number field correctly.", confidence: "confirmed" },
  incorrect_cvc: { title: "Incorrect CVC", explanation: "Stripe reported an incorrect card security code.", nextStep: "Check the CVC field and the validation message shown by your app.", confidence: "confirmed" },
  incorrect_zip: { title: "Incorrect postal code", explanation: "The issuer rejected the postal code associated with the payment.", nextStep: "Check the postal code field and your address validation rules.", confidence: "confirmed" },
  authentication_required: { title: "Authentication required", explanation: "The payment requires a customer authentication step, such as 3D Secure.", nextStep: "Complete authentication in the browser and verify that your app handles the return from Stripe.", confidence: "confirmed" },
  do_not_honor: { title: "Issuer decline", explanation: "The bank declined the payment but did not provide Stripe with a more specific reason.", nextStep: "Try another payment method. The cardholder must contact their bank for the precise reason.", confidence: "limited" },
  generic_decline: { title: "Generic issuer decline", explanation: "The payment was declined, but Stripe did not receive a more specific reason from the issuer.", nextStep: "Check your app's failure flow and try another payment method. The bank might have more detail.", confidence: "limited" },
  processing_error: { title: "Temporary processing error", explanation: "The payment could not be processed because of a temporary payment-processing error.", nextStep: "Verify safe retry behavior and rerun the test; do not automatically retry a hard decline.", confidence: "confirmed" },
  card_not_supported: { title: "Card not supported", explanation: "This card or payment method is not supported for the transaction.", nextStep: "Check the payment methods enabled for Checkout and try a supported method.", confidence: "confirmed" },
  fraudulent: { title: "Payment flagged as suspicious", explanation: "Stripe or the issuer classified the attempt as suspicious; the decision details are not exposed.", nextStep: "Do not try to bypass the check. Use a documented test scenario and verify decline handling in your app.", confidence: "limited" },
  lost_card: { title: "Card reported lost", explanation: "The issuer reported this card as lost.", nextStep: "Do not retry this card. Verify that your app offers another payment method.", confidence: "confirmed" },
  stolen_card: { title: "Card reported stolen", explanation: "The issuer reported this card as stolen.", nextStep: "Do not retry this card. Verify that your app offers another payment method.", confidence: "confirmed" },
  transaction_not_allowed: { title: "Transaction not allowed", explanation: "The issuer does not allow this transaction for the card or account.", nextStep: "Check the payment-method configuration and verify the app communicates the decline clearly.", confidence: "confirmed" },
  try_again_later: { title: "Issuer asked to retry later", explanation: "The issuer declined this attempt but indicated that a later retry might succeed.", nextStep: "Follow Stripe's retry guidance and avoid repeatedly retrying in a tight loop.", confidence: "confirmed" },
};

function safeMessage(value: string): string {
  return value.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b\d{12,19}\b/g, "[number]")
    .replace(/\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+\b/g, "[Stripe key]")
    .replace(/\s+/g, " ").trim().slice(0, 300);
}

export function diagnosePaymentFailure(evidence: PaymentFailureEvidence): PaymentDiagnosis | undefined {
  const common = evidence.paymentIntentId ? { paymentIntentId: evidence.paymentIntentId } : {};
  if (evidence.errorCode || evidence.declineCode) {
    const declineCode = evidence.declineCode ?? undefined;
    const mapped = declineCode ? declineReasons[declineCode] : undefined;
    const message = evidence.errorMessage ? safeMessage(evidence.errorMessage) : undefined;
    const fallback = evidence.errorCode === "card_declined"
      ? { title: "Card declined", explanation: message ? `Stripe reports: ${message}` : "Stripe recorded a card decline, but no more specific issuer code is available.", nextStep: "Check the message returned by Checkout and use an appropriate Stripe test-card scenario.", confidence: "limited" as const }
      : { title: "Payment error", explanation: message ? `Stripe reports: ${message}` : "Stripe recorded an error during the payment attempt.", nextStep: "Check the Stripe error code and payment-method configuration. Do not automatically retry a hard decline.", confidence: "limited" as const };
    return { kind: "decline", ...(mapped ?? fallback), source: "stripe", ...(evidence.errorCode ? { code: evidence.errorCode } : {}), ...(declineCode ? { declineCode } : {}), ...(evidence.errorParam ? { field: evidence.errorParam } : {}), ...common };
  }
  if (evidence.paymentIntentStatus === "requires_action") return { kind: "authentication_required", title: "Authentication required", explanation: "The PaymentIntent is waiting for customer action; this is not a final decline.", nextStep: "Complete authentication in the browser and check the redirect back to your app.", confidence: "confirmed", source: "stripe", code: "requires_action", ...common };
  if (evidence.paymentIntentStatus === "requires_payment_method") return { kind: "payment_method_required", title: "A valid payment method is required", explanation: "Stripe has no confirmed payment method for this PaymentIntent. Without a more specific error, the cause cannot be determined.", nextStep: "Inspect the latest attempt in Stripe and check how your app handles payment errors.", confidence: "limited", source: "stripe", code: "requires_payment_method", ...common };
  if (evidence.sessionStatus === "expired") return { kind: "checkout_expired", title: "Checkout session expired", explanation: "The Checkout Session expired before completion. This alone does not indicate a payment decline.", nextStep: "Restart the flow and check whether the customer abandoned Checkout or the app waited too long.", confidence: "confirmed", source: "stripe", code: "checkout_session_expired", ...common };
  if (evidence.browserMessage) return { kind: "browser_blocked", title: "Checkout displayed an error", explanation: "Message displayed by Stripe Checkout: " + safeMessage(evidence.browserMessage), nextStep: "Compare this message with the PaymentIntent error code in Stripe. The displayed text might describe the symptom without revealing the issuer's reason.", confidence: "limited", source: "browser", ...common };
  if (evidence.browserError) return { kind: "browser_blocked", title: "Browser test interrupted", explanation: "Automation could not complete the browser step. This does not prove Stripe declined the payment.", nextStep: "Review the browser error and retry; hosted Checkout can restrict automation.", confidence: "confirmed", source: "browser", ...common };
  if (evidence.paymentIntentStatus === "processing" || evidence.paymentIntentStatus === "succeeded" || evidence.paymentStatus === "paid" || evidence.paymentStatus === "no_payment_required") return undefined;
  if (evidence.sessionStatus === "open") return { kind: "unknown", title: "Checkout not completed", explanation: "The Session is still open and no payment error is recorded. The customer might have abandoned Checkout, or the test might have stopped before payment.", nextStep: "Complete the flow or rerun the test; do not classify this Session as a card decline.", confidence: "unknown", source: "stripe", ...common };
  return undefined;
}
