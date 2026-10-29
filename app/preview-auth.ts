export function previewManualVerificationEnabled() {
  return process.env.VERCEL_ENV === "preview"
    && process.env.ALLOW_PREVIEW_MANUAL_VERIFICATION === "true";
}
