"use client";

import { useEffect, useId, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { PawMark } from "@/components/brand/paw-mark";
import {
  CHECK_IN_SECTIONS,
  CHECK_IN_TEXT_MAX_LENGTH,
  type CheckInAnswerKey,
  type CheckInAnswers,
  type CheckInQuestion,
} from "@/lib/check-in/form";
import { cn } from "@/lib/utils";

type Visit = {
  patientName: string;
  patientSpecies: string | null;
  clientFirstName: string;
  practiceName: string;
  practiceTimezone: string | null;
  visitTypeName: string | null;
  startTime: string;
  open: boolean;
  submittedAt: string | null;
  answers: CheckInAnswers;
};

type ViewState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "ready"; visit: Visit }
  | { kind: "done"; visit: Visit };

function formatVisitTime(iso: string, timeZone: string | null): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timeZone ?? undefined,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

export function CheckInFormClient({
  appointmentId,
  token,
}: {
  appointmentId: string;
  token: string;
}) {
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const [answers, setAnswers] = useState<CheckInAnswers>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const apiPath = `/api/check-in/${encodeURIComponent(appointmentId)}/${encodeURIComponent(token)}`;

  useEffect(() => {
    let cancelled = false;
    fetch(apiPath)
      .then(async (response) => {
        if (cancelled) return;
        if (response.status === 404) {
          setState({ kind: "missing" });
          return;
        }
        if (!response.ok) {
          setState({
            kind: "error",
            message:
              response.status === 429
                ? "Too many tries. Please wait a few minutes and reload."
                : "The form could not be loaded. Please reload the page.",
          });
          return;
        }
        const visit = (await response.json()) as Visit;
        setAnswers(visit.answers ?? {});
        setState({ kind: "ready", visit });
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            kind: "error",
            message: "The form could not be loaded. Check your connection.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiPath]);

  const setAnswer = (key: CheckInAnswerKey, value: string | undefined) =>
    setAnswers((current) => ({ ...current, [key]: value || undefined }));

  async function submit(visit: Visit) {
    setSubmitError(null);
    if (!answers.mainConcerns?.trim()) {
      setSubmitError(
        `Please tell us what you'd like help with for ${visit.patientName}.`,
      );
      document.getElementById("check-in-mainConcerns")?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch(apiPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        submittedAt?: string;
      };
      if (!response.ok) {
        setSubmitError(
          data.error ?? "Your answers could not be saved. Please try again.",
        );
        return;
      }
      setState({
        kind: "done",
        visit: { ...visit, answers, submittedAt: data.submittedAt ?? null },
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      setSubmitError(
        "Your answers could not be saved. Check your connection and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const visit =
    state.kind === "ready" || state.kind === "done" ? state.visit : null;

  return (
    <>
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-2xl items-center gap-2 px-4 py-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-600">
            <PawMark className="h-4 w-4 text-white" />
          </div>
          <div className="text-sm font-semibold text-gray-900">
            {visit?.practiceName ?? "Pre-visit check-in"}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-6">
        {state.kind === "loading" && (
          <div className="flex items-center justify-center py-20 text-gray-500">
            <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
          </div>
        )}

        {state.kind === "missing" && (
          <Notice
            title="This link isn't working"
            body="The check-in link may be mistyped, or the visit may have been cancelled or moved. Please contact the clinic for a new link."
          />
        )}

        {state.kind === "error" && (
          <Notice title="Something went wrong" body={state.message} />
        )}

        {state.kind === "done" && (
          <div className="rounded-xl border border-teal-200 bg-white p-6 text-center shadow-sm">
            <CheckCircle2 className="mx-auto h-10 w-10 text-teal-600" />
            <h1 className="mt-3 text-xl font-semibold text-gray-900">
              Thank you, {state.visit.clientFirstName}!
            </h1>
            <p className="mt-2 text-sm leading-6 text-gray-600">
              We've saved {state.visit.patientName}'s check-in. Your
              veterinarian will read it before the visit on{" "}
              {formatVisitTime(
                state.visit.startTime,
                state.visit.practiceTimezone,
              )}
              .
            </p>
            <p className="mt-4 text-sm text-gray-600">
              Need to change something? You can open this same link again until
              the visit.
            </p>
            <button
              type="button"
              onClick={() => setState({ kind: "ready", visit: state.visit })}
              className="mt-4 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Edit my answers
            </button>
          </div>
        )}

        {state.kind === "ready" && (
          <div>
            <div className="mb-6">
              <h1 className="text-2xl font-semibold text-gray-900">
                Check-in for {state.visit.patientName}
              </h1>
              <p className="mt-1 text-sm text-gray-600">
                {state.visit.visitTypeName
                  ? `${state.visit.visitTypeName} · `
                  : ""}
                {formatVisitTime(
                  state.visit.startTime,
                  state.visit.practiceTimezone,
                )}
              </p>
              <p className="mt-3 text-sm leading-6 text-gray-600">
                Hi {state.visit.clientFirstName}, please tell us about{" "}
                {state.visit.patientName} before the visit so we can make the
                most of our time together. Only the first question is required;
                answer whatever you can.
              </p>
              {state.visit.submittedAt && state.visit.open && (
                <p className="mt-3 rounded-lg bg-teal-50 px-3 py-2 text-sm text-teal-800">
                  You already sent this form. Any changes you save now will
                  replace your earlier answers.
                </p>
              )}
            </div>

            {!state.visit.open ? (
              <Notice
                title="This check-in is closed"
                body={
                  state.visit.submittedAt
                    ? "Thanks, we have your answers. The form closes once the visit starts or is cancelled. Please call or message the clinic with any updates."
                    : "The form closes once the visit starts or is cancelled. Please call or message the clinic with anything you'd like us to know."
                }
              />
            ) : (
              <form
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit(state.visit);
                }}
                className="space-y-6"
              >
                {CHECK_IN_SECTIONS.map((section) => (
                  <fieldset
                    key={section.key}
                    className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm"
                  >
                    <legend className="sr-only">{section.title}</legend>
                    <h2 className="text-lg font-semibold text-gray-900">
                      {section.title}
                    </h2>
                    {"intro" in section && section.intro && (
                      <p className="mt-1 text-sm text-gray-500">
                        {section.intro}
                      </p>
                    )}
                    <div className="mt-4 space-y-5">
                      {section.questions.map((question) => (
                        <QuestionField
                          key={question.key}
                          question={question}
                          value={answers[question.key as CheckInAnswerKey]}
                          onChange={(value) =>
                            setAnswer(question.key as CheckInAnswerKey, value)
                          }
                          disabled={submitting}
                          required={question.key === "mainConcerns"}
                        />
                      ))}
                    </div>
                  </fieldset>
                ))}

                {submitError && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                  >
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    {submitError}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-teal-600 px-4 py-3 text-base font-semibold text-white shadow-sm hover:bg-teal-700 disabled:opacity-60"
                >
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {state.visit.submittedAt
                    ? "Save changes"
                    : "Send check-in form"}
                </button>
                <p className="pb-8 text-center text-xs text-gray-500">
                  Your answers go to {state.visit.practiceName} and are added to{" "}
                  {state.visit.patientName}'s record for the care team to
                  review.
                </p>
              </form>
            )}
          </div>
        )}
      </main>
    </>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 text-center shadow-sm">
      <AlertCircle className="mx-auto h-8 w-8 text-gray-400" />
      <h1 className="mt-3 text-lg font-semibold text-gray-900">{title}</h1>
      <p className="mt-2 text-sm leading-6 text-gray-600">{body}</p>
    </div>
  );
}

function QuestionField({
  question,
  value,
  onChange,
  disabled,
  required,
}: {
  question: CheckInQuestion;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  disabled: boolean;
  required: boolean;
}) {
  const id = `check-in-${question.key}`;
  const hintId = `${id}-hint`;
  const groupId = useId();
  const label = question.label;

  if (question.kind === "choice") {
    return (
      <div role="radiogroup" aria-labelledby={groupId}>
        <div id={groupId} className="text-sm font-medium text-gray-800">
          {label}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {question.options.map((option) => {
            const selected = value === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                onClick={() => onChange(selected ? undefined : option.value)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-sm transition-colors",
                  selected
                    ? "border-teal-600 bg-teal-600 text-white"
                    : "border-gray-300 bg-white text-gray-700 hover:border-teal-400",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-800">
        {label}
        {required && <span className="ml-1 text-red-600">*</span>}
      </label>
      {question.hint && (
        <p id={hintId} className="mt-0.5 text-xs text-gray-500">
          {question.hint}
        </p>
      )}
      <textarea
        id={id}
        aria-describedby={question.hint ? hintId : undefined}
        aria-required={required || undefined}
        value={value ?? ""}
        onChange={(event) => onChange(event.currentTarget.value)}
        disabled={disabled}
        rows={question.rows ?? 2}
        maxLength={CHECK_IN_TEXT_MAX_LENGTH}
        className="mt-1.5 w-full resize-y rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:opacity-60 sm:text-sm"
      />
    </div>
  );
}
