"use client";

import { reminderCustomer } from "./reminder-customer";
import { existingReminderRegistration, readyReminderRegistration } from "./notification-client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { paymentReceivedAt } from "./payment-date";
import { PAYMENTS_ENABLED } from "./billing-config";
import BillingCenter, { type BillingTab } from "./BillingCenter";
import BillingDashboardPanel from "./BillingDashboardPanel";
import { paymentDueRemaining, paymentPeriodLabel, selectOpenPaymentDue } from "./payment-period";

  function subscriptionPayload(subscription: PushSubscription, times?: string[]) {
    let savedTimes: string[] = [];
    try {
      const stored = JSON.parse(localStorage.getItem("yaadrakho-extra-reminder-times") || "[]");
      if (Array.isArray(stored)) savedTimes = stored.map(String);
    } catch {
      // Use the current state when stored preferences are unavailable.
    }
    return { ...subscription.toJSON(), extraReminderTimes: times ?? savedTimes };
  }


type Customer = {
  id: number;
  name: string;
  phone: string;
  requirement: string;
  amount: number;
  outstandingAmount: number;
  amountPaid: number;
  followUpDate: string;
  status: "new" | "follow_up" | "won" | "lost";
  paymentStatus: "pending" | "partial" | "paid";
  billingCycle: "one_time" | "monthly";
  recurringDay: number;
  notes: string;
  contactConsent: boolean;
  createdAt: number;
  updatedAt: number;
  duplicateOfId?: number;
};

type FormState = Omit<Customer, "id" | "createdAt" | "updatedAt" | "recurringDay" | "outstandingAmount" | "amountPaid">;

type PaymentDue = {
  id: number;
  customerId: number;
  periodKey: string;
  amountDue: number;
  amountPaid: number;
  dueDate: string;
  status: "pending" | "partial" | "paid";
  paidAt: number | null;
};

type PaymentTransaction = { id: number; dueId: number; amount: number; method: string; reference: string; note: string; receiptNumber: string; receiptToken: string; balanceAfter: number; receivedAt: number };
type LedgerStats = { total: number; today: number; overdue: number; monthly: number; won: number; outstandingAmount: number };

type Subscription = {
  id: number;
  userEmail: string;
  plan: "trial" | "starter" | "pro";
  status: "trial" | "pending" | "active" | "cancelled";
  price: number;
  trialEndsAt: number;
  requestedAt: number | null;
  activatedAt: number | null;
  updatedAt: number;
};

type BillingData = { subscription: Subscription; requests: Subscription[]; isAdmin: boolean };
type AppSettings = { userEmail: string; businessName: string; phone: string; updatedAt: number };
type PaymentAccountSummary = { mode: "test" | "live"; routeEnabled: boolean; status: "pending" | "active" | "restricted" | "suspended"; providerAccountId: string };
type AdminBusinessFilter = "all" | "active" | "inactive" | "unverified" | "paid" | "trial";
type AdminBusiness = {
  id: number;
  displayName: string;
  email: string;
  verified: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  lastActivityAt: number | null;
  plan: "trial" | "starter" | "pro";
  planStatus: "trial" | "pending" | "active" | "cancelled";
  customerCount: number;
  monthlyCustomers: number;
  outstandingAmount: number;
  collectedAmount: number;
  reminderDevices: number;
  paymentAccountStatus: "pending" | "active" | "restricted" | "suspended";
  paymentAccountId: string;
};
type AdminOverview = {
  manualVerificationEnabled: boolean;
  paymentReconciliations?: Array<{ payment_id: string; refund_id: string; actor_user_id: number; note: string; created_at: number }>;
  recoveryOrders?: Array<{ id: number; owner_user_id: number; invoice_id: number; amount: number; status: string; error_message: string }>;
  paymentReviews: Array<{ payment_id: string; razorpay_order_id: string; owner_user_id: number; invoice_id: number; amount: number; status: string; error_message: string }>;
  metrics: {
    totalBusinesses: number;
    verifiedBusinesses: number;
    activeBusinesses: number;
    totalCustomers: number;
    monthlyCustomers: number;
    outstandingAmount: number;
    collectedAmount: number;
    reminderBusinesses: number;
    paidAccounts: number;
  };
  businesses: AdminBusiness[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
  filters: { query: string; filter: AdminBusinessFilter };
  reminderAutomation: null | {
    dateKey: string;
    deliverySlot: string;
    startedAt: number;
    finishedAt: number | null;
    checkedSubscriptions: number;
    sentNotifications: number;
    failedNotifications: number;
    removedSubscriptions: number;
    status: "running" | "completed" | "failed";
    errorMessage: string;
  };
  generatedAt: number;
};
type PhoneContact = { name?: string[]; tel?: string[] };
type ContactPickerNavigator = Navigator & {
  contacts?: {
    select: (properties: Array<"name" | "tel">, options: { multiple: boolean }) => Promise<PhoneContact[]>;
  };
};

type YaadRakhoAndroidBridge = {
  requestAlarmPermission: () => void;
  syncReminders: (payload: string) => void;
  cancelCustomerReminder: (customerId: string) => void;
  testAlarm: () => void;
  pickContact: () => void;
};

function androidBridge() {
  return (window as typeof window & { YaadRakhoAndroid?: YaadRakhoAndroidBridge }).YaadRakhoAndroid;
}

type NotificationState = NotificationPermission | "unsupported";

function notificationStatusMessage(permission: NotificationState, enabled: boolean) {
  if (permission === "unsupported") return "Notifications are not supported in this browser";
  if (permission === "denied") return "Notifications are blocked in Chrome settings";
  if (permission === "default") return "Notification permission not given";
  return enabled ? "Automatic reminders are on" : "Notification permission is allowed. Complete reminder setup.";
}

function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then((value) => {
      window.clearTimeout(timer);
      resolve(value);
    }, (error) => {
      window.clearTimeout(timer);
      reject(error);
    });
  });
}

let reminderAudioContext: AudioContext | null = null;

function playReminderTone() {
  if (typeof window === "undefined") return;
  const AudioContextConstructor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return;
  reminderAudioContext ??= new AudioContextConstructor();
  const context = reminderAudioContext;
  void context.resume().then(() => {
    const start = context.currentTime;
    [0, 0.32, 0.64].forEach((delay, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = index === 2 ? 1046 : 880;
      gain.gain.setValueAtTime(0.0001, start + delay);
      gain.gain.exponentialRampToValueAtTime(0.24, start + delay + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + delay + 0.22);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start + delay);
      oscillator.stop(start + delay + 0.24);
    });
  }).catch(() => undefined);
}

const emptyForm: FormState = {
  name: "",
  phone: "",
  requirement: "",
  amount: 0,
  followUpDate: localDateKey(),
  status: "new",
  paymentStatus: "pending",
  billingCycle: "one_time",
  notes: "",
  contactConsent: false,
};

const statusLabel = {
  new: "New lead",
  follow_up: "Follow-up",
  won: "Converted",
  lost: "Lost",
};

const paymentLabel = { pending: "Pending", partial: "Partially paid", paid: "Paid" };

function normalizeCustomer(value: Partial<Customer> & Record<string, unknown>): Customer {
  const rawDate = String(value.followUpDate || "").trim();
  const rawConsent = value.contactConsent as unknown;
  const amount = Number(value.amount);
  const status = ["new", "follow_up", "won", "lost"].includes(String(value.status))
    ? value.status as Customer["status"]
    : "new";
  const paymentStatus = ["pending", "partial", "paid"].includes(String(value.paymentStatus))
    ? value.paymentStatus as Customer["paymentStatus"]
    : "pending";
  const billingCycle = value.billingCycle === "monthly" ? "monthly" : "one_time";
  return {
    id: Number(value.id) || 0,
    name: String(value.name || "").trim() || "Unnamed customer",
    phone: String(value.phone || "").trim() || "No phone number",
    requirement: String(value.requirement || "").trim(),
    amount: Number.isFinite(amount) ? Math.max(0, amount) : 0,
    outstandingAmount: Math.max(0, Number(value.outstandingAmount ?? value.amount) || 0),
    amountPaid: Math.max(0, Number(value.amountPaid) || 0),
    followUpDate: /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : localDateKey(),
    status,
    paymentStatus,
    billingCycle,
    recurringDay: Math.min(31, Math.max(1, Number(value.recurringDay) || Number(rawDate.slice(-2)) || 1)),
    notes: String(value.notes || "").trim(),
    contactConsent: rawConsent === true || rawConsent === 1,
    createdAt: Number(value.createdAt) || Date.now(),
    updatedAt: Number(value.updatedAt) || Date.now(),
    duplicateOfId: Number(value.duplicateOfId) || undefined,
  };
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateLabel(value: string) {
  if (!value) return "No date selected";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  try {
    return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(date);
  } catch {
    return value;
  }
}

function whatsappNumber(phone: string) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length === 10 ? `91${digits}` : digits;
}

function moneyLabel(amount: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount || 0);
}

