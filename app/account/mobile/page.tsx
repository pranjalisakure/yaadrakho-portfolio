import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "../../auth";
import { getClient } from "../../../db";
import { smsOtpAvailable } from "../../sms-provider";
import SmsAuthForm from "../../SmsAuthForm";

export const dynamic = "force-dynamic";
export default async function MobileAccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const result = await getClient().execute({ sql: "SELECT phone FROM account_phones WHERE user_id = ?", args: [user.id] });
  const phone = result.rows[0]?.phone ? String(result.rows[0].phone) : null;
  return <main className="auth-page"><section className="auth-card"><Link href="/">← Back to YaadRakho</Link><h1>Mobile login and recovery</h1><p>{phone ? "Verified mobile: +91 ••••••" + phone.slice(-4) : "No verified login mobile is linked yet."}</p><SmsAuthForm purpose="enroll" enabled={smsOtpAvailable()} /></section></main>;
}
