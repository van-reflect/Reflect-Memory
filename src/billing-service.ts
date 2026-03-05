// Reflect Memory — Billing Service
// Stripe integration for subscription management and checkout.

import Stripe from "stripe";
import type Database from "better-sqlite3";

let _stripe: Stripe | null = null;

function getStripe(): Stripe | null {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  _stripe = new Stripe(key, { apiVersion: "2025-01-27.acacia" as Stripe.LatestApiVersion });
  return _stripe;
}

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export interface PlanLimits {
  maxWritesPerMonth: number;
  maxReadsPerMonth: number;
}

// Launch plans: Free + Builder only.
// Pro ($99, 150k writes / 750k reads) and Teams/Enterprise (TBD) added post-Public Beta.
export const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: { maxWritesPerMonth: 1_000, maxReadsPerMonth: 10_000 },
  builder: { maxWritesPerMonth: 50_000, maxReadsPerMonth: 125_000 },
};

export async function createCheckoutSession(
  db: Database.Database,
  userId: string,
  plan: "builder",
  successUrl: string,
  cancelUrl: string,
): Promise<string | null> {
  const stripe = getStripe();
  if (!stripe) return null;

  const priceId = process.env.STRIPE_PRICE_BUILDER;
  if (!priceId) return null;

  const user = db
    .prepare(`SELECT id, email, stripe_customer_id FROM users WHERE id = ?`)
    .get(userId) as { id: string; email: string; stripe_customer_id: string | null } | undefined;

  if (!user) return null;

  let customerId = user.stripe_customer_id;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { reflect_user_id: userId },
    });
    customerId = customer.id;
    db.prepare(`UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?`)
      .run(customerId, new Date().toISOString(), userId);
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { reflect_user_id: userId },
  });

  return session.url;
}

export async function createBillingPortalSession(
  db: Database.Database,
  userId: string,
  returnUrl: string,
): Promise<string | null> {
  const stripe = getStripe();
  if (!stripe) return null;

  const user = db
    .prepare(`SELECT stripe_customer_id FROM users WHERE id = ?`)
    .get(userId) as { stripe_customer_id: string | null } | undefined;

  if (!user?.stripe_customer_id) return null;

  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: returnUrl,
  });

  return session.url;
}

export function handleStripeWebhook(
  db: Database.Database,
  event: Stripe.Event,
): void {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.reflect_user_id;
      const customerId = session.customer as string;

      if (userId && customerId) {
        db.prepare(`UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?`)
          .run(customerId, new Date().toISOString(), userId);
      }
      break;
    }

    case "customer.subscription.updated":
    case "customer.subscription.created": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = sub.customer as string;
      const priceId = sub.items.data[0]?.price?.id;
      const status = sub.status;

      const plan = determinePlanFromPrice(priceId);

      if (status === "active" || status === "trialing") {
        db.prepare(`UPDATE users SET plan = ?, updated_at = ? WHERE stripe_customer_id = ?`)
          .run(plan, new Date().toISOString(), customerId);
      }
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = sub.customer as string;

      db.prepare(`UPDATE users SET plan = 'free', updated_at = ? WHERE stripe_customer_id = ?`)
        .run(new Date().toISOString(), customerId);
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = invoice.customer as string;
      console.log(`[billing] Payment failed for customer ${customerId}`);
      break;
    }
  }
}

function determinePlanFromPrice(priceId: string | undefined): string {
  if (!priceId) return "free";
  if (priceId === process.env.STRIPE_PRICE_BUILDER) return "builder";
  return "builder";
}

export async function constructStripeEvent(
  rawBody: string | Buffer,
  signature: string,
): Promise<Stripe.Event | null> {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !webhookSecret) return null;

  try {
    return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("[billing] Webhook signature verification failed:", err);
    return null;
  }
}
