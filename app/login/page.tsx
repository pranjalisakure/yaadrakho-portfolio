import { localDemoAuthEnabled } from "../local-demo-auth";
import { authEmailAvailable } from "../auth-email";
import { redirect } from "next/navigation";
import { getCurrentUser } from "../auth";
import { smsOtpAvailable } from "../sms-provider";
import AuthForm from "../AuthForm";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  if (await getCurrentUser()) redirect("/");
  const { mode } = await searchParams;
  return <AuthForm localDemo={localDemoAuthEnabled()} emailEnabled={authEmailAvailable()} smsEnabled={smsOtpAvailable()} initialMode={mode === "signup" ? "signup" : "login"} />;
}
