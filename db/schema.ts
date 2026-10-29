import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const customers = sqliteTable("customers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerEmail: text("owner_email").notNull(),
  ownerUserId: integer("owner_user_id"),
  currentDueId: integer("current_due_id"),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  phoneKey: text("phone_key"),
  requirement: text("requirement").notNull().default(""),
  amount: integer("amount").notNull().default(0),
  followUpDate: text("follow_up_date").notNull(),
  status: text("status", { enum: ["new", "follow_up", "won", "lost"] }).notNull().default("new"),
  paymentStatus: text("payment_status", { enum: ["pending", "partial", "paid"] }).notNull().default("pending"),
  billingCycle: text("billing_cycle", { enum: ["one_time", "monthly"] }).notNull().default("one_time"),
  recurringDay: integer("recurring_day").notNull().default(1),
  notes: text("notes").notNull().default(""),
  contactConsent: integer("contact_consent", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const customerPayments = sqliteTable("customer_payments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  customerId: integer("customer_id").notNull(),
  ownerEmail: text("owner_email").notNull(),
  ownerUserId: integer("owner_user_id"),
  periodKey: text("period_key").notNull(),
  amount: integer("amount").notNull().default(0),
  dueDate: text("due_date").notNull(),
  status: text("status", { enum: ["paid"] }).notNull().default("paid"),
  paidAt: integer("paid_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const paymentDues = sqliteTable("payment_dues", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerUserId: integer("owner_user_id").notNull(),
  ownerKey: text("owner_key").notNull(),
  customerId: integer("customer_id").notNull(),
  periodKey: text("period_key").notNull(),
  dueDate: text("due_date").notNull(),
  amountDue: integer("amount_due").notNull(),
  amountPaid: integer("amount_paid").notNull().default(0),
  status: text("status", { enum: ["pending", "partial", "paid"] }).notNull().default("pending"),
  paidAt: integer("paid_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const paymentTransactions = sqliteTable("payment_transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerUserId: integer("owner_user_id").notNull(),
  ownerKey: text("owner_key").notNull(),
  customerId: integer("customer_id").notNull(),
  dueId: integer("due_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  amount: integer("amount").notNull(),
  method: text("method", { enum: ["cash", "upi", "paytm", "bank", "other"] }).notNull().default("other"),
  reference: text("reference").notNull().default(""),
  note: text("note").notNull().default(""),
  receiptNumber: text("receipt_number"),
  receiptToken: text("receipt_token"),
  balanceAfter: integer("balance_after"),
  receivedAt: integer("received_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const productCatalog = sqliteTable("product_catalog", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerUserId: integer("owner_user_id").notNull(),
  ownerKey: text("owner_key").notNull(),
  name: text("name").notNull(),
  nameKey: text("name_key").notNull(),
  price: integer("price").notNull(),
  gstRate: integer("gst_rate").notNull().default(0),
  unit: text("unit").notNull().default("item"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const invoices = sqliteTable("invoices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerUserId: integer("owner_user_id").notNull(),
  ownerKey: text("owner_key").notNull(),
  customerId: integer("customer_id").notNull(),
  dueId: integer("due_id"),
  invoiceNumber: text("invoice_number").notNull(),
  idempotencyKey: text("idempotency_key"),
  billingMode: text("billing_mode", { enum: ["separate", "monthly_statement"] }).notNull().default("separate"),
  remainingPayment: text("remaining_payment", { enum: ["online", "cash"] }).notNull().default("online"),
  issueDate: text("issue_date").notNull(),
  dueDate: text("due_date").notNull(),
  subtotal: integer("subtotal").notNull(),
  discountAmount: integer("discount_amount").notNull().default(0),
  taxAmount: integer("tax_amount").notNull().default(0),
  totalAmount: integer("total_amount").notNull(),
  amountPaid: integer("amount_paid").notNull().default(0),
  status: text("status", { enum: ["issued", "partial", "paid", "cancelled"] }).notNull().default("issued"),
  notes: text("notes").notNull().default(""),
  publicToken: text("public_token"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const invoiceItems = sqliteTable("invoice_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  invoiceId: integer("invoice_id").notNull(),
  productId: integer("product_id"),
  description: text("description").notNull(),
  quantityMilli: integer("quantity_milli").notNull(),
  unit: text("unit").notNull().default("item"),
  unitPrice: integer("unit_price").notNull(),
  gstRate: integer("gst_rate").notNull().default(0),
  lineSubtotal: integer("line_subtotal").notNull(),
  lineDiscount: integer("line_discount").notNull().default(0),
  lineTax: integer("line_tax").notNull().default(0),
  lineTotal: integer("line_total").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const invoiceDeliveries = sqliteTable("invoice_deliveries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerUserId: integer("owner_user_id").notNull(),
  invoiceId: integer("invoice_id").notNull(),
  channel: text("channel", { enum: ["whatsapp"] }).notNull().default("whatsapp"),
  destination: text("destination").notNull(),
  message: text("message").notNull(),
  status: text("status", { enum: ["prepared", "sent", "failed"] }).notNull().default("prepared"),
  providerReference: text("provider_reference").notNull().default(""),
  errorMessage: text("error_message").notNull().default(""),
  createdAt: integer("created_at").notNull(),
  automaticAttemptedAt: integer("automatic_attempted_at"),
  reviewNote: text("review_note").notNull().default(""),
  reviewedAt: integer("reviewed_at"),
  sentAt: integer("sent_at"),
  updatedAt: integer("updated_at").notNull(),
});

export const razorpayOrders = sqliteTable("razorpay_orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerUserId: integer("owner_user_id").notNull(),
  ownerKey: text("owner_key").notNull(),
  customerId: integer("customer_id").notNull(),
  invoiceId: integer("invoice_id").notNull(),
  dueId: integer("due_id").notNull(),
  requestKey: text("request_key").notNull(),
  razorpayOrderId: text("razorpay_order_id"),
  amount: integer("amount").notNull(),
  currency: text("currency").notNull().default("INR"),
  status: text("status", { enum: ["creating", "created", "paid", "failed", "cancelled"] }).notNull().default("creating"),
  paymentId: text("payment_id"),
  paymentAccountId: integer("payment_account_id"),
  providerAccountId: text("provider_account_id"),
  transferId: text("transfer_id"),
  transferStatus: text("transfer_status", { enum: ["not_requested", "pending", "processed", "failed"] }).notNull().default("not_requested"),
  transferError: text("transfer_error").notNull().default(""),
  errorMessage: text("error_message").notNull().default(""),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  paidAt: integer("paid_at"),
});

export const businessPaymentAccounts = sqliteTable("business_payment_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerUserId: integer("owner_user_id").notNull(),
  ownerKey: text("owner_key").notNull(),
  provider: text("provider", { enum: ["razorpay_route"] }).notNull().default("razorpay_route"),
  mode: text("mode", { enum: ["test", "live"] }).notNull().default("test"),
  providerAccountId: text("provider_account_id"),
  status: text("status", { enum: ["pending", "active", "restricted", "suspended"] }).notNull().default("pending"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  activatedAt: integer("activated_at"),
});

export const razorpayWebhookEvents = sqliteTable("razorpay_webhook_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  status: text("status", { enum: ["received", "processed", "ignored", "failed"] }).notNull().default("received"),
  errorMessage: text("error_message").notNull().default(""),
  createdAt: integer("created_at").notNull(),
  processedAt: integer("processed_at"),
});

export const subscriptions = sqliteTable("subscriptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userEmail: text("user_email").notNull().unique(),
  plan: text("plan", { enum: ["trial", "starter", "pro"] }).notNull().default("trial"),
  status: text("status", { enum: ["trial", "pending", "active", "cancelled"] }).notNull().default("trial"),
  price: integer("price").notNull().default(0),
  trialEndsAt: integer("trial_ends_at").notNull(),
  requestedAt: integer("requested_at"),
  activatedAt: integer("activated_at"),
  updatedAt: integer("updated_at").notNull(),
});

export const appSettings = sqliteTable("app_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userEmail: text("user_email").notNull().unique(),
  businessName: text("business_name").notNull().default(""),
  phone: text("phone").notNull().default(""),
  updatedAt: integer("updated_at").notNull(),
});

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  storageKey: text("storage_key").notNull().unique(),
  passwordSalt: text("password_salt").notNull(),
  passwordHash: text("password_hash").notNull(),
  recoverySalt: text("recovery_salt").notNull(),
  recoveryHash: text("recovery_hash").notNull(),
  isOwner: integer("is_owner", { mode: "boolean" }).notNull().default(false),
  emailVerifiedAt: integer("email_verified_at"),
  lastLoginAt: integer("last_login_at"),
  lastActivityAt: integer("last_activity_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const loginAttempts = sqliteTable("login_attempts", {
  email: text("email").primaryKey(),
  attemptCount: integer("attempt_count").notNull().default(0),
  windowStartedAt: integer("window_started_at").notNull(),
  lockedUntil: integer("locked_until"),
});

export const accountTokens = sqliteTable("account_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  purpose: text("purpose", { enum: ["verify_email", "reset_password"] }).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  createdAt: integer("created_at").notNull(),
});

export const authRequests = sqliteTable("auth_requests", {
  requestKey: text("request_key").primaryKey(),
  requestCount: integer("request_count").notNull().default(0),
  windowStartedAt: integer("window_started_at").notNull(),
  blockedUntil: integer("blocked_until"),
});

export const razorpayCaptures = sqliteTable("razorpay_captures", {
 paymentId: text("payment_id").primaryKey(), razorpayOrderId: text("razorpay_order_id").notNull(),
 ownerUserId: integer("owner_user_id").notNull(), invoiceId: integer("invoice_id").notNull(), dueId: integer("due_id").notNull(),
 amount: integer("amount").notNull(), currency: text("currency").notNull(),
 status: text("status", { enum: ["pending", "applied", "needs_review"] }).notNull().default("pending"),
 errorMessage: text("error_message").notNull().default(""), createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
});

export const paymentReviewAttempts = sqliteTable("payment_review_attempts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  paymentId: text("payment_id").notNull(), actorUserId: integer("actor_user_id").notNull(),
  status: text("status", { enum: ["started", "applied", "review_required", "failed"] }).notNull().default("started"),
  errorMessage: text("error_message").notNull().default(""),
  createdAt: integer("created_at").notNull(), finishedAt: integer("finished_at"),
});

export const orderRecoveryAttempts = sqliteTable("order_recovery_attempts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  localOrderId: integer("local_order_id").notNull(),
  actorUserId: integer("actor_user_id"),
  source: text("source").notNull(),
  status: text("status").notNull().default("started"),
  providerOrderId: text("provider_order_id"),
  message: text("message").notNull().default(""),
  createdAt: integer("created_at").notNull(),
  finishedAt: integer("finished_at"),
});

export const paymentReconciliations = sqliteTable("payment_reconciliations", {
  paymentId: text("payment_id").primaryKey(),
  refundId: text("refund_id").notNull().unique(),
  actorUserId: integer("actor_user_id").notNull(),
  note: text("note").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const accountPhones = sqliteTable("account_phones", {
  userId: integer("user_id").primaryKey(), phone: text("phone").notNull().unique(), verifiedAt: integer("verified_at").notNull(),
});
export const smsChallenges = sqliteTable("sms_challenges", {
  tokenHash: text("token_hash").primaryKey(), userId: integer("user_id"), phone: text("phone").notNull(),
  purpose: text("purpose", { enum: ["enroll", "login", "reset"] }).notNull(), passwordVersion: text("password_version").notNull().default(""),
  providerSid: text("provider_sid"), status: text("status").notNull().default("sending"), attempts: integer("attempts").notNull().default(0),
  expiresAt: integer("expires_at").notNull(), createdAt: integer("created_at").notNull(),
});

export const emailResetChallenges = sqliteTable("email_reset_challenges", {
  challengeHash: text("challenge_hash").primaryKey().notNull(),
  userId: integer("user_id").notNull().unique(),
  otpHash: text("otp_hash").notNull(),
  passwordVersion: text("password_version").notNull(),
  expiresAt: integer("expires_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  delivered: integer("delivered").notNull().default(0),
});
