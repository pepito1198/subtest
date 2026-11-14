import { NextResponse } from "next/server";
import Stripe from "stripe";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const key = process.env.STRIPE_SECRET_KEY;
  const price = process.env.STRIPE_PRICE_ID;
  if (!key?.startsWith("sk_test_") || !price?.startsWith("price_")) {
    return NextResponse.json({ error: "Configure test-mode STRIPE_SECRET_KEY and STRIPE_PRICE_ID." }, { status: 500 });
  }
  const stripe = new Stripe(key);
  const origin = new URL(request.url).origin;
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    success_url: origin + "/success?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: origin + "/cancel",
    subscription_data: { metadata: { example: "subtest-nextjs" } },
  });
  return NextResponse.redirect(session.url!, 303);
}
