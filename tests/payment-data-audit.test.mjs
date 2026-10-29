import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditPaymentDatabase } from '../scripts/audit-payment-data.mjs';

test('audit detects financial inconsistencies without changing the database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yaadrakho-audit-'));
  const path = join(dir, 'fixture.db');
  try {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE customers(id INTEGER, owner_user_id INTEGER, current_due_id INTEGER);
      CREATE TABLE payment_dues(id INTEGER, owner_user_id INTEGER, customer_id INTEGER, amount_due INTEGER, amount_paid INTEGER, due_date TEXT, period_key TEXT, status TEXT);
      CREATE TABLE payment_transactions(id INTEGER, owner_user_id INTEGER, customer_id INTEGER, due_id INTEGER, amount INTEGER, idempotency_key TEXT);
      CREATE TABLE invoices(id INTEGER, owner_user_id INTEGER, customer_id INTEGER, due_id INTEGER, total_amount INTEGER, amount_paid INTEGER, due_date TEXT, status TEXT);
      INSERT INTO customers VALUES(1,1,1);
      INSERT INTO payment_dues VALUES(1,1,1,100,100,'2026-09-18','2026-09','paid');
      INSERT INTO payment_transactions VALUES(1,1,1,1,100,'modern-payment'),(2,1,1,1,100,'legacy-customer-payment:1');
      INSERT INTO invoices VALUES(1,1,1,1,100,100,'2026-09-18','paid');
      INSERT INTO customers VALUES(2,2,1);
      INSERT INTO payment_transactions VALUES(3,2,2,999,20,'orphan');
      INSERT INTO invoices VALUES(2,1,1,1,200,0,'2026-09-19','issued');
    `);
    db.close();
    const before = readFileSync(path);
    const report = auditPaymentDatabase(path);
    assert.equal(report.readOnly, true);
    assert.equal(report.integrity, 'ok');
    const count = id => report.checks.find(check => check.id === id)?.count;
    assert.equal(count('duplicate_legacy_mirror'), 1);
    assert.equal(count('ledger_due_balance'), 1);
    assert.equal(count('payment_owner_or_due'), 1);
    assert.equal(count('customer_due_pointer'), 1);
    assert.equal(count('invoice_due_consistency'), 1);
    assert.ok(report.summary.skippedChecks > 0);
    assert.deepEqual(readFileSync(path), before, 'read-only audit must preserve every database byte');
  } finally { rmSync(path, {force:true}); rmdirSync(dir); }
});

test('an old schema is reported as incomplete, not silently marked clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yaadrakho-old-audit-'));
  const path = join(dir, 'old.db');
  try {
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE customers(id INTEGER)');
    db.close();
    const report = auditPaymentDatabase(path);
    assert.equal(report.summary.completedChecks, 0);
    assert.equal(report.summary.skippedChecks, 9);
  } finally { rmSync(path, {force:true}); rmdirSync(dir); }
});

test('verified refund resolutions are separated from unresolved captures without changing records', () => {
 const dir = mkdtempSync(join(tmpdir(), 'yaadrakho-refund-audit-'));
 const path = join(dir, 'refund.db');
 try {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE razorpay_captures(payment_id TEXT, owner_user_id INTEGER, invoice_id INTEGER, due_id INTEGER, amount INTEGER, status TEXT);
   CREATE TABLE payment_reconciliations(payment_id TEXT);
   INSERT INTO razorpay_captures VALUES('pay_resolved',1,1,1,100,'needs_review'),('pay_open',1,2,2,200,'needs_review');
   INSERT INTO payment_reconciliations VALUES('pay_resolved');`);
  db.close();
  const before = readFileSync(path);
  const report = auditPaymentDatabase(path);
  assert.equal(report.checks.find(check => check.id === 'unresolved_capture').count, 1);
  assert.deepEqual(readFileSync(path), before);
 } finally { rmSync(path, {force:true}); rmdirSync(dir); }
});
