"use client";

import { useEffect, useState } from "react";
import type { BillingTab } from "./BillingCenter";

type BillingStats = { totalBills: number; pendingBills: number; dueToday: number; overdueBills: number; collectedAmount: number; upcomingReminders: number };

function money(amount: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount || 0);
}

export default function BillingDashboardPanel({ onOpen }: { onOpen: (tab: BillingTab) => void }) {
  const [stats, setStats] = useState<BillingStats | null>(null);
  useEffect(() => {
    let active = true;
    void fetch("/api/sales-billing", { cache: "no-store" }).then((response) => response.ok ? response.json() : null).then((data) => {
      if (active && data?.stats) setStats(data.stats as BillingStats);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  return <section className="dashboard-billing-panel" aria-label="Billing shortcuts">
    <div className="dashboard-billing-heading"><div><span className="eyebrow">Billing workspace</span><h2>Create bills and track every payment</h2></div><button className="primary-button" onClick={() => onOpen("invoice")}>+ Create Bill</button></div>
    <div className="billing-shortcut-grid">
      <button onClick={() => onOpen("history")}><small>Total bills</small><strong>{stats?.totalBills ?? "–"}</strong><span>Bill History →</span></button>
      <button onClick={() => onOpen("history")}><small>Pending bills</small><strong>{stats?.pendingBills ?? "–"}</strong><span>Bill History →</span></button>
      <button onClick={() => onOpen("reminders")}><small>Due today / overdue</small><strong>{stats ? `${stats.dueToday} / ${stats.overdueBills}` : "–"}</strong><span>Billing Reminders →</span></button>
      <button onClick={() => onOpen("history")}><small>Collected amount</small><strong>{stats ? money(stats.collectedAmount) : "–"}</strong><span>View payments →</span></button>
      <button onClick={() => onOpen("reminders")}><small>Upcoming reminders</small><strong>{stats?.upcomingReminders ?? "–"}</strong><span>Billing Reminders →</span></button>
      <button onClick={() => onOpen("catalog")}><small>Saved price list</small><strong>Products</strong><span>Product Catalog →</span></button>
    </div>
  </section>;
}
