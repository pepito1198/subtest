# Next.js Checkout example

This is a minimal test target for SubTest, not a SubTest-managed app. It creates a subscription-mode Checkout Session, redirects to Stripe Checkout, and verifies webhook signatures from the raw request body. The webhook route intentionally does not implement business processing; replace its demonstration response with an idempotent handler.

## Run locally

1. Create a recurring test-mode Price in Stripe and copy its ID.
2. Copy .env.local.example to .env.local; set STRIPE_SECRET_KEY=sk_test_..., STRIPE_PRICE_ID=price_..., and the forwarding secret below.
3. Start the app with pnpm dev.
4. In another terminal, forward Stripe test webhooks to http://localhost:3000/api/stripe/webhook with Stripe CLI and use the emitted whsec_... value as STRIPE_WEBHOOK_SECRET.
5. From the repository root, run pnpm subtest init and adapt the generated scenario to the included accessible “Choose monthly” link.

The browser Checkout flow is best-effort. Stripe documents anti-automation protections for Checkout and Payment Element, so a browser action may fail when Stripe changes or blocks its hosted UI. SubTest reports the failed step; it does not claim reliable automation of every Checkout form.

Never commit .env.local. SubTest run history does not store Stripe secrets or webhook bodies.
