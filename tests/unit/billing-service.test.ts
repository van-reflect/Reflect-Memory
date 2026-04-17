// Unit tests: src/billing-service.ts
//
// PLAN_LIMITS is the single source of truth for "how many memories / API keys
// can each plan have". Enough business logic flows from this constant that
// changes should be deliberate -- locking the shape down here makes accidental
// regressions visible in CI before they ship to billing.

import { describe, expect, it } from "vitest";
import { PLAN_LIMITS, isStripeConfigured } from "../../src/billing-service.js";

describe("PLAN_LIMITS", () => {
  it("defines limits for every supported plan in schema.sql", () => {
    // Plans must match the CHECK constraint in users.plan.
    const expectedPlans = ["free", "builder", "pro", "team", "admin"];
    for (const p of expectedPlans) {
      expect(PLAN_LIMITS[p], `plan "${p}" missing from PLAN_LIMITS`).toBeDefined();
    }
  });

  it("free plan caps at 200 memories / 2 API keys", () => {
    expect(PLAN_LIMITS.free).toEqual({ maxMemories: 200, maxApiKeys: 2 });
  });

  it("pro and builder are equivalent (builder is a legacy alias)", () => {
    expect(PLAN_LIMITS.pro).toEqual(PLAN_LIMITS.builder);
  });

  it("team plan is at least 10x free", () => {
    expect(PLAN_LIMITS.team.maxMemories).toBeGreaterThanOrEqual(
      PLAN_LIMITS.free.maxMemories * 10,
    );
  });

  it("limits are monotonically non-decreasing free -> pro -> team -> admin", () => {
    expect(PLAN_LIMITS.pro.maxMemories).toBeGreaterThanOrEqual(PLAN_LIMITS.free.maxMemories);
    expect(PLAN_LIMITS.team.maxMemories).toBeGreaterThanOrEqual(PLAN_LIMITS.pro.maxMemories);
    expect(PLAN_LIMITS.admin.maxMemories).toBeGreaterThanOrEqual(PLAN_LIMITS.team.maxMemories);

    expect(PLAN_LIMITS.pro.maxApiKeys).toBeGreaterThanOrEqual(PLAN_LIMITS.free.maxApiKeys);
    expect(PLAN_LIMITS.team.maxApiKeys).toBeGreaterThanOrEqual(PLAN_LIMITS.pro.maxApiKeys);
    expect(PLAN_LIMITS.admin.maxApiKeys).toBeGreaterThanOrEqual(PLAN_LIMITS.team.maxApiKeys);
  });

  it("admin uses Infinity as the unlimited sentinel (consumed by checkQuota -> -1)", () => {
    expect(PLAN_LIMITS.admin.maxMemories).toBe(Infinity);
    expect(PLAN_LIMITS.admin.maxApiKeys).toBe(Infinity);
  });
});

describe("isStripeConfigured", () => {
  it("reflects whether STRIPE_SECRET_KEY is present in the env", () => {
    const original = process.env.STRIPE_SECRET_KEY;
    try {
      delete process.env.STRIPE_SECRET_KEY;
      expect(isStripeConfigured()).toBe(false);
      process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
      expect(isStripeConfigured()).toBe(true);
    } finally {
      if (original === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = original;
    }
  });
});
