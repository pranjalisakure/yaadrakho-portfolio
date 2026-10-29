export function publicAppUrl(request: Request) {
  // Preview databases belong to their preview, not an inherited production/old URL.
  // Use Vercel's deployment identity instead of trusting a forwarded Host header.
  if (process.env.VERCEL_ENV === "preview") {
    const deployment = process.env.VERCEL_URL?.trim();
    if (deployment) {
      if (!/^[a-z0-9-]+\.vercel\.app$/i.test(deployment)) throw new Error("Invalid Preview deployment URL configuration.");
      return `https://${deployment}`;
    }
    return new URL(request.url).origin;
  }
  const configured = process.env.PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  if (configured) return configured;
  return new URL(request.url).origin;
}