function activityLabel(value: number | null) {
  if (!value) return "Never active";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function customerMessage(customer: Customer, senderName: string) {
  const amountText = moneyLabel(customer.outstandingAmount);
  const paymentText = customer.paymentStatus === "paid"
    ? customer.amount > 0
      ? `we have received your payment of ${moneyLabel(customer.amount)}. Thank you!`
      : "we have received your payment. Thank you!"
    : customer.paymentStatus === "partial"
      ? `we have received a partial payment toward ${amountText}.`
      : `this is a reminder that your payment of ${amountText} is due on ${dateLabel(customer.followUpDate)}.`;
  const purpose = customer.requirement ? ` ${customer.requirement}.` : "";
  return `Hello ${customer.name}, ${paymentText}${purpose} - ${senderName}`;
}

export default function Dashboard({ user, isAdmin, smsEnabled = false }: { user: { displayName: string; email: string }; isAdmin: boolean; smsEnabled?: boolean }) {
  const reminderLinkHandled = useRef(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [stats, setStats] = useState<LedgerStats>({ total: 0, today: 0, overdue: 0, monthly: 0, won: 0, outstandingAmount: 0 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "today" | "overdue" | "monthly" | "won">("all");
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [remindersEnabled, setRemindersEnabled] = useState(false);
  const [reminderStatusReady, setReminderStatusReady] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationState>("default");
  const [reminderBusy, setReminderBusy] = useState<"enable" | "disable" | "test" | "times" | null>(null);
  const [extraReminderTimes, setExtraReminderTimes] = useState<string[]>([]);
  const [convertingId, setConvertingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [historyCustomer, setHistoryCustomer] = useState<Customer | null>(null);
  const [paymentHistory, setPaymentHistory] = useState<PaymentDue[]>([]);
  const [paymentTransactions, setPaymentTransactions] = useState<PaymentTransaction[]>([]);
  const [paymentDueId, setPaymentDueId] = useState<number | null>(null);
  const [paymentAmount, setPaymentAmount] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState("upi");
  const [paymentReference, setPaymentReference] = useState("");
  const paymentAttempt = useRef<{ fingerprint: string; key: string; receivedAt: number } | null>(null);
  const [paymentDate, setPaymentDate] = useState(localDateKey());
  const [paymentSaving, setPaymentSaving] = useState(false);
  const customerSectionRef = useRef<HTMLElement | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [billingOpen, setBillingOpen] = useState(false);
  const [salesBillingOpen, setSalesBillingOpen] = useState(false);
  const [salesBillingTab, setSalesBillingTab] = useState<BillingTab>("invoice");
  const [billingRefreshKey, setBillingRefreshKey] = useState(0);
  const [billing, setBilling] = useState<BillingData | null>(null);
  const [billingLoading, setBillingLoading] = useState(false);
  const [billingMessage, setBillingMessage] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>({ userEmail: user.email, businessName: user.displayName, phone: "", updatedAt: 0 });
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [paymentAccount, setPaymentAccount] = useState<PaymentAccountSummary>({ mode: "test", routeEnabled: false, status: "pending", providerAccountId: "" });
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminOverview, setAdminOverview] = useState<AdminOverview | null>(null);
  const [paymentReviewBusy, setPaymentReviewBusy] = useState<string | null>(null);
  const [paymentReviewMessage, setPaymentReviewMessage] = useState("");
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [adminPaymentSavingId, setAdminPaymentSavingId] = useState<number | null>(null);
  const [adminVerificationSavingId, setAdminVerificationSavingId] = useState<number | null>(null);
  const [adminSearch, setAdminSearch] = useState("");
  const [adminQuery, setAdminQuery] = useState("");
  const [adminFilter, setAdminFilter] = useState<AdminBusinessFilter>("all");
  const [adminPage, setAdminPage] = useState(1);
  const [deleteAccountPassword, setDeleteAccountPassword] = useState("");
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [contactPickerAvailable, setContactPickerAvailable] = useState(false);
  const [contactPickerError, setContactPickerError] = useState("");
  const [formError, setFormError] = useState("");
  const [duplicateCustomer, setDuplicateCustomer] = useState<Customer | null>(null);
  const [isNativeApp, setIsNativeApp] = useState(false);

  useEffect(() => {
    const contactNavigator = navigator as ContactPickerNavigator;
    setContactPickerAvailable(Boolean(androidBridge() || contactNavigator.contacts?.select));
    const handleNativeContact = (event: Event) => {
      const detail = (event as CustomEvent<{ name?: string; phone?: string }>).detail;
      const phone = detail?.phone?.trim() || "";
      if (!phone) {
        setContactPickerError("The selected contact does not have a phone number.");
        return;
      }
      setForm((current) => ({ ...current, name: detail?.name?.trim() || current.name, phone }));
      setDuplicateCustomer(null);
      setContactPickerError("");
    };
    const handleNativeContactError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      setContactPickerError(detail?.message || "Contact could not be opened. You can enter the details manually.");
    };
    window.addEventListener("yaadrakho-native-contact", handleNativeContact);
    window.addEventListener("yaadrakho-native-contact-error", handleNativeContactError);
    try {
      const saved = JSON.parse(localStorage.getItem("yaadrakho-extra-reminder-times") || "[]");
      if (Array.isArray(saved)) setExtraReminderTimes(saved.map(String).filter((time) => ["09", "12", "15", "18", "21"].includes(time)));
    } catch {
      localStorage.removeItem("yaadrakho-extra-reminder-times");
    }
    return () => {
      window.removeEventListener("yaadrakho-native-contact", handleNativeContact);
      window.removeEventListener("yaadrakho-native-contact-error", handleNativeContactError);
    };
  }, []);


  async function loadCustomers() {
    try {
      setError("");
      const response = await fetch("/api/customers", { cache: "no-store" });
      const data = (await response.json()) as { customers?: Customer[]; stats?: LedgerStats; error?: string };
      if (!response.ok) throw new Error(data.error || "Customers could not be loaded");
      const loadedCustomers = (data.customers || []).map((customer) => normalizeCustomer(customer));
      setCustomers(loadedCustomers);
      if (data.stats) setStats(data.stats);
      if (!reminderLinkHandled.current) {
        reminderLinkHandled.current = true;
        const target = reminderCustomer(window.location.search, loadedCustomers);
        if (target.requested) {
          const cleanUrl = new URL(window.location.href);
          cleanUrl.searchParams.delete("customer");
          window.history.replaceState(window.history.state, "", cleanUrl);
          if (target.customer) await openPaymentHistory(target.customer);
          else setError("This reminder's customer is no longer available in this business.");
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCustomers();
    void loadBilling();
    void loadSettings();
    // Initial dashboard load only; subsequent refreshes are triggered by user actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadSettings() {
    try {
      const response = await fetch("/api/settings", { cache: "no-store" });
      const data = (await response.json()) as { settings?: AppSettings; paymentAccount?: PaymentAccountSummary; error?: string };
      if (!response.ok || !data.settings) throw new Error(data.error || "Settings could not be loaded");
      setSettings(data.settings);
      if (data.paymentAccount) setPaymentAccount(data.paymentAccount);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Settings could not be loaded");
    }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    setSettingsSaving(true);
    setSettingsMessage("");
    try {
      const response = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
      const data = (await response.json()) as { settings?: AppSettings; error?: string };
      if (!response.ok || !data.settings) throw new Error(data.error || "Settings could not be saved");
      setSettings(data.settings);
      setSettingsMessage("Account settings saved.");
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : "Settings could not be saved");
    } finally {
      setSettingsSaving(false);
    }
  }

  async function disableReminders() {
    setReminderBusy("disable");
    const native = androidBridge();
    if (native) {
      native.syncReminders(JSON.stringify({ times: [], customers: [] }));
      localStorage.setItem("yaadrakho-reminders", "off");
      setRemindersEnabled(false);
      setReminderBusy(null);
      setSettingsMessage("Native alarm reminders are off.");
      return;
    }
    try {
      const registration = await existingReminderRegistration(navigator.serviceWorker);
      const subscription = registration ? await withTimeout(registration.pushManager.getSubscription(), 10_000, "Reminder status timed out. Try again.") : null;
      if (subscription) {
        const response = await fetch("/api/push", {
          signal: AbortSignal.timeout(10_000),
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        if (!response.ok) throw new Error("Reminders could not be turned off. Please try again.");
        await withTimeout(subscription.unsubscribe(), 10_000, "Device unsubscribe timed out. Try again.");
      }
      localStorage.setItem("yaadrakho-reminders", "off");
      setRemindersEnabled(false);
      setSettingsMessage("Automatic reminders are off on this device.");
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : "Reminders could not be turned off.");
    } finally {
      setReminderBusy(null);
    }
  }

  async function resetCustomerData() {
    if (!window.confirm("Permanently delete all customers from your account? This cannot be undone.")) return;
    try {
      const response = await fetch("/api/customers", { method: "DELETE" });
      if (!response.ok) throw new Error("Customer data could not be reset");
      setCustomers([]);
      setSettingsMessage("All customer data has been deleted.");
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : "Customer data could not be reset");
    }
  }

  async function signOut() {
    await disableReminders().catch(() => undefined);
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  }

  async function loadBilling() {
    try {
      const response = await fetch("/api/billing", { cache: "no-store" });
      const data = (await response.json()) as BillingData & { error?: string };
      if (!response.ok) throw new Error(data.error || "Billing could not be loaded");
      setBilling(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Billing could not be loaded");
    }
  }

  async function requestPlan(plan: "starter" | "pro") {
    setBillingLoading(true);
    setBillingMessage("");
    try {
      const response = await fetch("/api/billing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const data = (await response.json()) as { subscription?: Subscription; error?: string };
      if (!response.ok || !data.subscription) throw new Error(data.error || "Plan request could not be saved");
      setBilling((current) => current ? { ...current, subscription: data.subscription! } : current);
      setBillingMessage(`Your ${plan === "starter" ? "Starter" : "Pro"} request is saved. Pay by UPI or Paytm, then contact the owner for activation.`);
    } catch (err) {
      setBillingMessage(err instanceof Error ? err.message : "Plan request could not be saved");
    } finally {
      setBillingLoading(false);
    }
  }

  async function activatePlan(id: number) {
    setBillingLoading(true);
    try {
      const response = await fetch("/api/billing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || "Plan could not be activated");
      await loadBilling();
    } catch (err) {
      setBillingMessage(err instanceof Error ? err.message : "Plan could not be activated");
    } finally {
      setBillingLoading(false);
    }
  }

  useEffect(() => {
    const native = androidBridge();
    if (native) {
      setIsNativeApp(true);
      setNotificationPermission("granted");
      setRemindersEnabled(localStorage.getItem("yaadrakho-reminders") === "on");
      setReminderStatusReady(true);
      return;
    }
    if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setNotificationPermission("unsupported");
      setRemindersEnabled(false);
      setReminderStatusReady(true);
      return;
    }
    setNotificationPermission(Notification.permission);
    void existingReminderRegistration(navigator.serviceWorker).then(async (registration) => {
      if (!registration?.active) { setRemindersEnabled(false); return; }
      const subscription = await withTimeout(registration.pushManager.getSubscription(), 10_000, "Reminder subscription check timed out.");
      const locallyEnabled = Notification.permission === "granted" && Boolean(registration.active) && Boolean(subscription) && localStorage.getItem("yaadrakho-reminders") === "on";
      if (locallyEnabled && subscription) {
        const response = await fetch("/api/push", {
          signal: AbortSignal.timeout(10_000),
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(subscriptionPayload(subscription)),
        });
        setRemindersEnabled(response.ok);
        if (!response.ok) localStorage.setItem("yaadrakho-reminders", "off");
        return;
      }
      setRemindersEnabled(false);
    }).catch((err) => {
      console.error("YaadRakho service worker readiness failed", err);
      setRemindersEnabled(false);
    }).finally(() => {
      setReminderStatusReady(true);
    });
  }, []);

  async function enableReminders() {
    setSettingsMessage("");
    setReminderBusy("enable");
    const native = androidBridge();
    if (native) {
      native.requestAlarmPermission();
      localStorage.setItem("yaadrakho-reminders", "on");
      setNotificationPermission("granted");
      setRemindersEnabled(true);
      syncNativeReminders(customers, extraReminderTimes);
      setSettingsMessage("Native alarms are active. Allow Alarms & reminders when Android asks.");
      setReminderBusy(null);
      return;
    }
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setNotificationPermission("unsupported");
      setSettingsMessage("This browser does not support background notifications.");
      setReminderBusy(null);
      return;
    }
    try {
      const permission = Notification.permission === "default"
        ? await withTimeout(
          Notification.requestPermission(),
          15_000,
          "Chrome did not finish the notification request. Click the lock icon → Site settings → Notifications → Allow, reload, then tap Turn on again.",
        )
        : Notification.permission;
      setNotificationPermission(permission);
      if (permission === "denied") {
        throw new Error("Notifications are blocked. Chrome → Site settings → Notifications → Allow");
      }
      if (permission !== "granted") throw new Error("Notification permission was not given. Tap Turn on and choose Allow.");
      const registered = await withTimeout(
        navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }),
        15_000,
        "YaadRakho service worker registration timed out. Reload the app and try again.",
      );
      void registered.update().catch((error) => console.error("YaadRakho service worker update failed", error));
      const registration = registered.active ? registered : await withTimeout(
        navigator.serviceWorker.ready,
        15_000,
        "YaadRakho service worker did not become active. Reload the app and try again.",
      );
      if (!registration.active) throw new Error("YaadRakho service worker is not active. Reload the app and try again.");
      const configResponse = await fetch("/api/push", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      const config = await configResponse.json() as { publicKey?: string; error?: string };
      if (!configResponse.ok || !config.publicKey) throw new Error(config.error || "Background reminders are unavailable");
      const subscription = await withTimeout(registration.pushManager.getSubscription(), 10_000, "Reminder subscription check timed out.") || await withTimeout(
        registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(config.publicKey),
        }),
        20_000,
        "Chrome could not create the reminder subscription. Reload the app and try again.",
      );
      const saveResponse = await fetch("/api/push", {
        signal: AbortSignal.timeout(10_000),
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscriptionPayload(subscription)),
      });
      const saved = await saveResponse.json().catch(() => ({})) as { error?: string };
      if (!saveResponse.ok) throw new Error(saved.error || "Background reminders could not be enabled");
      await registration.showNotification("YaadRakho reminders enabled", {
        body: "Datewise payment reminders will appear on this device.",
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        tag: "yaadrakho-enabled",
        data: { url: "/" },
      });
      localStorage.setItem("yaadrakho-reminders", "on");
      setRemindersEnabled(true);
      playReminderTone();
      setError("");
      setSettingsMessage("Background reminders are active. Pending and overdue payment dates will appear in notifications.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Background reminders could not be enabled";
      console.error("YaadRakho reminder setup failed", err);
      localStorage.setItem("yaadrakho-reminders", "off");
      setRemindersEnabled(false);
      setSettingsMessage(message);
    } finally {
      setReminderBusy(null);
    }
  }

  async function loadAdminOverview(overrides: { page?: number; query?: string; filter?: AdminBusinessFilter } = {}) {
    if (!isAdmin) return;
    setAdminLoading(true);
    setAdminError("");
    try {
      const requestedPage = overrides.page ?? adminPage;
      const requestedQuery = overrides.query ?? adminQuery;
      const requestedFilter = overrides.filter ?? adminFilter;
      const params = new URLSearchParams({
        page: String(requestedPage),
        pageSize: "20",
        filter: requestedFilter,
      });
      if (requestedQuery) params.set("q", requestedQuery);
      const response = await fetch(`/api/admin/overview?${params.toString()}`, { cache: "no-store", credentials: "same-origin" });
      const data = (await response.json()) as AdminOverview & { error?: string };
      if (!response.ok) throw new Error(data.error || "Owner dashboard could not be loaded");
      setAdminOverview(data);
    } catch (err) {
      setAdminError(err instanceof Error ? err.message : "Owner dashboard could not be loaded");
    } finally {
      setAdminLoading(false);
    }
  }
  async function recheckPayment(paymentId: string, localOrderId?: number) {
    setPaymentReviewBusy(paymentId); setAdminError(""); setPaymentReviewMessage("");
    try {
      const response = await fetch("/api/admin/payment-review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(localOrderId ? { action: "recover_order", localOrderId } : { paymentId }) });
      const result = await response.json() as { paid?: boolean; message?: string; error?: string };
      if (!response.ok) throw new Error(result.error || "Payment could not be rechecked");
      await loadAdminOverview();
      setPaymentReviewMessage(result.message || (result.paid ? "Payment verified and the ledger is up to date." : "Payment still needs manual reconciliation."));
    } catch (error) { setAdminError(error instanceof Error ? error.message : "Payment could not be rechecked"); }
    finally { setPaymentReviewBusy(null); }
  }

  async function reconcileRefund(event: FormEvent<HTMLFormElement>, paymentId: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPaymentReviewBusy(paymentId); setAdminError(""); setPaymentReviewMessage("");
    try {
      const response = await fetch("/api/admin/payment-review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reconcile_refund", paymentId, refundId: data.get("refundId"), note: data.get("note") }) });
      const result = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(result.error || "Refund evidence could not be verified");
      await loadAdminOverview(); setPaymentReviewMessage(result.message || "Reconciliation recorded.");
    } catch (error) { setAdminError(error instanceof Error ? error.message : "Reconciliation failed"); }
    finally { setPaymentReviewBusy(null); }
  }

  async function saveBusinessPaymentAccount(event: FormEvent<HTMLFormElement>, ownerUserId: number) {
    event.preventDefault();
    setAdminPaymentSavingId(ownerUserId);
    setAdminError("");
    try {
      const formData = new FormData(event.currentTarget);
      const response = await fetch("/api/admin/payment-account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerUserId,
          providerAccountId: formData.get("providerAccountId"),
          status: formData.get("status"),
        }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Payment account could not be saved");
      await loadAdminOverview();
    } catch (err) {
      setAdminError(err instanceof Error ? err.message : "Payment account could not be saved");
    } finally {
      setAdminPaymentSavingId(null);
    }
  }

  async function approvePreviewBusiness(userId: number) {
    setAdminVerificationSavingId(userId);
    setAdminError("");
    try {
      const response = await fetch("/api/admin/verify-business", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Preview business could not be approved");
      await loadAdminOverview();
    } catch (err) {
      setAdminError(err instanceof Error ? err.message : "Preview business could not be approved");
    } finally {
      setAdminVerificationSavingId(null);
    }
  }

  function openAdminOverview() {
    setAdminOpen(true);
    setAdminPage(1);
    void loadAdminOverview({ page: 1 });
  }

  async function removeAccount() {
    setSettingsMessage("");
    if (!deleteAccountPassword) {
      setSettingsMessage("Enter your password before deleting the account.");
      return;
    }
    if (!window.confirm("Permanently delete your YaadRakho account and all customer data? This cannot be undone.")) return;
    setDeletingAccount(true);
    try {
      const response = await fetch("/api/auth/account", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: deleteAccountPassword }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Account could not be deleted.");
      await disableReminders().catch(() => undefined);
      window.location.href = "/login";
    } catch (caught) {
      setSettingsMessage(caught instanceof Error ? caught.message : "Account could not be deleted.");
      setDeletingAccount(false);
    }
  }

  async function toggleExtraReminder(time: string) {
    const next = extraReminderTimes.includes(time)
      ? extraReminderTimes.filter((item) => item !== time)
      : [...extraReminderTimes, time].sort();
    if (reminderBusy !== null) return;
    const saveTimes = () => { localStorage.setItem("yaadrakho-extra-reminder-times", JSON.stringify(next)); setExtraReminderTimes(next); };
    const native = androidBridge();
    if (native) {
      if (remindersEnabled) syncNativeReminders(customers, next);
      saveTimes();
      setSettingsMessage(!remindersEnabled ? "Alarm times saved. Turn on automatic reminders to activate them." : next.length ? "Alarm times saved. Regular reminders remain enabled." : "Extra alarm sounds are off. Regular reminders remain enabled.");
      return;
    }
    if (!remindersEnabled) {
      saveTimes();
      setSettingsMessage("Extra reminder times saved. Turn on automatic reminders to activate them.");
      return;
    }
    setReminderBusy("times");
    try {
      const registration = await readyReminderRegistration(navigator.serviceWorker);
      const subscription = await withTimeout(registration.pushManager.getSubscription(), 10_000, "Reminder subscription check timed out.");
      if (!subscription) throw new Error("Turn on automatic reminders first.");
      const response = await fetch("/api/push", {
        signal: AbortSignal.timeout(10_000),
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscriptionPayload(subscription, next)),
      });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error || "Extra reminder times could not be saved");
      saveTimes();
      setSettingsMessage(next.length ? "Extra sound-notification times saved." : "Extra times are off. Regular automatic reminders remain enabled.");
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : "Extra reminder times could not be saved");
    } finally { setReminderBusy(null); }
  }

  const today = localDateKey();

  function syncNativeReminders(customerList: Customer[], times: string[]) {
    const native = androidBridge();
    if (!native || localStorage.getItem("yaadrakho-reminders") !== "on") return;
    native.syncReminders(JSON.stringify({
      times,
      customers: customerList
        .filter((customer) => customer.paymentStatus !== "paid" && !["won", "lost"].includes(customer.status))
        .map((customer) => ({
          id: customer.id,
          name: customer.name,
          amount: customer.outstandingAmount,
          dueDate: customer.followUpDate,
          requirement: customer.requirement,
        })),
    }));
  }

  useEffect(() => {
    syncNativeReminders(customers, extraReminderTimes);
  }, [customers, extraReminderTimes]);
  const visibleCustomers = useMemo(() => {
    const search = query.trim().toLowerCase();
    return customers.filter((item) => {
      const matchesSearch = !search || [item.name, item.phone, item.requirement].some((value) => value.toLowerCase().includes(search));
      const matchesFilter =
        filter === "all" ||
        (filter === "today" && item.followUpDate === today && !["won", "lost"].includes(item.status)) ||
        (filter === "overdue" && item.followUpDate < today && !["won", "lost"].includes(item.status)) ||
        (filter === "monthly" && item.billingCycle === "monthly") ||
        (filter === "won" && item.status === "won");
      return matchesSearch && matchesFilter;
    });
  }, [customers, filter, query, today]);

  const directoryHeading = {
    all: "All customers",
    today: "Customers due today",
    overdue: "Overdue customers",
    monthly: "Monthly ledger",
    won: "Converted customers",
  }[filter];

  const directoryEyebrow = filter === "monthly" ? "Recurring payments" : "Customer directory";

  function openNewForm() {
    setEditingId(null);
    setForm({ ...emptyForm, followUpDate: today });
    setContactPickerError("");
    setFormError("");
    setDuplicateCustomer(null);
    setFormOpen(true);
  }

  async function testPushNotification() {
    setSettingsMessage("");
    setReminderBusy("test");
    try {
      const native = androidBridge();
      if (native) {
        native.testAlarm();
        setSettingsMessage("Native test alarm will ring in about 5 seconds. Use Stop alarm to silence it.");
        return;
      }
      if (!("Notification" in window) || !("serviceWorker" in navigator)) {
        setNotificationPermission("unsupported");
        throw new Error("This browser does not support service-worker notifications.");
      }
      const permission = Notification.permission === "default"
        ? await withTimeout(Notification.requestPermission(), 15_000, "Notification permission request timed out. Check this browser’s notification settings.")
        : Notification.permission;
      setNotificationPermission(permission);
      if (permission === "denied") {
        throw new Error("Notifications are blocked. Chrome → Site settings → Notifications → Allow");
      }
      if (permission !== "granted") {
        throw new Error("Notification permission was not granted. Try the test again and choose Allow.");
      }
      const registration = await readyReminderRegistration(navigator.serviceWorker);
      if (!registration.active) throw new Error("YaadRakho service worker is not active. Reload the app and try again.");
      await registration.showNotification("YaadRakho reminder test", {
        body: "Notifications are working correctly.",
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        tag: "yaadrakho-test",
        data: { url: "/" },
      });
      setSettingsMessage("Test notification requested. Check your device notification panel. This tests display only; automatic background reminders need separate setup.");
    } catch (err) {
      console.error("YaadRakho test notification failed", err);
      setSettingsMessage(err instanceof Error ? err.message : "Test notification could not be displayed");
    } finally {
      setReminderBusy(null);
    }
  }

  async function showSavedCustomerReminder(customer: Customer) {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || Notification.permission !== "granted") return;
    if (customer.paymentStatus === "paid" || ["won", "lost"].includes(customer.status)) return;
    try {
      const registration = await readyReminderRegistration(navigator.serviceWorker);
      const isDue = customer.followUpDate <= localDateKey();
      await registration.showNotification(isDue ? "YaadRakho Payment Reminder" : `Reminder set for ${dateLabel(customer.followUpDate)}`, {
        body: `${customer.name} · ${moneyLabel(customer.outstandingAmount)} · Due date: ${dateLabel(customer.followUpDate)}${customer.requirement ? ` · ${customer.requirement}` : ""}`,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        tag: `yaadrakho-customer-${customer.id}`,
        requireInteraction: isDue,
        data: { url: `/?customer=${customer.id}`, customerId: customer.id },
      });
    } catch (err) {
      console.error("YaadRakho saved-customer notification failed", err);
    }
  }

  async function closeCustomerReminder(customerId: number) {
    androidBridge()?.cancelCustomerReminder(String(customerId));
    if (!("serviceWorker" in navigator)) return;
    try {
      const registration = await readyReminderRegistration(navigator.serviceWorker);
      const notifications = await registration.getNotifications();
      notifications.filter(notification => notification.tag === `yaadrakho-customer-${customerId}` || Number(notification.data?.customerId) === customerId).forEach((notification) => notification.close());
      registration.active?.postMessage({ type: "CLOSE_CUSTOMER_REMINDER", customerId });
    } catch (err) {
      console.error("YaadRakho reminder close failed", err);
    }
  }

  function openEditForm(customer: Customer) {
    setEditingId(customer.id);
    setForm({
      name: customer.name,
      phone: customer.phone,
      requirement: customer.requirement,
      amount: customer.amount,
      followUpDate: customer.followUpDate,
      status: customer.status,
      paymentStatus: customer.paymentStatus,
      billingCycle: customer.billingCycle,
      notes: customer.notes,
      contactConsent: customer.contactConsent,
    });
    setContactPickerError("");
    setFormError("");
    setDuplicateCustomer(null);
    setFormOpen(true);
  }

  async function choosePhoneContact() {
    setContactPickerError("");
    try {
      const native = androidBridge();
      if (native) {
        native.pickContact();
        return;
      }
      const contactNavigator = navigator as ContactPickerNavigator;
      if (!contactNavigator.contacts?.select) {
        setContactPickerError("Contact selection is not supported on this device. Enter the details manually.");
        return;
      }
      const [contact] = await contactNavigator.contacts.select(["name", "tel"], { multiple: false });
      if (!contact) return;
      const name = contact.name?.[0]?.trim() || "";
      const phone = contact.tel?.[0]?.trim() || "";
      if (!phone) {
        setContactPickerError("The selected contact does not have a phone number.");
        return;
      }
      setForm((current) => ({ ...current, name: name || current.name, phone }));
      setDuplicateCustomer(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setContactPickerError("Contact could not be opened. You can enter the name and number manually.");
    }
  }

  async function saveCustomer(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setFormError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(editingId ? `/api/customers/${editingId}` : "/api/customers", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(form),
        signal: controller.signal,
      });
      const responseType = response.headers.get("content-type") || "";
      const responseBody = await response.text();
      let data: { customer?: Customer; duplicateCustomer?: Customer; error?: string } = {};
      if (responseType.includes("application/json")) {
        try {
          data = JSON.parse(responseBody) as { customer?: Customer; duplicateCustomer?: Customer; error?: string };
        } catch {
          throw new Error("Customer could not be saved. Please try again.");
        }
      } else {
        throw new Error("Customer could not be saved. Please try again.");
      }
      if (!response.ok || !data.customer) {
        if (response.status === 409 && data.duplicateCustomer) {
          setDuplicateCustomer(normalizeCustomer(data.duplicateCustomer));
          setFormError(data.error || "This customer already exists.");
          return;
        }
        if (response.status === 402) setBillingOpen(true);
        if (response.status === 401) throw new Error("Your session has ended. Sign out, then sign in again.");
        throw new Error(data.error || "Customer could not be saved");
      }
      const savedCustomer = normalizeCustomer(data.customer);
      setCustomers((current) =>
        editingId
          ? current.map((item) => (item.id === editingId ? savedCustomer : item))
          : [savedCustomer, ...current],
      );
      setError("");
      setFormError("");
      setDuplicateCustomer(null);
      setFormOpen(false);
      void loadCustomers();
      if (savedCustomer.paymentStatus === "paid" || ["won", "lost"].includes(savedCustomer.status)) {
        setSuccessMessage(`${savedCustomer.name} saved successfully. Its reminder was removed.`);
        void closeCustomerReminder(savedCustomer.id);
      } else {
        setSuccessMessage(`${savedCustomer.name} saved successfully. Reminder set for ${dateLabel(savedCustomer.followUpDate)}.`);
        void showSavedCustomerReminder(savedCustomer);
      }
    } catch (err) {
      const message = err instanceof DOMException && err.name === "AbortError"
        ? "Saving took too long. Check your connection and tap Save customer again."
        : err instanceof Error ? err.message : "Customer could not be saved. Please try again.";
      setFormError(message);
    } finally {
      window.clearTimeout(timeout);
      setSaving(false);
    }
  }

  async function markWon(customer: Customer) {
    await markMonthlyPaid(customer);
  }

  function selectCustomerFilter(nextFilter: typeof filter) {
    setFilter(nextFilter);
    window.requestAnimationFrame(() => {
      customerSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function markMonthlyPaid(customer: Customer) {
    if (convertingId !== null) return;
    if (customer.outstandingAmount > 0) {
      await openPaymentHistory(customer);
      return;
    }
    if (!window.confirm('Mark this customer converted?')) return;
    setConvertingId(customer.id);
    try {
      if (customer.outstandingAmount <= 0) {
        const response = await fetch(`/api/customers/${customer.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "won", paymentStatus: "paid" }) });
        const data = await response.json() as { customer?: Customer; error?: string };
        if (!response.ok || !data.customer) throw new Error(data.error || "Customer could not be updated");
        setCustomers((current) => current.map((item) => item.id === customer.id ? normalizeCustomer(data.customer!) : item));
        setSuccessMessage(`${customer.name} marked converted successfully.`);
        void closeCustomerReminder(customer.id);
        void loadCustomers();
        return;
      }

    } catch (err) {
      setError(err instanceof Error ? err.message : "Monthly payment could not be recorded");
    } finally {
      setConvertingId(null);
    }
  }

  async function openPaymentHistory(customer: Customer) {
    setHistoryCustomer(customer);
    setPaymentHistory([]);
    setPaymentTransactions([]);
    setPaymentDueId(null);
    setPaymentAmount(0);
    setPaymentReference("");
    setPaymentDate(localDateKey());
    setHistoryLoading(true);
    try {
      const response = await fetch(`/api/customers/${customer.id}/payments`, { cache: "no-store" });
      const data = await response.json() as { currentDueId?: number | null; dues?: PaymentDue[]; transactions?: PaymentTransaction[]; error?: string };
      if (!response.ok) throw new Error(data.error || "Payment history could not be loaded");
      const dues = data.dues || [];
      const selectedDue = selectOpenPaymentDue(dues, data.currentDueId);
      setPaymentHistory(dues);
      setPaymentTransactions(data.transactions || []);
      setPaymentDueId(selectedDue?.id || null);
      setPaymentAmount(paymentDueRemaining(selectedDue));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment history could not be loaded");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function saveLedgerPayment(event: FormEvent) {
    event.preventDefault();
    if (!historyCustomer || paymentSaving) return;
    const selectedDue = paymentHistory.find((due) => due.id === paymentDueId);
    if (!selectedDue) {
      setError("Select the bill or due receiving this payment.");
      return;
    }
    setPaymentSaving(true);
    try {
      const fingerprint = JSON.stringify([historyCustomer.id, selectedDue.id, paymentAmount, paymentMethod, paymentReference, paymentDate]);
      if (paymentAttempt.current?.fingerprint !== fingerprint) {
        paymentAttempt.current = { fingerprint, key: crypto.randomUUID(), receivedAt: paymentReceivedAt(paymentDate) };
      }
      const response = await fetch(`/api/customers/${historyCustomer.id}/payments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: paymentAmount, method: paymentMethod, reference: paymentReference, receivedAt: paymentAttempt.current.receivedAt, dueId: selectedDue.id, expectedDueDate: selectedDue.dueDate, idempotencyKey: paymentAttempt.current.key }),
      });
      const data = await response.json() as { paymentId?: number; customer?: Customer; currentDueId?: number | null; dues?: PaymentDue[]; transactions?: PaymentTransaction[]; stats?: LedgerStats; error?: string };
      if (!response.ok || !data.customer) throw new Error(data.error || "Payment could not be recorded");
      const saved = normalizeCustomer(data.customer);
      const dues = data.dues || [];
      const nextSelectedDue = selectOpenPaymentDue(dues, data.currentDueId);
      setCustomers((current) => current.map((item) => item.id === saved.id ? saved : item));
      setHistoryCustomer(saved);
      setPaymentHistory(dues);
      setPaymentTransactions(data.transactions || []);
      setPaymentDueId(nextSelectedDue?.id || null);
      setPaymentAmount(paymentDueRemaining(nextSelectedDue));
      if (data.stats) setStats(data.stats);
      const receipt = (data.transactions || []).find(entry => entry.id === data.paymentId);
      paymentAttempt.current = null;
      setPaymentReference("");
      setPaymentDate(localDateKey());
      setSuccessMessage(`${moneyLabel(paymentAmount)} payment recorded for ${saved.name}.${receipt?.receiptNumber ? ` Receipt ${receipt.receiptNumber} is ready.` : ""}`);
      if (saved.paymentStatus === "paid") void closeCustomerReminder(saved.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment could not be recorded");
    } finally {
      setPaymentSaving(false);
    }
  }

  async function sharePaymentReceipt(entry: PaymentTransaction) {
    const popup = window.open("about:blank", "_blank");
    try {
      const response = await fetch(`/api/receipts/${entry.id}`, { method: "POST" });
      const data = await response.json() as { whatsappUrl?: string; error?: string };
      if (!response.ok || !data.whatsappUrl) throw new Error(data.error || "Receipt could not be prepared");
      if (popup) popup.location.href = data.whatsappUrl; else window.open(data.whatsappUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      popup?.close();
      setError(err instanceof Error ? err.message : "Receipt could not be prepared");
    }
  }

  async function removeCustomer(customer: Customer) {
    if (!window.confirm(`Delete ${customer.name}?`)) return;
    if (deletingId !== null) return;
    setDeletingId(customer.id);
    try {
      const response = await fetch(`/api/customers/${customer.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Customer could not be deleted");
      setCustomers((current) => current.filter((item) => item.id !== customer.id));
      void loadCustomers();
      void closeCustomerReminder(customer.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Customer could not be deleted");
    } finally {
      setDeletingId(null);
    }
  }

  const openPaymentDues = paymentHistory.filter((due) => due.status !== "paid" && paymentDueRemaining(due) > 0);
  const selectedPaymentDue = openPaymentDues.find((due) => due.id === paymentDueId) || null;
  const selectedDueRemaining = paymentDueRemaining(selectedPaymentDue);

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="YaadRakho home">
          <span className="brand-mark">Y</span>
          <span><strong>YaadRakho</strong><small>Smart Payment Reminders</small></span>
        </a>
        <div className={`top-actions ${isAdmin ? "owner-actions" : ""}`}>
          <div className="account-chip"><span>{(settings.businessName || user.displayName).charAt(0).toUpperCase()}</span><div><strong>{settings.businessName || user.displayName}</strong><small>{user.email}</small></div></div>
          {isAdmin && <button className="owner-dashboard-button" onClick={openAdminOverview}>Owner dashboard</button>}
          <button className="sales-billing-button" onClick={() => { setSalesBillingTab("invoice"); setSalesBillingOpen(true); }}>▤ Bills</button>
          <button className="settings-button" onClick={() => setSettingsOpen(true)}>⚙ Settings</button>
          <button className="plan-button" onClick={() => setBillingOpen(true)}><small>{billing?.subscription.status === "pending" ? "Payment pending" : "Current plan"}</small><strong>{billing ? billing.subscription.plan === "trial" ? "Free Access" : `${billing.subscription.plan.charAt(0).toUpperCase()}${billing.subscription.plan.slice(1)}` : "Billing"}</strong></button>
          <button className="primary-button" onClick={openNewForm}>+ Add customer</button>
        </div>
      </header>

      <section className={`reminder-bar ${reminderStatusReady && remindersEnabled ? "enabled" : ""}`}>
        <div><span className="reminder-dot" /><strong>{!reminderStatusReady ? "Checking reminder status…" : remindersEnabled ? "Automatic reminders are on" : "Enable follow-up notifications"}</strong><small>{!reminderStatusReady ? "Confirming notification permission and saved device subscription." : remindersEnabled ? (isNativeApp ? "2-hour popups and selected-time alarms work even when the app is closed." : "Pending and overdue payments are reminded with their due date, even when the app is closed.") : notificationStatusMessage(notificationPermission, remindersEnabled)}</small></div>
        <div className="reminder-controls"><button onClick={() => setRemindersOpen(true)}>Reminder settings</button><span className="reminder-status">{!reminderStatusReady ? "…" : remindersEnabled ? "ON" : "OFF"}</span></div>
      </section>

      <section className="hero" id="top">
        <div>
          <span className="eyebrow">Today&apos;s priorities</span>
          <h1>Remember every lead.<br /><em>Capture every sale.</em></h1>
          <p>Manage customer details, follow-ups, and payments in one simple place.</p>
        </div>
        <button className="hero-action" onClick={() => selectCustomerFilter("today")}>
          <span>{stats.today}</span>
          <strong>Follow-ups today</strong>
          <small>View list →</small>
        </button>
      </section>

      <section className="stat-grid" aria-label="Business summary">
        {[
          { key: "all", label: "Total customers", value: stats.total, className: "navy", icon: "●●" },
          { key: "today", label: "Due today", value: stats.today, className: "yellow", icon: "□" },
          { key: "overdue", label: "Overdue", value: stats.overdue, className: "coral", icon: "◷" },
          { key: "monthly", label: "Monthly customers", value: stats.monthly, className: "blue", icon: "↻" },
          { key: "won", label: "Converted", value: stats.won, className: "mint", icon: "✓" },
        ].map((card) => (
          <button key={card.key} className={`stat-card ${card.className} ${filter === card.key ? "active" : ""}`} onClick={() => selectCustomerFilter(card.key as typeof filter)}>
            <span className="stat-icon" aria-hidden="true">{card.icon}</span><span className="stat-label">{card.label}</span><strong>{card.value}</strong><small>View all →</small>
          </button>
        ))}
      </section>

      <BillingDashboardPanel key={billingRefreshKey} onOpen={(tab) => { setSalesBillingTab(tab); setSalesBillingOpen(true); }} />

      <section className="customer-section" ref={customerSectionRef}>
        <div className="section-heading">
          <div><span className="eyebrow">{directoryEyebrow}</span><h2>{directoryHeading}</h2><p className="directory-subtitle">Manage and track all your customers in one place.</p></div>
          <label className="search-box">
            <span aria-hidden="true">⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name or phone" aria-label="Search customers" />
          </label>
        </div>

        <div className="filter-row" aria-label="Customer filters">
          {[
            ["all", "All"], ["today", "Today"], ["overdue", "Overdue"], ["monthly", "Monthly"], ["won", "Converted"],
          ].map(([key, label]) => <button key={key} className={filter === key ? "selected" : ""} onClick={() => setFilter(key as typeof filter)}>{label}</button>)}
        </div>

        {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError("")}>×</button></div>}
        {successMessage && <div className="success-banner" role="status">{successMessage}<button onClick={() => setSuccessMessage("")}>×</button></div>}

        {loading ? (
          <div className="empty-state"><span className="loader" />Loading customers…</div>
        ) : visibleCustomers.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">✓</span>
            <h3>{filter === "monthly" ? "No monthly customers found" : "No customers found"}</h3>
            <p>{filter === "monthly" ? "Add a customer and choose Monthly recurring payment." : "Add a customer or choose a different filter."}</p>
            {filter === "all"
              ? <button className="primary-button" onClick={openNewForm}>+ Add customer</button>
              : <button className="primary-button" onClick={() => selectCustomerFilter("all")}>View all customers</button>}
          </div>
        ) : (
          <div className="customer-list">
            {visibleCustomers.map((customer) => {
              const isOverdue = customer.followUpDate < today && !["won", "lost"].includes(customer.status);
              const isToday = customer.followUpDate === today && !["won", "lost"].includes(customer.status);
              return (
                <article className="customer-card" key={customer.id}>
                  <div className="avatar" aria-hidden="true">{customer.name.charAt(0).toUpperCase()}</div>
                  <div className="customer-main">
                    <div className="customer-title"><h3>{customer.name}</h3><span className={`status ${customer.status}`}>{statusLabel[customer.status]}</span>{customer.billingCycle === "monthly" && <span className="monthly-badge">Monthly</span>}{customer.duplicateOfId && <span className="duplicate-badge">Duplicate</span>}</div>
                    <a className="phone" href={`tel:${customer.phone}`}>{customer.phone}</a>
                    <p>{customer.requirement || "No purpose or service added"}{customer.amount > 0 && <strong className="amount-text"> · {customer.paymentStatus === "paid" ? `${moneyLabel(customer.amount)} paid` : `${moneyLabel(customer.outstandingAmount)} pending`}</strong>}</p>
                  </div>
                  <div className={`follow-date ${isOverdue ? "overdue" : isToday ? "today" : ""}`}>
                    <small>{isOverdue ? "Overdue follow-up" : isToday ? "Due today" : "Next follow-up"}</small>
                    <strong>{dateLabel(customer.followUpDate)}</strong>
                    <span className={`payment ${customer.paymentStatus}`}>{paymentLabel[customer.paymentStatus]}</span>
                  </div>
                  <div className="card-actions">
                    <a className="contact-button call" href={`tel:${customer.phone}`} aria-label={`Call ${customer.name}`}>Call</a>
                    <a className={`contact-button sms ${customer.contactConsent ? "" : "disabled"}`} href={customer.contactConsent ? `sms:${customer.phone}?body=${encodeURIComponent(customerMessage(customer, settings.businessName || user.displayName))}` : undefined} aria-disabled={!customer.contactConsent} title={customer.contactConsent ? "Open SMS with a ready message" : "Record customer consent first"}>SMS</a>
                    <a className={`contact-button whatsapp ${customer.contactConsent ? "" : "disabled"}`} href={customer.contactConsent ? `https://wa.me/${whatsappNumber(customer.phone)}?text=${encodeURIComponent(customerMessage(customer, settings.businessName || user.displayName))}` : undefined} target="_blank" rel="noreferrer" aria-disabled={!customer.contactConsent} title={customer.contactConsent ? "Open WhatsApp with a ready message" : "Record customer consent first"}>WhatsApp</a>
                    <button className="icon-button" onClick={() => openEditForm(customer)} aria-label={`Edit ${customer.name}`}>✎</button>
                    <button className="history-button" onClick={() => void openPaymentHistory(customer)}>Payment ledger</button>
                    {customer.billingCycle === "monthly" ? <button className="won-button" disabled={convertingId !== null} onClick={() => markMonthlyPaid(customer)}>{convertingId === customer.id ? "Updating…" : "✓ Mark month paid"}</button> : customer.status !== "won" && <button className="won-button" disabled={convertingId !== null} onClick={() => markWon(customer)}>{convertingId === customer.id ? "Updating…" : "✓ Mark converted"}</button>}
                    <button className="delete-button" disabled={deletingId !== null} onClick={() => removeCustomer(customer)} aria-label={`Delete ${customer.name}`}>{deletingId === customer.id ? "…" : "×"}</button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {formOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setFormOpen(false)}>
          <section className="form-panel" role="dialog" aria-modal="true" aria-labelledby="form-title">
            <div className="form-header"><div><span className="eyebrow">Customer details</span><h2 id="form-title">{editingId ? "Edit customer" : "Add customer"}</h2></div><button onClick={() => setFormOpen(false)} aria-label="Close">×</button></div>
            <form onSubmit={saveCustomer}>
              <div className="contact-import-row">
                <div>
                  <strong>Already saved in your phone?</strong>
                  <small>{contactPickerAvailable ? "Open your contacts, search the name, and select it to fill both fields." : "On a supported Android phone, this opens your contacts and fills the name and number."}</small>
                </div>
                <button type="button" className="secondary-button" onClick={choosePhoneContact}>Select from phone contacts</button>
              </div>
              {contactPickerError && <div className="form-note error" role="alert">{contactPickerError}</div>}
              {formError && <div className={`form-note error ${duplicateCustomer ? "duplicate-customer-note" : ""}`} role="alert"><span>{formError}</span>{duplicateCustomer && <button type="button" className="secondary-button" onClick={() => { setFormOpen(false); void openPaymentHistory(duplicateCustomer); }}>Open existing customer</button>}</div>}
              <div className="field-grid">
                <label><span>Customer name *</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Example: Rohan Sharma" autoFocus /></label>
                <label><span>Phone number *</span><input required inputMode="tel" value={form.phone} onChange={(event) => { setForm({ ...form, phone: event.target.value }); setDuplicateCustomer(null); setFormError(""); }} placeholder="98765 43210" /></label>
              </div>
              <div className="field-grid">
                <label><span>Payment purpose or service</span><input value={form.requirement} onChange={(event) => setForm({ ...form, requirement: event.target.value })} placeholder="Example: Website service fee" /></label>
                <label><span>Amount (₹)</span><input type="number" min="0" step="1" value={form.amount || ""} onChange={(event) => setForm({ ...form, amount: Number(event.target.value) || 0 })} placeholder="15000" /></label>
              </div>
              <div className="field-grid">
                <label><span>Follow-up date *</span><input required type="date" value={form.followUpDate} onChange={(event) => setForm({ ...form, followUpDate: event.target.value })} /></label>
                <label><span>Customer status</span><select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as FormState["status"] })}>{Object.entries(statusLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
              </div>
              <div className="field-grid">
                <label><span>Payment frequency</span><select value={form.billingCycle} onChange={(event) => setForm({ ...form, billingCycle: event.target.value as FormState["billingCycle"], paymentStatus: event.target.value === "monthly" && form.paymentStatus === "paid" ? "pending" : form.paymentStatus, status: event.target.value === "monthly" && ["won", "lost"].includes(form.status) ? "follow_up" : form.status })}><option value="one_time">One-time payment</option><option value="monthly">Monthly recurring payment</option></select></label>
                <label><span>{form.billingCycle === "monthly" ? "Current month payment" : "Payment"}</span><select value={form.paymentStatus === "paid" ? "pending" : form.paymentStatus} onChange={(event) => setForm({ ...form, paymentStatus: event.target.value as FormState["paymentStatus"] })}>{Object.entries(paymentLabel).filter(([key]) => key !== "paid").map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
              </div>
              {form.billingCycle === "monthly" && <div className="form-note">Repeats every month on day {Number(form.followUpDate.slice(-2)) || 1}. Use “Mark month paid” to save this month and automatically create the next due date.</div>}
              <label><span>Notes</span><textarea rows={3} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Add details from your conversation" /></label>
              <label className="consent-check"><input type="checkbox" checked={form.contactConsent} onChange={(event) => setForm({ ...form, contactConsent: event.target.checked })} /><span>The customer has agreed to receive SMS, WhatsApp messages, and reminder calls.</span></label>
              <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setFormOpen(false)}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Saving…" : editingId ? "Save changes" : "Save customer"}</button></div>
            </form>
          </section>
        </div>
      )}

      {historyCustomer && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setHistoryCustomer(null)}>
          <section className="form-panel history-panel" role="dialog" aria-modal="true" aria-labelledby="history-title">
            <div className="form-header"><div><span className="eyebrow">Payment ledger</span><h2 id="history-title">{historyCustomer.name}</h2><p>Record partial or full payments. Remaining balance: {moneyLabel(historyCustomer.outstandingAmount)}.</p></div><button onClick={() => setHistoryCustomer(null)} aria-label="Close">×</button></div>
            {!historyLoading && selectedPaymentDue && <form className="ledger-payment-form" onSubmit={saveLedgerPayment}>
              {openPaymentDues.length > 1 && <label><span>Apply payment to</span><select value={paymentDueId || ""} onChange={(event) => { const dueId = Number(event.target.value); const due = openPaymentDues.find((item) => item.id === dueId) || null; setPaymentDueId(due?.id || null); setPaymentAmount(paymentDueRemaining(due)); }}>{openPaymentDues.map((due) => <option key={due.id} value={due.id}>{paymentPeriodLabel(due.periodKey)} · {moneyLabel(paymentDueRemaining(due))} remaining</option>)}</select></label>}
              <label><span>Amount received (₹)</span><input required type="number" min="1" max={selectedDueRemaining} step="1" value={paymentAmount || ""} onChange={(event) => setPaymentAmount(Number(event.target.value) || 0)} /></label>
              <label><span>Payment method</span><select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}><option value="upi">UPI</option><option value="paytm">Paytm</option><option value="cash">Cash</option><option value="bank">Bank transfer</option><option value="other">Other</option></select></label>
              <label><span>Payment date</span><input required type="date" max={localDateKey()} value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} /></label>
              <label><span>UTR / transaction reference (optional)</span><input value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} maxLength={100} placeholder="Example: UPI reference or cash note" /></label>
              <button className="primary-button" disabled={paymentSaving}>{paymentSaving ? "Saving…" : "Record payment & create receipt"}</button>
            </form>}
            {historyLoading ? <div className="empty-state"><span className="loader" />Loading payment history…</div> : <>
              <div className="payment-history-list">{paymentHistory.map((due) => <article key={due.id}><div><strong>{paymentPeriodLabel(due.periodKey)}</strong><small>Due {dateLabel(due.dueDate)} · Received {moneyLabel(due.amountPaid)} of {moneyLabel(due.amountDue)}</small></div><span>{due.status.toUpperCase()}</span></article>)}</div>
              {paymentTransactions.length > 0 && <div className="payment-history-list ledger-transactions"><h3>Transactions & receipts</h3>{paymentTransactions.map((entry) => <article key={entry.id} className="ledger-transaction"><div><strong>{moneyLabel(entry.amount)} · {entry.method.toUpperCase()}</strong><small>{new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(entry.receivedAt))}{entry.reference ? ` · Ref: ${entry.reference}` : ""}</small><small>{entry.receiptNumber || "Receipt preparing"} · Balance {moneyLabel(entry.balanceAfter)}</small></div><div className="receipt-row-actions">{entry.receiptToken && <a className="secondary-button" href={`/receipt/${entry.receiptToken}`} target="_blank" rel="noreferrer">View / Print</a>}<button type="button" className="whatsapp-receipt-button" onClick={() => void sharePaymentReceipt(entry)}>WhatsApp receipt</button></div></article>)}</div>}
            </>}
          </section>
        </div>
      )}

      {salesBillingOpen && <BillingCenter customers={customers} initialTab={salesBillingTab} onClose={() => setSalesBillingOpen(false)} onPaymentsUpdated={() => { setBillingRefreshKey((value) => value + 1); void loadCustomers(); }} />}

      {billingOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setBillingOpen(false)}>
          <section className="form-panel billing-panel" role="dialog" aria-modal="true" aria-labelledby="billing-title">
            <div className="form-header"><div><span className="eyebrow">Plans &amp; billing</span><h2 id="billing-title">Grow your customer follow-ups</h2></div><button onClick={() => setBillingOpen(false)} aria-label="Close">×</button></div>
            {billing && <div className="current-plan"><div><small>Current plan</small><strong>{billing.subscription.plan === "trial" ? "Free Early Access" : `${billing.subscription.plan.charAt(0).toUpperCase()}${billing.subscription.plan.slice(1)}`}</strong></div><span className="status-pill">FREE</span></div>}
            <div className="billing-grid">
              <article className="billing-plan"><span>Free Early Access</span><h3>₹0</h3><p>No trial expiry during development</p><button className="secondary-button" disabled>Active</button></article>
              {PAYMENTS_ENABLED && <><article className="billing-plan featured"><span>Starter</span><h3>₹299<small>/month</small></h3><p>Up to 100 customers</p><button className="primary-button" disabled={!PAYMENTS_ENABLED || billingLoading} onClick={() => requestPlan("starter")}>{PAYMENTS_ENABLED ? "Request Starter" : "Payments opening soon"}</button></article>
              <article className="billing-plan"><span>Pro</span><h3>₹599<small>/month</small></h3><p>Unlimited customers</p><button className="primary-button" disabled={!PAYMENTS_ENABLED || billingLoading} onClick={() => requestPlan("pro")}>{PAYMENTS_ENABLED ? "Request Pro" : "Payments opening soon"}</button></article></>}
            </div>
            <p className="billing-help">{PAYMENTS_ENABLED ? "Pay through your preferred UPI or Paytm method. The owner activates your plan after confirming the payment." : "YaadRakho is free during development. No payment is being collected; subscriptions will open only after the full automation and renewal system is ready."}</p>
            {billingMessage && <div className="billing-message">{billingMessage}</div>}
            {isAdmin && billing && (
              <section className="admin-queue">
                <div><span className="eyebrow">Owner revenue queue</span><h3>Payment requests</h3></div>
                {billing.requests.length === 0 ? <p>No pending plan requests.</p> : billing.requests.map((request) => (
                  <div className="request-row" key={request.id}><div><strong>{request.userEmail.replace(/^account:/, "")}</strong><span>{request.plan.toUpperCase()} · {moneyLabel(request.price)}</span></div><button className="primary-button" disabled={billingLoading} onClick={() => activatePlan(request.id)}>Confirm payment &amp; activate</button></div>
                ))}
              </section>
            )}
          </section>
        </div>
      )}

      {adminOpen && isAdmin && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setAdminOpen(false)}>
          <section className="form-panel admin-overview-panel" role="dialog" aria-modal="true" aria-labelledby="admin-overview-title">
            <div className="form-header admin-overview-header">
              <div><span className="eyebrow">Private owner control center</span><h2 id="admin-overview-title">YaadRakho SaaS overview</h2><p>Track registered businesses, adoption, reminders, and payment activity without opening private customer records.</p></div>
              <div className="admin-header-actions"><button type="button" className="secondary-button" disabled={adminLoading} onClick={() => void loadAdminOverview()}>{adminLoading ? "Refreshing…" : "Refresh"}</button><button type="button" onClick={() => setAdminOpen(false)} aria-label="Close">×</button></div>
            </div>

            {paymentReviewMessage && <p className="form-success" role="status">{paymentReviewMessage}</p>}
            {adminError && <div className="error-banner" role="alert"><span>{adminError}</span><button onClick={() => setAdminError("")}>×</button></div>}
            {adminLoading && !adminOverview ? <div className="empty-state"><span className="loader" />Loading owner analytics…</div> : adminOverview && <>
              <section className="admin-metric-grid" aria-label="YaadRakho platform metrics">
                {[
                  ["Registered businesses", adminOverview.metrics.totalBusinesses.toLocaleString("en-IN")],
                  ["Verified accounts", adminOverview.metrics.verifiedBusinesses.toLocaleString("en-IN")],
                  ["Active in 7 days", adminOverview.metrics.activeBusinesses.toLocaleString("en-IN")],
                  ["Customers tracked", adminOverview.metrics.totalCustomers.toLocaleString("en-IN")],
                  ["Outstanding", moneyLabel(adminOverview.metrics.outstandingAmount)],
                  ["Payments recorded", moneyLabel(adminOverview.metrics.collectedAmount)],
                ].map(([label, value]) => <article key={label}><span>{label}</span><strong>{value}</strong></article>)}
              </section>

              <section className="admin-health-strip" aria-label="Product adoption">
                <div><strong>{adminOverview.metrics.reminderBusinesses}</strong><span>businesses enabled reminders</span></div>
                <div><strong>{adminOverview.metrics.monthlyCustomers}</strong><span>monthly customers tracked</span></div>
                <div><strong>{adminOverview.metrics.paidAccounts}</strong><span>active paid accounts</span></div>
              </section>

              {!!adminOverview.paymentReconciliations?.length && <section aria-label="Verified refund history"><strong>Verified refund history</strong><p>Up to 50 recent resolutions. Bill balances and issued receipts were preserved.</p>{adminOverview.paymentReconciliations.map(entry => <p key={entry.payment_id}>{entry.payment_id} · {entry.refund_id} · Recorded by owner #{entry.actor_user_id}: {entry.note}</p>)}</section>}
              {!!adminOverview.recoveryOrders?.length && <section aria-label="Payment order recovery"><strong>Open payment attempts</strong><p>Check interrupted attempts with Razorpay. An empty search does not release the reserved balance. Showing up to 50 oldest open attempts.</p>{adminOverview.recoveryOrders.map(order => <p key={order.id}>Business #{order.owner_user_id} · Bill #{order.invoice_id} · {moneyLabel(order.amount)} · {order.error_message || "Open checkout"} <button type="button" className="secondary-button" disabled={paymentReviewBusy !== null} onClick={() => void recheckPayment("order:" + order.id, order.id)}>{paymentReviewBusy === "order:" + order.id ? "Checking…" : "Recover / verify order"}</button></p>)}</section>}
              {adminOverview.paymentReviews?.length > 0 && <section className="form-error" aria-label="Payments needing review"><strong>Captured payments needing review</strong><p>Check these payments in Razorpay before collecting again or arranging a refund. Showing up to 50 recent cases.</p>{adminOverview.paymentReviews.map(payment => <p key={payment.payment_id}>Business #{payment.owner_user_id} · Bill #{payment.invoice_id} · {moneyLabel(payment.amount)} · {payment.payment_id}: {payment.error_message || "Ledger confirmation pending"} {payment.status === "pending" ? <button type="button" className="secondary-button" disabled={paymentReviewBusy !== null} onClick={() => void recheckPayment(payment.payment_id)}>{paymentReviewBusy === payment.payment_id ? "Checking…" : "Recheck verified payment"}</button> : <small> Balance conflict: review the original payment and bill before making a correction.</small>}</p>)}</section>}
              {adminOverview.paymentReviews?.filter(payment => payment.status === "needs_review").map(payment => <form key={"refund:" + payment.payment_id} onSubmit={event => void reconcileRefund(event, payment.payment_id)}><strong>Record completed full refund: {payment.payment_id}</strong><p>Use only after refunding in Razorpay. This verifies existing evidence; it does not issue a refund.</p><label>Refund ID<input name="refundId" required pattern="rfnd_[A-Za-z0-9_]+" placeholder="rfnd_…" /></label><label>Review note<input name="note" required minLength={10} maxLength={1000} placeholder="Why this payment was refunded" /></label><button className="secondary-button" disabled={paymentReviewBusy !== null}>Verify full refund and record resolution</button></form>)}

              <section className={`admin-automation-status ${adminOverview.reminderAutomation?.status || "waiting"}`} aria-label="Reminder automation status">
                <div><strong>{adminOverview.reminderAutomation ? `Reminder automation: ${adminOverview.reminderAutomation.status}` : "Reminder automation has not run yet"}</strong><span>{adminOverview.reminderAutomation ? `${adminOverview.reminderAutomation.deliverySlot} · ${activityLabel(adminOverview.reminderAutomation.finishedAt || adminOverview.reminderAutomation.startedAt)}` : "The first scheduled run will appear here."}</span></div>
                {adminOverview.reminderAutomation && <div><b>{adminOverview.reminderAutomation.sentNotifications} sent</b><b>{adminOverview.reminderAutomation.failedNotifications} failed</b><b>{adminOverview.reminderAutomation.checkedSubscriptions} devices checked</b></div>}
              </section>

              <form className="admin-controls" onSubmit={(event) => { event.preventDefault(); const query = adminSearch.trim(); setAdminPage(1); setAdminQuery(query); void loadAdminOverview({ page: 1, query }); }}>
                <label><span>Search businesses</span><input value={adminSearch} onChange={(event) => setAdminSearch(event.target.value)} placeholder="Business name or email" /></label>
                <label><span>Account filter</span><select value={adminFilter} onChange={(event) => { const filter = event.target.value as AdminBusinessFilter; setAdminPage(1); setAdminFilter(filter); void loadAdminOverview({ page: 1, filter }); }}><option value="all">All businesses</option><option value="active">Active in 7 days</option><option value="inactive">Inactive</option><option value="unverified">Email unverified</option><option value="trial">Free access</option><option value="paid">Paid plans</option></select></label>
                <button className="primary-button" disabled={adminLoading}>Search</button>
              </form>

              <section className="admin-business-section">
                <div className="admin-list-heading"><div><span className="eyebrow">Business accounts</span><h3>{adminOverview.pagination.total} result{adminOverview.pagination.total === 1 ? "" : "s"}</h3></div><small>Page {adminOverview.pagination.page} of {adminOverview.pagination.pages}</small></div>
                {adminOverview.businesses.length === 0 ? <div className="admin-empty"><strong>No matching businesses</strong><span>Change the search or account filter.</span></div> : <div className="admin-business-list">{adminOverview.businesses.map((business) => <article key={business.id}>
                  <div className="admin-business-identity"><span>{business.displayName.charAt(0).toUpperCase()}</span><div><strong>{business.displayName}</strong><small>{business.email}</small><div className="admin-badges"><b className={business.verified ? "verified" : "unverified"}>{business.verified ? "Verified" : "Unverified"}</b><b>{business.plan === "trial" ? "Free" : business.plan}</b><b>{business.reminderDevices > 0 ? "Reminders on" : "Reminders off"}</b></div></div></div>
                  <div className="admin-business-numbers"><span><small>Customers</small><strong>{business.customerCount}</strong></span><span><small>Monthly</small><strong>{business.monthlyCustomers}</strong></span><span><small>Outstanding</small><strong>{moneyLabel(business.outstandingAmount)}</strong></span><span><small>Collected</small><strong>{moneyLabel(business.collectedAmount)}</strong></span></div>
                  {!business.verified && adminOverview.manualVerificationEnabled && <div className="admin-preview-approval"><span><strong>Preview approval required</strong><small>Email delivery failed; approve this controlled demo account manually.</small></span><button type="button" className="secondary-button" disabled={adminVerificationSavingId === business.id} onClick={() => void approvePreviewBusiness(business.id)}>{adminVerificationSavingId === business.id ? "Approving..." : "Approve Preview access"}</button></div>}
                  <form className="admin-payment-account" onSubmit={(event) => void saveBusinessPaymentAccount(event, business.id)}><label><small>Razorpay linked account</small><input name="providerAccountId" defaultValue={business.paymentAccountId} placeholder="acc_..." required /></label><label><small>Status</small><select name="status" defaultValue={business.paymentAccountStatus}><option value="pending">Pending</option><option value="active">Active</option><option value="restricted">Restricted</option><option value="suspended">Suspended</option></select></label><button type="submit" className="secondary-button" disabled={adminPaymentSavingId === business.id}>{adminPaymentSavingId === business.id ? "Saving..." : "Save test account"}</button></form>
                  <div className="admin-business-activity"><small>Joined {activityLabel(business.createdAt)}</small><small>Last active: {activityLabel(business.lastActivityAt || business.lastLoginAt)}</small></div>
                </article>)}</div>}
                <div className="admin-pagination"><button type="button" className="secondary-button" disabled={adminLoading || adminOverview.pagination.page <= 1} onClick={() => { const page = Math.max(1, adminOverview.pagination.page - 1); setAdminPage(page); void loadAdminOverview({ page }); }}>Previous</button><span>{adminOverview.pagination.page} / {adminOverview.pagination.pages}</span><button type="button" className="secondary-button" disabled={adminLoading || adminOverview.pagination.page >= adminOverview.pagination.pages} onClick={() => { const page = adminOverview.pagination.page + 1; setAdminPage(page); void loadAdminOverview({ page }); }}>Next</button></div>
              </section>
            </>}
          </section>
        </div>
      )}

      {remindersOpen && <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && setRemindersOpen(false)}>
        <section className="form-panel settings-panel" role="dialog" aria-modal="true" aria-labelledby="reminders-title">
          <div className="form-header"><div><span className="eyebrow">Payment follow-ups</span><h2 id="reminders-title">Reminders</h2><p>See pending bills and manage alerts on this device.</p></div><button type="button" aria-label="Close reminders" onClick={() => setRemindersOpen(false)}>×</button></div>
          <section className="settings-group"><h3>Follow up today</h3><p>Open the customer list to call or share a reminder, or review pending bills.</p><div className="settings-header-actions"><button type="button" className="secondary-button" onClick={() => { setRemindersOpen(false); selectCustomerFilter("today"); }}>Due today</button><button type="button" className="secondary-button" onClick={() => { setRemindersOpen(false); selectCustomerFilter("overdue"); }}>Overdue customers</button><button type="button" className="secondary-button" onClick={() => { setRemindersOpen(false); setSalesBillingTab("reminders"); setSalesBillingOpen(true); }}>Pending bills</button></div></section>
              <section className="settings-group"><h3>Reminder and ringtone</h3><p>{isNativeApp ? "Compulsory popup reminders run every 2 hours from 9 AM to 9 PM. Selected times add a loud alarm, popup, and vibration." : "When automatic reminders are on and the server scheduler is configured, reminders run every 2 hours from 9 AM to 9 PM. Background sound follows your browser and device settings; the sound preview below plays only while this app is open."}</p><div className="setting-row"><div><strong>Automatic reminders</strong><small>{isNativeApp ? (remindersEnabled ? "2-hour popups and native alarms are active" : "Turn on native reminders") : (reminderStatusReady ? notificationStatusMessage(notificationPermission, remindersEnabled) : "Checking notification and saved device subscription…")}</small>{notificationPermission === "denied" && <small>Chrome → Site settings → Notifications → Allow</small>}</div><button type="button" className={`toggle-button ${remindersEnabled ? "on" : ""}`} disabled={!reminderStatusReady || reminderBusy !== null} onClick={remindersEnabled ? disableReminders : enableReminders}>{!reminderStatusReady ? "Checking…" : reminderBusy === "enable" ? "Turning on…" : reminderBusy === "disable" ? "Turning off…" : remindersEnabled ? "Turn off" : "Turn on"}</button></div><div className="reminder-time-setting"><strong>{isNativeApp ? "Alarm ringtone times" : "Extra sound-notification times"}</strong><small>Select extra times. These apply when automatic reminders are on.</small><div className="reminder-time-grid">{[["09", "9 AM"], ["12", "12 PM"], ["15", "3 PM"], ["18", "6 PM"], ["21", "9 PM"]].map(([value, label]) => <label className="reminder-time-option" key={value}><input type="checkbox" checked={extraReminderTimes.includes(value)} disabled={reminderBusy !== null} onChange={() => void toggleExtraReminder(value)} /><span>{label}</span></label>)}</div></div><button type="button" className="secondary-button" disabled={reminderBusy !== null} onClick={testPushNotification}>{reminderBusy === "test" ? "Sending…" : isNativeApp ? "Test native alarm" : "Test notification on this device"}</button>{!isNativeApp && <button type="button" className="secondary-button" onClick={playReminderTone}>Preview in-app sound</button>}</section>
          <p>Device alerts notify you. Customer WhatsApp/SMS messages are separate and depend on consent and delivery setup.</p>
          {settingsMessage && <div className="billing-message" role="status">{settingsMessage}</div>}
        </section>
      </div>}

      {settingsOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSettingsOpen(false)}>
          <section className="form-panel settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="form-header"><div><span className="eyebrow">Account controls</span><h2 id="settings-title">Settings</h2></div><div className="settings-header-actions"><button className="settings-close-button" type="button" onClick={() => setSettingsOpen(false)} aria-label="Close">×</button></div></div>
            <form onSubmit={saveSettings}>
              <section className="settings-group"><h3>Customer online payments</h3><p>{paymentAccount.routeEnabled ? (paymentAccount.status === "active" ? "Razorpay Route is active for this business. Customer bill payments are routed to its linked account." : "Razorpay Route setup is pending for this business. Online checkout remains blocked until the account is active.") : "Multi-business payment routing is not enabled in this environment."}</p><div className="setting-row"><div><strong>{paymentAccount.status === "active" ? "Payment account connected" : "Payment account pending"}</strong><small>{paymentAccount.providerAccountId || "No linked account ID assigned yet"}</small></div><b className={paymentAccount.status === "active" ? "status-active" : ""}>{paymentAccount.status.toUpperCase()}</b></div></section>
              <section className="settings-group"><h3>Business profile</h3><p>This name is used at the end of ready SMS and WhatsApp messages.</p><label><span>Owner or business name</span><input required value={settings.businessName} onChange={(event) => setSettings({ ...settings, businessName: event.target.value })} placeholder="Your business name" /></label><label><span>Business phone number</span><input inputMode="tel" value={settings.phone} onChange={(event) => setSettings({ ...settings, phone: event.target.value })} placeholder="98765 43210" /></label><label><span>Login email</span><input value={user.email} readOnly /></label><button className="primary-button" disabled={settingsSaving}>{settingsSaving ? "Saving…" : "Save profile"}</button></section>
              <section className="settings-group"><h3>Reminders</h3><p>Manage device notifications and payment follow-ups.</p><button type="button" className="secondary-button" onClick={() => { setSettingsOpen(false); setRemindersOpen(true); }}>Open reminders</button></section>
              <section className="settings-group"><h3>Account</h3>{smsEnabled && <a className="secondary-button" href="/account/mobile">Mobile login and recovery</a>}<button type="button" className="signout-button" onClick={signOut}>Sign out of YaadRakho</button></section>
              <section className="settings-group danger-zone"><h3>Reset customer data</h3><p>Permanently delete every customer saved in this account. Your login and profile remain active.</p><button type="button" className="danger-button" onClick={resetCustomerData}>Delete all customers</button></section>
              <section className="settings-group danger-zone"><h3>Delete account</h3><p>Permanently delete your login, customers, payment history, settings, sessions, and reminder subscriptions.</p><label><span>Confirm your password</span><input type="password" autoComplete="current-password" value={deleteAccountPassword} onChange={(event) => setDeleteAccountPassword(event.target.value)} placeholder="Enter your password" /></label><button type="button" className="danger-button" disabled={deletingAccount} onClick={removeAccount}>{deletingAccount ? "Deleting…" : "Delete my account permanently"}</button></section>
              {settingsMessage && <div className="billing-message" role="status">{settingsMessage}</div>}
            </form>
          </section>
        </div>
      )}

      <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
        <button type="button" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}><span aria-hidden="true">⌂</span><small>Home</small></button>
        <button type="button" onClick={() => selectCustomerFilter("all")}><span aria-hidden="true">◎</span><small>Customers</small></button>
        <button type="button" onClick={() => setRemindersOpen(true)}><span aria-hidden="true">♢</span><small>Reminders</small></button>
        <button type="button" onClick={() => { setSalesBillingTab("invoice"); setSalesBillingOpen(true); }}><span aria-hidden="true">▤</span><small>Bills</small></button>
        <button type="button" onClick={() => setSettingsOpen(true)}><span aria-hidden="true">◉</span><small>Profile</small></button>
      </nav>
    </main>
  );
}
