import type { Client } from "@libsql/client";

export function normalizeCustomerPhone(value: unknown) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

export async function backfillCustomerPhoneKeys(database: Client, ownerUserId?: number) {
  const result = await database.execute({
    sql: `SELECT id, owner_user_id, phone, phone_key FROM customers
      WHERE owner_user_id IS NOT NULL ${ownerUserId === undefined ? "" : "AND owner_user_id = ?"}
      ORDER BY owner_user_id, id`,
    args: ownerUserId === undefined ? [] : [ownerUserId],
  });
  const claimed = new Set<string>();
  for (const row of result.rows) {
    const ownerId = Number(row.owner_user_id);
    const phoneKey = String(row.phone_key || "");
    if (ownerId && phoneKey) claimed.add(`${ownerId}:${phoneKey}`);
  }
  let updated = 0;
  let duplicates = 0;
  for (const row of result.rows) {
    if (row.phone_key) continue;
    const ownerId = Number(row.owner_user_id);
    const phoneKey = normalizeCustomerPhone(row.phone);
    if (!ownerId || !phoneKey) continue;
    const identity = `${ownerId}:${phoneKey}`;
    if (claimed.has(identity)) {
      duplicates += 1;
      continue;
    }
    try {
      const change = await database.execute({
        sql: "UPDATE customers SET phone_key = ? WHERE id = ? AND owner_user_id = ? AND phone_key IS NULL",
        args: [phoneKey, Number(row.id), ownerId],
      });
      if (change.rowsAffected > 0) {
        claimed.add(identity);
        updated += 1;
      }
    } catch (error) {
      if (!String(error).toLowerCase().includes("unique")) throw error;
      duplicates += 1;
      claimed.add(identity);
    }
  }
  return { updated, duplicates };
}
