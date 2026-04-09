# Stripe Setup Guide

## Step 1: Create Account

1. Go to [stripe.com](https://stripe.com) and sign up
2. Complete identity verification (required for live payments)

## Step 2: Create Products & Pricing

In the Stripe dashboard → Products, create:

### Free Plan
- Name: "Reflect Memory Free"
- Price: $0/month (no Stripe subscription needed)
- Limits: 200 memories, 2 API keys

### Pro Plan
- Name: "Reflect Memory Pro"
- Price: $20/month
- Limits: 400 memories, 5 API keys

### Team Plan
- Name: "Reflect Memory Team"
- Price: $200/month
- Limits: 4,000 shared memories, 10 API keys, up to 10 seats
- Additional seats: $20/mo each (+400 memories per seat)

### Enterprise
- Custom pricing (Contact Sales)
- Private deploy, SSO, audit trail, custom limits

**Copy the Price IDs** (starts with `price_`) for the Pro and Team plans.

## Step 3: Get API Keys

From Stripe dashboard → Developers → API Keys:

- **Publishable Key** -- `pk_test_...` (client-side, for Checkout)
- **Secret Key** -- `sk_test_...` (server-side only)

## Step 4: Configure Webhooks

1. Stripe dashboard → Developers → Webhooks → Add Endpoint
2. URL: `https://api.reflectmemory.com/webhooks/stripe`
3. Select events:
   - `checkout.session.completed`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Copy the **Webhook Signing Secret** -- `whsec_...`

## Step 5: Set Environment Variables

### Backend (Railway / `.env`)

```env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO=price_...
```

### Dashboard (Vercel / `.env.local`)

```env
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

## Step 6: Go Live

When ready for production:
1. Switch from test keys to live keys in Stripe dashboard
2. Update all env vars with `sk_live_`, `pk_live_`, and new webhook secret
3. Re-create webhook endpoint with production URL
