import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import PwaInstall from "./PwaInstall";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "YaadRakho — Customer Follow-up";
  const description = "A simple customer, payment, and follow-up tracker for small businesses.";
  return {
    metadataBase: new URL(origin),
    title,
    description,
    openGraph: { title, description, images: [{ url: `${origin}/og.png`, width: 1792, height: 939 }], type: "website" },
    twitter: { card: "summary_large_image", title, description, images: [`${origin}/og.png`] },
    manifest: "/manifest.webmanifest",
    icons: { icon: [{ url: "/icon-192.png", sizes: "192x192", type: "image/png" }], apple: "/icon-192.png" },
    appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "YaadRakho" },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}<PwaInstall /></body>
    </html>
  );
}
