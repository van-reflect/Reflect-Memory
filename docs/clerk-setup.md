# Clerk Setup Guide

## Step 1: Create Account

1. Go to [clerk.com](https://clerk.com) and sign up
2. Create a new application called "Reflect Memory"
3. Choose authentication methods: **Email**, **Google**, **GitHub**
   - Apple and Facebook can be added later from the Clerk dashboard

## Step 2: Get API Keys

From the Clerk dashboard → API Keys, copy:

- **Publishable Key** — starts with `pk_test_` or `pk_live_`
- **Secret Key** — starts with `sk_test_` or `sk_live_`

## Step 3: Configure Webhooks

1. In Clerk dashboard → Webhooks → Add Endpoint
2. Set URL to: `https://api.reflectmemory.com/webhooks/clerk`
3. Select events:
   - `user.created`
   - `user.updated`
   - `user.deleted`
4. Copy the **Signing Secret** — starts with `whsec_`

## Step 4: Set Environment Variables

### Dashboard (Vercel / `.env.local`)

```env
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/auth/sign-in
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/dashboard
```

### Backend (Railway / `.env`)

```env
CLERK_WEBHOOK_SECRET=whsec_...
CLERK_SECRET_KEY=sk_test_...
```

## Step 5: Test

1. Start the dashboard locally with `npm run dev`
2. Navigate to `/auth/sign-in` — you should see the Clerk sign-in component
3. Sign in with your email — a user should be created in the Clerk dashboard
4. Check the backend logs for the webhook delivery
