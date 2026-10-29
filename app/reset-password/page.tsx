import ResetPasswordForm from "./ResetPasswordForm";

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  return <ResetPasswordForm token={String((await searchParams).token || "")} />;
}
