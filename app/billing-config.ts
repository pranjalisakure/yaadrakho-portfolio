export const OWNER_EMAIL = "owner@example.test";
export const PAYMENTS_ENABLED = false;

export const PLAN_DETAILS = {
  trial: { name: "Free Early Access", price: 0, customerLimit: 100000 },
  starter: { name: "Starter", price: 299, customerLimit: 100 },
  pro: { name: "Pro", price: 599, customerLimit: 100000 },
} as const;
