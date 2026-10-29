// Explicitly limited to a loopback-only demo using a local database. Never available on Vercel.
export function localDemoAuthEnabled(request?: Request) {
  if (process.env.ALLOW_LOCAL_DEMO_AUTH !== "true" || process.env.VERCEL || process.env.VERCEL_ENV) return false;
  const database = process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || "";
  if (!database.startsWith("file:")) return false;
  try {
    const url = new URL(process.env.PUBLIC_APP_URL || "");
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return false;
    if (!request) return true;
    const incoming = new URL(request.url);
    // Next may normalize 127.0.0.1 to localhost internally. Both must stay on the same local port.
    return incoming.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(incoming.hostname) && incoming.port === url.port;
  } catch { return false; }
}
