import Stripe from "stripe";
import { NextResponse } from "next/server";
import { recordProcessedEvent } from "../../../../lib/evidence";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const key = process.env.STRIPE_SECRET_KEY;
  const signingSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = request.headers.get("stripe-signature");
  if (!key?.startsWith("sk_test_") || !signingSecret || !signature) {
    return NextResponse.json({ error: "Webhook is not configured for local test mode." }, { status: 400 });
  }
  const stripe = new Stripe(key);
  let event: Stripe.Event;
  try {
    const rawBody = await request.text();
    event = stripe.webhooks.constructEvent(rawBody, signature, signingSecret);
  } catch {
    return NextResponse.json({ error: "Invalid webhook signature." }, { status: 400 });
  }
  // Replace this demonstration response with your application's idempotent event handler.
  recordProcessedEvent(event.id);
  return NextResponse.json({ received: true, eventId: event.id, type: event.type });
}
