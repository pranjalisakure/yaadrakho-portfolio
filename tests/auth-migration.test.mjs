import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createClient } from "@libsql/client";

test("Phase 1 migration preserves and verifies existing accounts", async () => {
  const db = createClient({ url: "file::memory:" });
  await db.execute(`CREATE TABLE users (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    email text NOT NULL UNIQUE,
    display_name text NOT NULL,
    storage_key text NOT NULL UNIQUE,
    password_salt text NOT NULL,
    password_hash text NOT NULL,
    recovery_salt text NOT NULL,
    recovery_hash text NOT NULL,
    is_owner integer DEFAULT 0 NOT NULL,
    created_at integer NOT NULL,
    updated_at integer NOT NULL
  )`);
  await db.execute({ sql: `INSERT INTO users (email, display_name, storage_key, password_salt, password_hash,
    recovery_salt, recovery_hash, is_owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`, args: ["existing@example.com", "Existing Business", "account:existing@example.com", "salt", "hash", "salt", "hash", 1, 1] });
  const migration = await readFile(new URL("../drizzle/0008_auth_security.sql", import.meta.url), "utf8");
  for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) await db.execute(statement);
  const existing = await db.execute("SELECT email, email_verified_at FROM users WHERE email = 'existing@example.com'");
  assert.equal(existing.rows.length, 1);
  assert.ok(Number(existing.rows[0].email_verified_at) > 0);
  const tables = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
  assert.ok(tables.rows.some((row) => row.name === "account_tokens"));
  assert.ok(tables.rows.some((row) => row.name === "auth_requests"));
  db.close();
});
