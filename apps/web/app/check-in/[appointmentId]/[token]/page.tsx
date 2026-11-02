import { CheckInFormClient } from "./check-in-form-client";

export const dynamic = "force-dynamic";

export default async function CheckInPage({
  params,
}: {
  params: Promise<{ appointmentId: string; token: string }>;
}) {
  const { appointmentId, token } = await params;
  return <CheckInFormClient appointmentId={appointmentId} token={token} />;
}
