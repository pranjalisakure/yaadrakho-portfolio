export default function Loading() {
  return (
    <main className="app-loading" aria-live="polite" aria-label="Loading YaadRakho">
      <span className="brand-mark">Y</span>
      <strong>YaadRakho</strong>
      <span className="loader" aria-hidden="true" />
      <p>Opening your customer dashboard…</p>
    </main>
  );
}
