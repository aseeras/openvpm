"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  AlertTriangle,
  CalendarPlus,
  Loader2,
  LogOut,
  MessageSquare,
  Video,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { TELEHEALTH_POLL_INTERVAL_MS } from "@/lib/telehealth/visits";

/**
 * Video visits for established patients: pick the pet and reason, wait in
 * the virtual waiting room, and join the call once the veterinarian starts it.
 */
export default function PortalVideoVisitPage() {
  const utils = trpc.useUtils();
  const status = trpc.portalTelehealth.status.useQuery(undefined, {
    refetchInterval: TELEHEALTH_POLL_INTERVAL_MS,
    refetchIntervalInBackground: true,
  });
  const [patientId, setPatientId] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [callUrl, setCallUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const joinRequestedFor = useRef<string | null>(null);

  const request = trpc.portalTelehealth.request.useMutation({
    onSuccess: () => {
      setError(null);
      void utils.portalTelehealth.status.invalidate();
    },
    onError: (e) => setError(e.message),
  });
  const cancel = trpc.portalTelehealth.cancel.useMutation({
    onSuccess: () => void utils.portalTelehealth.status.invalidate(),
  });
  const join = trpc.portalTelehealth.join.useMutation({
    onSuccess: (result) => setCallUrl(result.url),
    onError: (e) => {
      joinRequestedFor.current = null;
      setError(e.message);
    },
  });

  const data = status.data;
  const visit = data?.visit ?? null;

  // When the veterinarian starts the call, fetch this client's pass once.
  useEffect(() => {
    if (visit?.status === "in_call" && joinRequestedFor.current !== visit.id) {
      joinRequestedFor.current = visit.id;
      join.mutate({ visitId: visit.id });
    }
    if (!visit || visit.status !== "in_call") {
      joinRequestedFor.current = null;
      setCallUrl(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visit?.id, visit?.status]);

  if (status.isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2
          className="h-8 w-8 animate-spin text-primary"
          aria-label="Loading"
        />
      </div>
    );
  }

  if (status.error || !data) {
    return (
      <Notice
        icon={<AlertCircle className="h-5 w-5" aria-hidden="true" />}
        title="Unable to load video visits"
        body="Your portal session may have expired. Please contact your clinic for a new link."
      />
    );
  }

  if (!data.configured) {
    return (
      <Notice
        icon={<Video className="h-5 w-5" aria-hidden="true" />}
        title="Video visits are coming soon"
        body={`${data.practiceName} isn't offering video visits through the portal yet. Please call or message the clinic.`}
      />
    );
  }

  // In the call.
  if (visit?.status === "in_call") {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-gray-900">
              Video visit for {visit.patientName}
            </h1>
            <p className="text-sm text-gray-500">{visit.reason}</p>
          </div>
          {callUrl ? (
            <button
              type="button"
              onClick={() => setCallUrl(null)}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-gray-300 px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              Leave call
            </button>
          ) : null}
        </div>
        {callUrl ? (
          <iframe
            title="Video visit"
            src={callUrl}
            allow="camera; microphone; autoplay; fullscreen; display-capture"
            className="h-[72vh] min-h-[420px] w-full rounded-2xl border border-gray-200 bg-gray-900"
          />
        ) : (
          <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center">
            {join.isPending ? (
              <Loader2
                className="mx-auto h-8 w-8 animate-spin text-primary"
                aria-label="Connecting"
              />
            ) : (
              <button
                type="button"
                onClick={() => join.mutate({ visitId: visit.id })}
                className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-primary px-6 font-semibold text-primary-foreground hover:bg-primary/90"
              >
                <Video className="h-5 w-5" aria-hidden="true" />
                Join the video call
              </button>
            )}
            {error ? (
              <p className="mt-3 text-sm text-red-700">{error}</p>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  // Waiting room.
  if (visit?.status === "waiting") {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <section className="rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-sm">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Video className="h-7 w-7" aria-hidden="true" />
          </span>
          <h1 className="mt-4 text-xl font-bold text-gray-900">
            You&apos;re in the waiting room
          </h1>
          <p className="mt-2 text-gray-600">
            {visit.ahead === 0
              ? "You're next. The veterinarian will start the call shortly."
              : `${visit.ahead} ${visit.ahead === 1 ? "family is" : "families are"} ahead of you.`}
          </p>
          <p className="mt-1 text-sm text-gray-500">
            {visit.patientName} · {visit.reason}
          </p>
          <div className="mt-5 flex items-center justify-center gap-2 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Keep this page open. The call opens here automatically.
          </div>
        </section>
        <section className="rounded-2xl border border-gray-200 bg-white p-5 text-sm text-gray-700">
          <p className="font-semibold text-gray-900">While you wait</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Find a quiet, well-lit spot.</li>
            <li>Keep {visit.patientName} close by.</li>
            <li>When the call opens, allow the camera and microphone.</li>
          </ul>
        </section>
        <button
          type="button"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate({ visitId: visit.id })}
          className="w-full min-h-11 rounded-xl text-sm font-semibold text-gray-600 hover:bg-gray-100"
        >
          Leave the waiting room
        </button>
      </div>
    );
  }

  // Request form.
  const selectedPet = data.pets.find((pet) => pet.id === patientId) ?? null;
  const canSubmit =
    data.accepting &&
    selectedPet?.established === true &&
    Boolean(reason) &&
    !request.isPending;

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Video visit</h1>
        <p className="mt-1 text-gray-500">
          Quick rechecks and questions with the veterinarian, from home.
        </p>
      </div>

      {data.lastClosed?.status === "declined" ? (
        <div
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          The clinic couldn&apos;t take your last video visit request.
          {data.lastClosed.declineReason
            ? ` ${data.lastClosed.declineReason}`
            : ""}
        </div>
      ) : data.lastClosed?.status === "completed" ? (
        <div
          role="status"
          className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-900"
        >
          Your video visit has ended. Thank you! Any follow-up will appear in
          Messages.
        </div>
      ) : null}

      <div
        role="note"
        className="flex gap-3 rounded-xl bg-red-50 p-4 text-sm text-red-800"
      >
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <span>
          Trouble breathing, collapse, a swollen belly or a possible poisoning?
          Go to your nearest 24-hour emergency hospital now.
        </span>
      </div>

      {!data.accepting ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <p className="font-semibold text-gray-900">
            The veterinarian isn&apos;t taking video visits right now.
          </p>
          <p className="mt-1 text-sm text-gray-600">
            Send a message or book a house call, and we&apos;ll get back to you.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <Link
              href="/portal/messages"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-gray-300 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              <MessageSquare className="h-4 w-4" aria-hidden="true" /> Message
              the clinic
            </Link>
            <Link
              href="/portal/book"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-gray-300 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              <CalendarPlus className="h-4 w-4" aria-hidden="true" /> Book a
              visit
            </Link>
          </div>
        </div>
      ) : (
        <form
          className="space-y-5 rounded-2xl border border-gray-200 bg-white p-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit || !selectedPet || !reason) return;
            request.mutate({
              patientId: selectedPet.id,
              reason: reason as (typeof data.reasons)[number],
              notes: notes.trim() || undefined,
            });
          }}
        >
          <fieldset>
            <legend className="text-sm font-semibold text-gray-900">
              Which pet?
            </legend>
            {data.pets.length === 0 ? (
              <p className="mt-2 text-sm text-gray-600">No pets on file yet.</p>
            ) : (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {data.pets.map((pet) => (
                  <label
                    key={pet.id}
                    className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border-2 px-3 py-2 ${
                      patientId === pet.id
                        ? "border-primary bg-primary/5"
                        : "border-gray-200"
                    } ${pet.established ? "" : "cursor-not-allowed opacity-60"}`}
                  >
                    <input
                      type="radio"
                      name="pet"
                      value={pet.id}
                      disabled={!pet.established}
                      checked={patientId === pet.id}
                      onChange={() => setPatientId(pet.id)}
                      className="h-4 w-4 accent-primary"
                    />
                    <span>
                      <span className="block font-semibold text-gray-900">
                        {pet.name}
                      </span>
                      {!pet.established ? (
                        <span className="block text-xs text-gray-600">
                          Needs an in-person first visit
                        </span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <fieldset>
            <legend className="text-sm font-semibold text-gray-900">
              What&apos;s going on?
            </legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {data.reasons.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={reason === item}
                  onClick={() => setReason(item)}
                  className={`min-h-10 rounded-full border px-4 text-sm font-medium ${
                    reason === item
                      ? "border-gray-900 bg-gray-900 text-white"
                      : "border-gray-300 bg-white text-gray-800 hover:bg-gray-50"
                  }`}
                >
                  {item}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="block">
            <span className="text-sm font-semibold text-gray-900">
              Anything the veterinarian should know? (optional)
            </span>
            <textarea
              value={notes}
              maxLength={1000}
              rows={3}
              onChange={(event) => setNotes(event.currentTarget.value)}
              placeholder="e.g. Stiffer getting up this week, still eating well"
              className="mt-2 w-full rounded-xl border border-gray-300 p-3 text-sm"
            />
          </label>

          {error ? (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {request.isPending ? (
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            ) : (
              <Video className="h-5 w-5" aria-hidden="true" />
            )}
            Join the waiting room
          </button>
          <p className="text-center text-xs text-gray-500">
            Video visits are for pets we&apos;ve already seen in person. Calls
            are not recorded.
          </p>
        </form>
      )}
    </div>
  );
}

function Notice({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <section className="mx-auto max-w-md rounded-2xl border border-gray-200 bg-white p-7 text-center">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        {icon}
      </span>
      <h1 className="mt-4 text-xl font-semibold text-gray-900">{title}</h1>
      <p className="mt-2 text-sm leading-6 text-gray-600">{body}</p>
    </section>
  );
}
