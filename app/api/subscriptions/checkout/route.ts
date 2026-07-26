import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const PRICE_ENV: Record<string, string> = {
  signals: "STRIPE_PRICE_SIGNALS",
  pro: "STRIPE_PRICE_PRO",
  premium: "STRIPE_PRICE_PREMIUM",
};

export async function POST(request: NextRequest) {
  try {
    const stripeSecret = process.env.STRIPE_SECRET_KEY;
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? request.nextUrl.origin;
    if (!stripeSecret) {
      return NextResponse.json({ error: "Stripe is not configured yet." }, { status: 503 });
    }

    const body = await request.json().catch(() => ({}));
    const plan = String(body.plan ?? "");
    const email = String(body.email ?? "").trim().toLowerCase();
    const priceEnv = PRICE_ENV[plan];
    const priceId = priceEnv ? process.env[priceEnv] : undefined;

    if (!priceEnv || !priceId) {
      return NextResponse.json({ error: "Unknown or unavailable plan." }, { status: 400 });
    }
    if (!email || !email.includes("@")) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }

    const params = new URLSearchParams();
    params.set("mode", "subscription");
    params.set("success_url", `${siteUrl}/subscribe/success?session_id={CHECKOUT_SESSION_ID}`);
    params.set("cancel_url", `${siteUrl}/subscribe?canceled=1`);
    params.set("customer_email", email);
    params.set("line_items[0][price]", priceId);
    params.set("line_items[0][quantity]", "1");
    params.set("allow_promotion_codes", "true");
    params.set("subscription_data[metadata][plan_id]", plan);
    params.set("metadata[plan_id]", plan);
    params.set("metadata[email]", email);

    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeSecret}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
      cache: "no-store",
    });

    const session = await response.json();
    if (!response.ok || !session.url) {
      console.error("Stripe checkout creation failed", session);
      return NextResponse.json({ error: "Could not start checkout." }, { status: 502 });
    }

    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error("Subscription checkout error", error);
    return NextResponse.json({ error: "Could not start checkout." }, { status: 500 });
  }
}
