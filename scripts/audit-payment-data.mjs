import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// This module never imports application setup: opening an audit must not migrate or backfill a database.
export function auditPaymentDatabase(filename, { sampleLimit = 20 } = {}) {
  const path = resolve(filename);
  if (!existsSync(path)) throw new Error('Database file does not exist');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON');
    db.exec('BEGIN');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    const columns = new Map();
    const has = (table, required) => {
      if (!tables.has(table)) return false;
      if (!columns.has(table)) columns.set(table, new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name)));
      return required.every(column => columns.get(table).has(column));
    };
    const checks = [];
    const check = (id, severity, requirements, sql) => {
      const missing = Object.entries(requirements).filter(([table, fields]) => !has(table, fields)).map(([table]) => table);
      if (missing.length) { checks.push({ id, severity, status: 'skipped', reason: 'Required table/columns unavailable: ' + missing.join(', ') }); return; }
      const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM (${sql}) audit_rows`).get().count);
      const samples = count ? db.prepare(`SELECT * FROM (${sql}) audit_rows LIMIT ?`).all(Math.max(0, Math.min(100, sampleLimit))) : [];
      checks.push({ id, severity, status: count ? 'review' : 'pass', count, samples });
    };
    check('ledger_due_balance', 'error', { payment_dues: ['id','owner_user_id','amount_paid'], payment_transactions: ['due_id','owner_user_id','amount'] }, `
      SELECT d.id AS dueId, d.owner_user_id AS ownerId, d.amount_paid AS recordedPaid,
        COALESCE(SUM(t.amount), 0) AS transactionTotal
      FROM payment_dues d LEFT JOIN payment_transactions t ON t.due_id = d.id AND t.owner_user_id = d.owner_user_id
      GROUP BY d.id HAVING d.amount_paid != COALESCE(SUM(t.amount), 0)`);
    check('duplicate_legacy_mirror', 'review', { payment_transactions: ['id','owner_user_id','due_id','idempotency_key'] }, `
      SELECT legacy.id AS paymentId, legacy.due_id AS dueId, legacy.owner_user_id AS ownerId
      FROM payment_transactions legacy WHERE legacy.idempotency_key LIKE 'legacy-customer-payment:%'
      AND EXISTS (SELECT 1 FROM payment_transactions modern WHERE modern.due_id = legacy.due_id
        AND modern.owner_user_id = legacy.owner_user_id AND modern.idempotency_key NOT LIKE 'legacy-customer-payment:%')`);
    check('payment_owner_or_due', 'error', { payment_transactions: ['id','owner_user_id','customer_id','due_id'], payment_dues: ['id','owner_user_id','customer_id'] }, `
      SELECT t.id AS paymentId, t.due_id AS dueId, t.owner_user_id AS ownerId FROM payment_transactions t
      LEFT JOIN payment_dues d ON d.id = t.due_id
      WHERE d.id IS NULL OR d.owner_user_id IS NOT t.owner_user_id OR d.customer_id IS NOT t.customer_id`);
    check('customer_due_pointer', 'error', { customers: ['id','owner_user_id','current_due_id'], payment_dues: ['id','owner_user_id','customer_id'] }, `
      SELECT c.id AS customerId, c.owner_user_id AS ownerId, c.current_due_id AS dueId FROM customers c
      LEFT JOIN payment_dues d ON d.id = c.current_due_id WHERE c.current_due_id IS NOT NULL
      AND (d.id IS NULL OR d.customer_id IS NOT c.id OR d.owner_user_id IS NOT c.owner_user_id)`);
    check('due_status', 'error', { payment_dues: ['id','owner_user_id','amount_due','amount_paid','status'] }, `
      SELECT id AS dueId, owner_user_id AS ownerId, amount_due AS amountDue, amount_paid AS amountPaid, status
      FROM payment_dues WHERE amount_paid < 0 OR amount_paid > amount_due
      OR (status = 'paid' AND amount_paid != amount_due)
      OR (status = 'partial' AND (amount_paid <= 0 OR amount_paid >= amount_due))
      OR (status = 'pending' AND amount_paid > 0)`);
    check('invoice_due_consistency', 'error', { invoices: ['id','due_id','customer_id','owner_user_id','total_amount','amount_paid','due_date','status'], payment_dues: ['id','customer_id','owner_user_id','amount_due','amount_paid','due_date'] }, `
      SELECT i.id AS invoiceId, i.due_id AS dueId, i.owner_user_id AS ownerId,
        i.total_amount AS invoiceTotal, d.amount_due AS dueTotal, i.amount_paid AS invoicePaid, d.amount_paid AS duePaid
      FROM invoices i LEFT JOIN payment_dues d ON d.id = i.due_id WHERE i.status != 'cancelled'
      AND (d.id IS NULL OR d.owner_user_id IS NOT i.owner_user_id OR d.customer_id IS NOT i.customer_id
        OR i.total_amount != d.amount_due OR i.amount_paid != d.amount_paid OR i.due_date != d.due_date)`);
    check('possible_extra_one_time_due', 'review', { payment_dues: ['id','owner_user_id','customer_id','period_key','amount_due','amount_paid'], invoices: ['id','due_id','customer_id','owner_user_id','status'] }, `
      SELECT d.id AS dueId, d.owner_user_id AS ownerId, d.customer_id AS customerId FROM payment_dues d
      WHERE d.period_key LIKE 'one-time:%' AND d.amount_due > d.amount_paid
      AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.due_id = d.id AND i.owner_user_id = d.owner_user_id)
      AND EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = d.customer_id AND i.owner_user_id = d.owner_user_id AND i.status != 'cancelled')`);
    check('paid_order_without_matching_ledger', 'error', { razorpay_orders: ['id','owner_user_id','due_id','amount','payment_id','status'], payment_transactions: ['due_id','owner_user_id','amount','idempotency_key'] }, `
      SELECT o.id AS orderId, o.owner_user_id AS ownerId, o.due_id AS dueId FROM razorpay_orders o WHERE o.status = 'paid'
      AND NOT EXISTS (SELECT 1 FROM payment_transactions t WHERE t.owner_user_id = o.owner_user_id AND t.due_id = o.due_id
        AND t.amount = o.amount AND t.idempotency_key = 'razorpay:' || o.payment_id)`);
    check('unresolved_capture', 'review', { razorpay_captures: ['owner_user_id','invoice_id','due_id','amount','status'] }, `
      SELECT owner_user_id AS ownerId, invoice_id AS invoiceId, due_id AS dueId, amount, status
      FROM razorpay_captures WHERE status != 'applied' ${has('payment_reconciliations', ['payment_id']) && has('razorpay_captures', ['payment_id']) ? 'AND NOT EXISTS (SELECT 1 FROM payment_reconciliations r WHERE r.payment_id = razorpay_captures.payment_id)' : ''}`);
    const integrity = Object.values(db.prepare('PRAGMA quick_check').get())[0];
    const counts = {};
    for (const table of ['users','customers','payment_dues','payment_transactions','invoices','razorpay_orders','razorpay_captures']) {
      counts[table] = tables.has(table) ? Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count) : null;
    }
    const result = {
      readOnly: true,
      integrity,
      counts,
      checks,
      summary: {
        completedChecks: checks.filter(check => check.status !== 'skipped').length,
        skippedChecks: checks.filter(check => check.status === 'skipped').length,
        checksNeedingReview: checks.filter(check => check.status === 'review').length,
        issueRows: checks.reduce((sum, check) => sum + (check.count || 0), 0),
        note: 'Issue rows can overlap. Review flags are not proof of duplicate charges. Missing historical transactions can reflect legacy migration rather than missing money.',
      },
    };
    db.exec('ROLLBACK');
    return result;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: node scripts/audit-payment-data.mjs <local-database-snapshot.db>');
    process.exitCode = 1;
  } else {
    try {
      const report = auditPaymentDatabase(path);
      console.log(JSON.stringify(report, null, 2));
      if (report.integrity !== 'ok' || report.summary.checksNeedingReview || report.summary.skippedChecks) process.exitCode = 2;
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Database audit failed');
      process.exitCode = 1;
    }
  }
}
