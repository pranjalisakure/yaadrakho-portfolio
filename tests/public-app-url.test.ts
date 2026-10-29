import assert from "node:assert/strict";
import test from "node:test";
import { publicAppUrl } from "../app/public-app-url";

test("uses the stable configured public app URL for customer-facing links", () => {
  const previous = process.env.PUBLIC_APP_URL;
  process.env.PUBLIC_APP_URL = "https://demo.yaadrakho.example/";
  try {
    assert.equal(
      publicAppUrl(new Request("https://temporary-deployment.example/api/sales-billing")),
      "https://demo.yaadrakho.example",
    );
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = previous;
  }
});

test("falls back to the request origin when no public URL is configured", () => {
  const previous = process.env.PUBLIC_APP_URL;
  delete process.env.PUBLIC_APP_URL;
  try {
    assert.equal(
      publicAppUrl(new Request("https://preview.example.test/api/sales-billing")),
      "https://preview.example.test",
    );
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = previous;
  }
});

test("preview links ignore stale shared URL and use trusted deployment identity", () => {
  const old = { PUBLIC_APP_URL: process.env.PUBLIC_APP_URL, VERCEL_ENV: process.env.VERCEL_ENV, VERCEL_URL: process.env.VERCEL_URL };
  try {
    process.env.PUBLIC_APP_URL = "https://removed-phase5.vercel.app";
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_URL = "current-preview.vercel.app";
    assert.equal(publicAppUrl(new Request("https://untrusted.example/api/auth/signup")), "https://current-preview.vercel.app");
    process.env.VERCEL_URL = "evil.example/path";
    assert.throws(() => publicAppUrl(new Request("https://preview.example/api/auth/signup")), /Invalid Preview/);
    delete process.env.VERCEL_URL;
    assert.equal(publicAppUrl(new Request("https://preview.example/api/auth/signup")), "https://preview.example");
    process.env.VERCEL_ENV = "production";
    assert.equal(publicAppUrl(new Request("https://preview.example/api/auth/signup")), "https://removed-phase5.vercel.app");
  } finally {
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
