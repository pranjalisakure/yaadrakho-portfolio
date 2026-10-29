# YaadRakho — Customer Follow-up and Billing

A full-stack project by **Pranjali Sakure**, built with AI-assisted development, for small businesses to manage customer follow-ups, invoices and outstanding payments.

## Project status

This is a sanitized source-code portfolio snapshot of an actively developed application. It is not a claim of a fully launched SaaS. Public email delivery, live merchant payment settlement, remote database recovery and physical-device notification testing still require validation.

## Features implemented

- Email/password accounts, email verification, email-code password recovery and secure sessions.
- Customer records, follow-up dates, payment ledgers and monthly payment tracking.
- Product catalog, invoices, printable bills and receipts.
- Full payment: receipt without a payment QR. Cash collection: no QR. Pending or partial online payments: payment flow for the remaining balance.
- Reminder scheduling, Web Push registration and notification navigation.
- Owner dashboard, tenant-scoped data access and payment review/recovery logic.
- Razorpay order, signature and webhook handling, with automated integration tests. Live settlement is not yet verified.

## Technology

Next.js App Router, React, TypeScript, Tailwind CSS, Turso/libSQL, Drizzle ORM, Resend, Web Push and Razorpay. Automated release checks use GitHub Actions; the working application is deployed to Vercel Preview.

## Explore the code

| Directory | Contents |
| --- | --- |
| `app/` | UI, authentication, billing, API routes and reminder logic |
| `db/` | Data access, ledger rules and payment processing |
| `drizzle/` | Database schema migrations |
| `tests/` | Synthetic integration and regression checks |
| `scripts/` | Release checks, local demo and backup utilities |
| `public/` | PWA manifest, icons and service worker |

## Run locally

Use Node.js 22.16 or newer.

```sh
npm ci
npm run build
mkdir backups
node scripts/start-local-reminders.mjs
```

Open `http://127.0.0.1:3200`. The local launcher uses a local SQLite demo database, disables external payment/email/SMS services and generates local notification secrets. Do not use this demo configuration for public hosting.

For a separately configured deployment, use `.env.example` and supply your own provider credentials. The protected owner identity in this copy is the placeholder `owner@example.test`.

## Validation

```sh
npm run test:release
```

The source application passed 19 automated release checks, production build and lint on 25 October 2026. Those checks use synthetic data and mocked providers; they do not prove real email delivery, real settlement or device behavior.

## Publication safety

This repository starts with fresh history. It excludes the private repository history, Android signing keys, APKs, database exports, local environment files and internal handover documents. Owner email and selected fixture contact details are replaced with placeholders. The legacy reminder workflow is disabled so it cannot call the original deployment. Legacy hosting metadata is a placeholder, not an active project connection.

No live credentials or demo account passwords are supplied. The original private project and deployment are maintained separately.
