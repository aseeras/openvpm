"use client";

import { useState } from "react";
import {
  Check,
  ClipboardList,
  Copy,
  ExternalLink,
  Loader2,
  Mail,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  CHECK_IN_SECTIONS,
  checkInAnswerLabel,
  checkInSummaryLabel,
  type CheckInAnswerKey,
  type CheckInAnswers,
} from "@/lib/check-in/form";

function formatWhen(value: Date | string): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Owner answers grouped by section, read-only. */
export function CheckInAnswersView({ answers }: { answers: CheckInAnswers }) {
  const sections = CHECK_IN_SECTIONS.map((section) => ({
    ...section,
    answered: section.questions.filter(
      (question) => answers[question.key as CheckInAnswerKey],
    ),
  })).filter((section) => section.answered.length > 0);

  if (sections.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No answers were given.</p>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {sections.map((section) => (
        <div key={section.key}>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {section.title}
          </h4>
          <dl className="mt-1.5 space-y-1.5">
            {section.answered.map((question) => (
              <div key={question.key} className="text-sm">
                <dt className="inline font-medium">
                  {checkInSummaryLabel(question.key as CheckInAnswerKey)}:
                </dt>{" "}
                <dd className="inline whitespace-pre-line text-foreground/90">
                  {checkInAnswerLabel(
                    question,
                    answers[question.key as CheckInAnswerKey]!,
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

function ReviewButton({
  checkInId,
  patientId,
}: {
  checkInId: string;
  patientId: string;
}) {
  const utils = trpc.useUtils();
  const markReviewed = trpc.checkIns.markReviewed.useMutation({
    onSuccess: () => {
      void utils.checkIns.listForPatient.invalidate({ patientId });
      toast.success("Marked as reviewed");
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={markReviewed.isPending}
      onClick={() => markReviewed.mutate({ checkInId })}
    >
      {markReviewed.isPending ? (
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
      ) : (
        <Check className="mr-1.5 h-3.5 w-3.5" />
      )}
      Mark reviewed
    </Button>
  );
}

/**
 * Patient chart card: the owner's most recent pre-appointment check-in, with
 * earlier ones collapsed below. Hidden until a check-in exists.
 */
export function OwnerCheckInCard({ patientId }: { patientId: string }) {
  const query = trpc.checkIns.listForPatient.useQuery({ patientId });
  const rows = query.data ?? [];
  if (query.isLoading || query.error || rows.length === 0) return null;
  const [latest, ...older] = rows;

  return (
    <section
      aria-label="Owner check-in"
      className="rounded-lg border border-border bg-card p-6"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-heading text-base font-semibold">
            <ClipboardList className="h-4 w-4 text-primary" />
            Owner check-in
            {latest!.reviewedAt ? (
              <Badge variant="outline">Reviewed</Badge>
            ) : (
              <Badge>New</Badge>
            )}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Filled out by the owner {formatWhen(latest!.submittedAt)} for the
            visit on {formatWhen(latest!.appointmentStart)}. Owner-reported, not
            yet verified.
          </p>
        </div>
        {!latest!.reviewedAt && (
          <ReviewButton checkInId={latest!.id} patientId={patientId} />
        )}
      </div>
      <CheckInAnswersView answers={latest!.answers} />
      {older.length > 0 && (
        <details className="mt-5 border-t border-border pt-4">
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
            Earlier check-ins ({older.length})
          </summary>
          <div className="mt-4 space-y-6">
            {older.map((row) => (
              <div key={row.id}>
                <p className="mb-2 text-xs text-muted-foreground">
                  Visit on {formatWhen(row.appointmentStart)} · submitted{" "}
                  {formatWhen(row.submittedAt)}
                </p>
                <CheckInAnswersView answers={row.answers} />
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

/** Copy / email the owner's link for one visit. */
export function CheckInLinkActions({
  appointmentId,
  compact = false,
}: {
  appointmentId: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const status = trpc.checkIns.forAppointment.useQuery({ appointmentId });
  const sendLink = trpc.checkIns.sendLink.useMutation({
    onSuccess: (result) =>
      toast.success(`Check-in form sent to ${result.sentTo}`),
    onError: (error) => toast.error(error.message),
  });

  const data = status.data;
  if (!data || !data.eligible) return null;
  if (!data.open) {
    return compact ? null : (
      <p className="text-xs text-muted-foreground">
        The check-in form closes once a visit starts or is cancelled.
      </p>
    );
  }

  async function copy() {
    if (!data?.url) return;
    try {
      await navigator.clipboard.writeText(data.url);
      setCopied(true);
      toast.success("Check-in link copied. Paste it into a text or email.");
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      window.prompt("Copy the check-in link:", data.url);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {data.submittedAt ? (
        <Badge variant="outline" className="gap-1">
          <Check className="h-3 w-3" /> Owner filled it out
        </Badge>
      ) : (
        <Badge variant="outline">Not filled out yet</Badge>
      )}
      <Button size="sm" variant="outline" onClick={copy}>
        {copied ? (
          <Check className="mr-1.5 h-3.5 w-3.5" />
        ) : (
          <Copy className="mr-1.5 h-3.5 w-3.5" />
        )}
        Copy link
      </Button>
      {data.canEmail && (
        <Button
          size="sm"
          variant="outline"
          disabled={sendLink.isPending}
          onClick={() => sendLink.mutate({ appointmentId })}
        >
          {sendLink.isPending ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Mail className="mr-1.5 h-3.5 w-3.5" />
          )}
          Email to owner
        </Button>
      )}
      {data.url && !compact && (
        <Button size="sm" variant="ghost" asChild>
          <a href={data.url} target="_blank" rel="noreferrer">
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            Preview
          </a>
        </Button>
      )}
    </div>
  );
}

/** Encounter page panel: this visit's answers plus the link controls. */
export function VisitCheckInPanel({
  appointmentId,
  patientId,
}: {
  appointmentId: string;
  patientId: string | null;
}) {
  const list = trpc.checkIns.listForPatient.useQuery(
    { patientId: patientId ?? "" },
    { enabled: Boolean(patientId) },
  );
  if (!patientId) return null;
  const forVisit = list.data?.find(
    (row) => row.appointmentId === appointmentId,
  );

  return (
    <section
      aria-label="Owner check-in"
      className="rounded-lg border border-border bg-card p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-medium">
          <ClipboardList className="h-4 w-4 text-primary" />
          Owner check-in form
        </h2>
        <CheckInLinkActions appointmentId={appointmentId} />
      </div>
      {forVisit ? (
        <div className="mt-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Submitted {formatWhen(forVisit.submittedAt)}. Owner-reported, not
              yet verified.
            </p>
            {!forVisit.reviewedAt && (
              <ReviewButton checkInId={forVisit.id} patientId={patientId} />
            )}
          </div>
          <CheckInAnswersView answers={forVisit.answers} />
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          The owner hasn't filled out the check-in form for this visit. Send
          them the link to collect the pet's problems, habits, food,
          medications, and goals before the visit.
        </p>
      )}
    </section>
  );
}
