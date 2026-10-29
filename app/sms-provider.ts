export interface SmsProvider {
  start(phone: string): Promise<string>;
  verify(phone: string, sid: string, code: string): Promise<boolean>;
}

export function smsOtpAvailable() {
  return process.env.SMS_OTP_ENABLED === "true" && process.env.SMS_OTP_PROVIDER === "twilio_verify"
    && /^AC[0-9a-f]{32}$/i.test(process.env.TWILIO_ACCOUNT_SID || "")
    && /^VA[0-9a-f]{32}$/i.test(process.env.TWILIO_VERIFY_SERVICE_SID || "")
    && Boolean(process.env.TWILIO_AUTH_TOKEN);
}

// Optional adapter only. No account is created and no SMS is sent until explicitly enabled.
export function configuredSmsProvider(fetcher: typeof fetch = fetch): SmsProvider {
  if (!smsOtpAvailable()) throw new Error("Mobile OTP is not available yet. Use email and password or email password reset.");
  const service = process.env.TWILIO_VERIFY_SERVICE_SID!;
  const authorization = "Basic " + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ":" + process.env.TWILIO_AUTH_TOKEN).toString("base64");
  async function post(path: string, values: Record<string, string>) {
    const response = await fetcher(`https://verify.twilio.com/v2/Services/${service}/${path}`, {
      method: "POST", headers: { Authorization: authorization, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("SMS verification could not be completed. Request a new code later.");
    return response.json() as Promise<{ sid?: string; service_sid?: string; to?: string; status?: string }>;
  }
  return {
    async start(phone) {
      const result = await post("Verifications", { To: phone, Channel: "sms" });
      if (!result.sid || !/^VE[0-9a-f]{32}$/i.test(result.sid) || result.service_sid !== service || result.to !== phone || result.status !== "pending") throw new Error("SMS provider returned an unexpected verification");
      return result.sid;
    },
    async verify(phone, sid, code) {
      const result = await post("VerificationCheck", { VerificationSid: sid, Code: code });
      return result.status === "approved" && result.sid === sid && result.service_sid === service && result.to === phone;
    },
  };
}
