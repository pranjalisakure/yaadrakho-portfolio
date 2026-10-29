import QRCode from "qrcode";

export function paymentQrTarget(origin: string, token: string, remaining: number, choice: string, status = "issued") {
  if (remaining <= 0 || choice !== "online" || status === "paid" || status === "cancelled" || !/^[a-f0-9]{32}$/i.test(token)) return null;
  const base = new URL(origin);
  if (!["https:", "http:"].includes(base.protocol)) throw new Error("Invalid public app URL");
  return new URL("/bill/" + token, base).href;
}

export function paymentQrMatrix(url: string) {
  return QRCode.create(url, { errorCorrectionLevel: "M" }).modules;
}
