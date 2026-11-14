import { NextResponse } from "next/server";
import { processedEventIds } from "../../../../lib/evidence";

export const runtime = "nodejs";

export async function GET() {
  if (process.env.NODE_ENV === "production" || !process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) {
    return NextResponse.json({ error: "Test evidence is available only in local Stripe test mode." }, { status: 404 });
  }
  return NextResponse.json({ processedEventIds: processedEventIds() }, {
    headers: { "Cache-Control": "no-store" },
  });
}
