"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.href = "/login";
  }

  return (
    <main className="app-error" role="alert">
      <span className="brand-mark">Y</span>
      <h1>YaadRakho could not open.</h1>
      <p>Something went wrong while opening the customer list. Tap Try again. Your saved customer data remains in your account.</p>
      <div>
        <button className="primary-button" onClick={reset}>Try again</button>
        <button className="secondary-button" onClick={signOut}>Sign out</button>
      </div>
    </main>
  );
}
