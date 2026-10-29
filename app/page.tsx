import { getCurrentUser } from "./auth";
import { smsOtpAvailable } from "./sms-provider";
import Dashboard from "./Dashboard";
import { PAYMENTS_ENABLED } from "./billing-config";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getCurrentUser();

  if (!user) {
    return (
      <main className="login-page">
        <header className="landing-nav">
          <Link className="brand" href="/" aria-label="YaadRakho home">
            <span className="brand-mark">Y</span>
            <span><strong>YaadRakho</strong><small>Customer follow-up</small></span>
          </Link>
          <nav aria-label="Landing page navigation"><a href="#features">Features</a><a href="#how-it-works">How it works</a><a href="#pricing">Pricing</a></nav>
          <div className="nav-auth-actions"><a className="nav-signin" href="/login">Sign in</a><a className="primary-button nav-app-button" href="/login?mode=signup">Create free account</a></div>
        </header>
        <section className="login-copy">
          <span className="launch-badge"><b>✓</b> Built for Indian small businesses</span>
          <span className="eyebrow">A smart assistant for small businesses</span>
          <h1>Never forget a customer.<br /><em>Keep your business moving.</em></h1>
          <p>Save every lead, track every payment, and know exactly who to call today—all from one simple dashboard.</p>
          <div className="login-actions">
            <a className="primary-button login-button" href="/login?mode=signup">Create free account</a>
            <a className="text-link" href="/login">Already have an account? Sign in</a>
          </div>
          <div className="trust-row"><span>Free early access</span><span>No payment required</span><span>Secure account</span></div>
        </section>
        <section className="login-preview" aria-label="YaadRakho benefits">
          <div className="preview-card preview-main">
            <span className="preview-label">Follow-ups today</span><strong>04</strong>
            <div className="preview-lines"><i /><i /><i /></div>
          </div>
          <div className="preview-card preview-small"><span>Reminder</span><strong>ON</strong></div>
          <div className="login-points">
            <p><b>1</b> Add your customers</p>
            <p><b>2</b> Set a follow-up date</p>
            <p><b>3</b> Receive reminders and close sales</p>
          </div>
        </section>
        <section className="feature-section" id="features">
          <div className="section-intro"><span className="eyebrow">Everything in one place</span><h2>Simple tools that help you close more sales.</h2><p>No complicated CRM training. Add a customer and start following up in minutes.</p></div>
          <div className="feature-grid">
            <article><b>01</b><h3>Customer diary</h3><p>Save contact details, work purpose, notes, amount, and payment status.</p></article>
            <article><b>02</b><h3>Daily follow-ups</h3><p>See today&apos;s and overdue customers the moment you open the app.</p></article>
            <article><b>03</b><h3>Fast communication</h3><p>Call directly or open a ready customer message in SMS and WhatsApp.</p></article>
            <article><b>04</b><h3>Payment tracking</h3><p>Clearly mark pending, partial, and received payments for every customer.</p></article>
          </div>
        </section>
        <section className="how-section" id="how-it-works">
          <div className="section-intro"><span className="eyebrow">How it works</span><h2>Three steps. No customer forgotten.</h2></div>
          <div className="how-grid">
            <article><span>1</span><div><h3>Create your free account</h3><p>Create your private YaadRakho login with your email and password.</p></div></article>
            <article><span>2</span><div><h3>Add customer and date</h3><p>Enter their details, payment amount, and next follow-up date.</p></div></article>
            <article><span>3</span><div><h3>Follow up and convert</h3><p>Use your reminder list to call, message, and record the result.</p></div></article>
          </div>
          <a className="primary-button section-cta" href="/login?mode=signup">Open YaadRakho App</a>
        </section>
        <section className="public-pricing" id="pricing">
          <div className="pricing-heading"><span className="eyebrow">Free early access</span><h2>Use YaadRakho free while we improve it.</h2><p>All currently available core features are free during development. Paid subscriptions will open only after automation and billing are fully ready.</p></div>
          <div className="pricing-grid">
            <article><span>Free Early Access</span><strong>₹0</strong><small>during development</small><ul><li>No trial expiry</li><li>Follow-up reminders</li><li>Call, SMS, and WhatsApp shortcuts</li></ul><a href="/login?mode=signup">Start free</a></article>
            {PAYMENTS_ENABLED && <><article className="featured"><span>Starter</span><strong>₹299</strong><small>per month</small><ul><li>Up to 100 customers</li><li>Payment tracking</li><li>Customer communication tools</li></ul>{PAYMENTS_ENABLED ? <a href="/login?mode=signup">Choose Starter</a> : <button type="button" disabled>Coming Soon — Unavailable</button>}</article>
            <article><span>Pro</span><strong>₹599</strong><small>per month</small><ul><li>Unlimited customers</li><li>All reminders and tracking</li><li>Priority support</li></ul>{PAYMENTS_ENABLED ? <a href="/login?mode=signup">Choose Pro</a> : <button type="button" disabled>Coming Soon — Unavailable</button>}</article></>}
          </div>
          <p className="pricing-note">No payment is being collected now. We will clearly inform users before paid subscriptions are introduced.</p>
        </section>
        <section className="final-cta">
          <span className="eyebrow">Ready to start?</span><h2>Your next customer follow-up is one click away.</h2><p>Start free today and keep every business opportunity organised.</p><a className="primary-button" href="/login?mode=signup">Open App — Create Free Account</a>
        </section>
        <footer className="landing-footer"><Link className="brand" href="/"><span className="brand-mark">Y</span><span><strong>YaadRakho</strong><small>Customer follow-up</small></span></Link><p>Customer and payment follow-up software for small businesses.</p><a href="/login">Sign in</a></footer>
      </main>
    );
  }

  return <Dashboard user={user} isAdmin={user.isOwner} smsEnabled={smsOtpAvailable()} />;
}
