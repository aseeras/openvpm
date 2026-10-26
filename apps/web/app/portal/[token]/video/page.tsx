"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  FileText,
  Loader2,
  Mic,
  MicOff,
  Star,
  Video,
  VideoOff,
  X,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import {
  TELEHEALTH_FEE_LABEL,
  TELEHEALTH_POLL_INTERVAL_MS,
  TELEHEALTH_VISIT_LABEL,
} from "@/lib/telehealth/visits";
import { portalLogo, ZP } from "@/lib/portal/zenpaws-theme";
import { PetAvatar } from "@/components/portal/pet-avatar";

const WAITING_TIPS = [
  "Find a quiet, well-lit spot",
  "Keep your pet close by",
  "Have current meds and supplements handy",
];

function elapsed(since: Date | string | null): string {
  if (!since) return "";
  const total = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function minutesBetween(a: Date | string | null, b: Date | string | null): number | null {
  if (!a || !b) return null;
  return Math.max(1, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000));
}

/**
 * Video visits in the ZenPaws app: pick the pet and reason, wait in the
 * virtual waiting room, take the call, then see the visit summary.
 */
export default function PortalVideoVisitPage() {
  const router = useRouter();
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
  const [dismissedSummary, setDismissedSummary] = useState<string | null>(() => {
    try {
      return typeof window === "undefined"
        ? null
        : window.sessionStorage.getItem("zp-video-summary-dismissed");
    } catch {
      return null;
    }
  });
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
  const answerTranscript = trpc.portalTelehealth.answerTranscript.useMutation({
    onSettled: () => void utils.portalTelehealth.status.invalidate(),
    onError: (e) => setError(e.message),
  });
  const stopTranscript = trpc.portalTelehealth.stopTranscript.useMutation({
    onSettled: () => void utils.portalTelehealth.status.invalidate(),
    onError: (e) => setError(e.message),
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
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin" style={{ color: ZP.accent }} aria-label="Loading" />
      </div>
    );
  }
  if (status.error || !data) {
    return (
      <Panel title="Unable to load video visits">
        Your sign-in may have expired. Open the latest link from the clinic, or call us.
      </Panel>
    );
  }

  // 4 · The call.
  if (visit?.status === "in_call") {
    return (
      <CallScreen
        url={callUrl}
        joining={join.isPending}
        error={error}
        logoUrl={data.practiceLogoUrl}
        clinicianName={visit.clinicianName}
        startedAt={visit.startedAt}
        patientName={visit.patientName}
        onRejoin={() => join.mutate({ visitId: visit.id })}
        onClose={() => router.push("/portal")}
        transcript={{
          status: visit.transcriptStatus,
          disclosure: visit.transcriptDisclosure,
          busy: answerTranscript.isPending || stopTranscript.isPending,
          onAnswer: (allow) => answerTranscript.mutate({ visitId: visit.id, allow }),
          onStop: () => stopTranscript.mutate({ visitId: visit.id }),
        }}
      />
    );
  }

  // 3 · Waiting room.
  if (visit?.status === "waiting") {
    return (
      <WaitingRoom
        logoUrl={data.practiceLogoUrl}
        patientName={visit.patientName}
        patientPhotoUrl={visit.patientPhotoUrl}
        reason={visit.reason}
        ahead={visit.ahead}
        leaving={cancel.isPending}
        onLeave={() => cancel.mutate({ visitId: visit.id })}
      />
    );
  }

  // 5 · Visit summary, right after the call ends.
  const closed = data.lastClosed;
  if (closed?.status === "completed" && dismissedSummary !== closed.id) {
    return (
      <VisitSummary
        visit={closed}
        onDone={() => {
          setDismissedSummary(closed.id);
          try {
            window.sessionStorage.setItem("zp-video-summary-dismissed", closed.id);
          } catch {
            // Private browsing: the summary may show once more, which is fine.
          }
        }}
      />
    );
  }

  // 2 · Start a visit.
  const selectedPet = data.pets.find((pet) => pet.id === patientId) ?? null;
  const available = data.configured && data.accepting;
  const canSubmit = available && selectedPet?.established === true && Boolean(reason) && !request.isPending;

  return (
    <div className="pb-48">
      <StepHeader step="Step 1 of 2" title="What's going on?" backHref="/portal" />

      {closed?.status === "declined" ? (
        <div role="status" className="mb-4 rounded-2xl p-3.5 text-[13px] font-semibold" style={{ backgroundColor: ZP.sunSoft, color: ZP.sunInk }}>
          The clinic couldn&apos;t take your last video visit request.
          {closed.declineReason ? ` ${closed.declineReason}` : ""}
        </div>
      ) : null}

      {!available ? (
        <Panel title={data.configured ? "Video visits are paused right now" : "Video visits are coming soon"}>
          Send us a message or book a house call, and we&apos;ll get back to you.
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Link href="/portal/messages" className="flex min-h-11 items-center justify-center rounded-full border text-sm font-extrabold" style={{ borderColor: ZP.border }}>
              Message us
            </Link>
            <Link href="/portal/book" className="flex min-h-11 items-center justify-center rounded-full text-sm font-extrabold text-white" style={{ backgroundColor: ZP.accent }}>
              Book a visit
            </Link>
          </div>
        </Panel>
      ) : (
        <form
          id="video-request"
          className="space-y-4"
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
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-extrabold">Who is this visit for?</legend>
            <div className="grid grid-cols-2 gap-2.5">
              {data.pets.map((pet) => {
                const selected = patientId === pet.id;
                return (
                  <label
                    key={pet.id}
                    className={`flex min-h-[60px] items-center gap-2.5 rounded-[18px] border-2 bg-white p-2.5 ${pet.established ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}
                    style={{ borderColor: selected ? ZP.accent : ZP.border, backgroundColor: selected ? ZP.chip : "#fff" }}
                  >
                    <input
                      type="radio"
                      name="pet"
                      className="sr-only"
                      value={pet.id}
                      disabled={!pet.established}
                      checked={selected}
                      onChange={() => setPatientId(pet.id)}
                    />
                    <PetAvatar name={pet.name} photoUrl={pet.photoUrl} size={40} />
                    <span className="min-w-0">
                      <span className="block truncate text-base font-extrabold">{pet.name}</span>
                      {!pet.established ? (
                        <span className="block text-[11px] font-semibold leading-tight" style={{ color: ZP.muted }}>
                          Needs an in-person first visit
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>
            {data.pets.length === 0 ? (
              <p className="text-sm" style={{ color: ZP.muted }}>No pets on file yet.</p>
            ) : null}
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-sm font-extrabold">Reason for the visit</legend>
            <div className="flex flex-wrap gap-2">
              {data.reasons.map((item) => {
                const on = reason === item;
                return (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setReason(item)}
                    className="h-10 rounded-full border px-3.5 text-sm font-bold"
                    style={{
                      backgroundColor: on ? ZP.ink : "#fff",
                      color: on ? "#fff" : ZP.ink,
                      borderColor: on ? ZP.ink : "#C4DDF2",
                    }}
                  >
                    {item}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <label className="block">
            <span className="mb-1.5 block text-sm font-extrabold">Anything the veterinarian should know?</span>
            <textarea
              value={notes}
              maxLength={1000}
              rows={3}
              onChange={(event) => setNotes(event.currentTarget.value)}
              placeholder="e.g. Stiffer getting up this week, still eating well"
              className="w-full resize-none rounded-2xl border bg-white px-3.5 py-3 text-[15px]"
              style={{ borderColor: "#C4DDF2", color: ZP.ink }}
            />
          </label>

          <div role="note" className="flex items-start gap-2.5 rounded-2xl p-3.5" style={{ backgroundColor: ZP.dangerSoft }}>
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" style={{ color: ZP.danger }} aria-hidden="true" />
            <span className="text-[13px] font-semibold leading-snug text-[#6E140E]">
              Trouble breathing, collapse, bloated belly or a toxin? Go to your nearest 24-hour emergency hospital now.
            </span>
          </div>
          {error ? <p role="alert" className="text-sm font-semibold" style={{ color: ZP.danger }}>{error}</p> : null}
        </form>
      )}

      {available ? (
        <StickyFooter>
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-bold" style={{ color: ZP.muted }}>{TELEHEALTH_VISIT_LABEL}</span>
            <span className="text-base font-black">{TELEHEALTH_FEE_LABEL}</span>
          </div>
          <button
            type="submit"
            form="video-request"
            disabled={!canSubmit}
            className="flex h-[52px] w-full items-center justify-center gap-2 rounded-full font-extrabold text-white disabled:opacity-50"
            style={{ backgroundColor: ZP.accent }}
          >
            {request.isPending ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : null}
            Continue to waiting room
          </button>
          <Link href="/portal/book" className="block text-center text-sm font-extrabold" style={{ color: ZP.accent }}>
            New patient? Book an in-home exam
          </Link>
        </StickyFooter>
      ) : null}
    </div>
  );
}

function StepHeader({ step, title, backHref }: { step: string; title: string; backHref: string }) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <Link
        href={backHref}
        aria-label="Back"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border bg-white"
        style={{ borderColor: ZP.border }}
      >
        <ChevronLeft className="h-5 w-5" aria-hidden="true" />
      </Link>
      <div>
        <p className="text-xs font-extrabold uppercase tracking-[0.1em]" style={{ color: ZP.accent }}>{step}</p>
        <h1 className="text-[22px] font-black leading-tight">{title}</h1>
      </div>
    </div>
  );
}

function StickyFooter({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-20 border-t bg-white"
      style={{ borderColor: ZP.border, paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto max-w-md space-y-2.5 px-5 pb-6 pt-3.5">{children}</div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-3xl border bg-white p-5" style={{ borderColor: ZP.border }}>
      <p className="text-lg font-extrabold">{title}</p>
      <div className="mt-1 text-sm" style={{ color: ZP.muted }}>{children}</div>
    </section>
  );
}

function WaitingRoom({
  logoUrl,
  patientName,
  patientPhotoUrl,
  reason,
  ahead,
  leaving,
  onLeave,
}: {
  logoUrl: string | null;
  patientName: string;
  patientPhotoUrl: string | null;
  reason: string;
  ahead: number;
  leaving: boolean;
  onLeave: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [preview, setPreview] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [online, setOnline] = useState(true);
  const [tips, setTips] = useState<boolean[]>([false, false, false]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      // Release the camera so the call can use it.
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function toggleCamera() {
    if (preview) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setPreview(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;
      stream.getAudioTracks().forEach((track) => (track.enabled = micOn));
      if (videoRef.current) videoRef.current.srcObject = stream;
      setPreview(true);
    } catch {
      setPreview(false);
    }
  }

  function toggleMic() {
    const next = !micOn;
    setMicOn(next);
    streamRef.current?.getAudioTracks().forEach((track) => (track.enabled = next));
  }

  const progress = ahead === 0 ? 70 : Math.max(15, 60 - ahead * 15);
  const pill = (on: boolean) =>
    ({
      backgroundColor: on ? ZP.chip : ZP.dangerSoft,
      color: on ? ZP.accentDark : ZP.danger,
      borderColor: on ? ZP.sky : "#F5C2BD",
    }) as const;

  return (
    <div className="pb-48">
      <StepHeader step="Step 2 of 2" title="Virtual waiting room" backHref="/portal" />

      <section className="flex flex-col items-center gap-3 rounded-3xl border bg-white p-5 text-center" style={{ borderColor: ZP.border }}>
        <div className="h-[104px] w-[104px] rounded-full border-4 p-1" style={{ borderColor: ZP.sky }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={portalLogo(logoUrl)} alt="" className="h-full w-full rounded-full object-cover" />
        </div>
        <div>
          <p className="text-xl font-black">
            {ahead === 0 ? "The veterinarian will join shortly" : "The veterinarian will be with you soon"}
          </p>
          <p className="text-sm font-bold" style={{ color: ZP.muted }}>
            {ahead === 0 ? "You're next" : `${ahead} ahead of you`} · {patientName} · {reason}
          </p>
        </div>
        <div className="h-2.5 w-full overflow-hidden rounded-full" style={{ backgroundColor: ZP.chip }}>
          <div className="h-2.5 rounded-full transition-all" style={{ width: `${progress}%`, backgroundColor: ZP.accent }} />
        </div>
      </section>

      <div className="mt-3 grid grid-cols-[132px_minmax(0,1fr)] gap-3">
        <div className="relative h-[172px] overflow-hidden rounded-[20px]" style={{ backgroundColor: ZP.ink }}>
          <video ref={videoRef} autoPlay muted playsInline className={`h-full w-full scale-x-[-1] object-cover ${preview ? "" : "hidden"}`} />
          {!preview ? (
            patientPhotoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={patientPhotoUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center px-3 text-center text-xs font-bold text-[#BFE3FB]">
                Tap Camera to check how you look
              </div>
            )
          ) : null}
          <span className="absolute bottom-2 left-2 rounded-lg px-2 py-0.5 text-[11px] font-extrabold text-white" style={{ backgroundColor: ZP.ink }}>
            Your camera
          </span>
        </div>
        <div className="flex flex-col gap-2.5">
          <button type="button" onClick={toggleMic} aria-pressed={micOn} className="flex h-11 items-center gap-2 rounded-[14px] border px-3 text-sm font-extrabold" style={pill(micOn)}>
            {micOn ? <Mic className="h-5 w-5" aria-hidden="true" /> : <MicOff className="h-5 w-5" aria-hidden="true" />}
            {micOn ? "Mic on" : "Mic off"}
          </button>
          <button type="button" onClick={() => void toggleCamera()} aria-pressed={preview} className="flex h-11 items-center gap-2 rounded-[14px] border px-3 text-sm font-extrabold" style={pill(preview)}>
            {preview ? <Video className="h-5 w-5" aria-hidden="true" /> : <VideoOff className="h-5 w-5" aria-hidden="true" />}
            {preview ? "Camera on" : "Camera"}
          </button>
          <div className="flex flex-1 items-center gap-2 rounded-2xl px-3 text-[13px] font-extrabold" style={{ backgroundColor: online ? "#E6F6EC" : ZP.dangerSoft, color: online ? "#1D6B3F" : ZP.danger }}>
            {online ? <Check className="h-4 w-4" aria-hidden="true" /> : <X className="h-4 w-4" aria-hidden="true" />}
            {online ? "Connection is good" : "You're offline"}
          </div>
        </div>
      </div>

      <section className="mt-4 space-y-2">
        <h2 className="text-base font-extrabold">While you wait</h2>
        {WAITING_TIPS.map((tip, index) => (
          <label key={tip} className="flex min-h-11 items-center gap-3 rounded-[14px] border bg-white px-3.5 text-sm font-bold" style={{ borderColor: ZP.border }}>
            <input
              type="checkbox"
              checked={tips[index]}
              onChange={() => setTips((current) => current.map((value, i) => (i === index ? !value : value)))}
              className="h-5 w-5 accent-[#1B78C2]"
            />
            {tip.replace("your pet", patientName)}
          </label>
        ))}
      </section>

      <StickyFooter>
        <p className="text-center text-[13px] font-bold" style={{ color: ZP.muted }}>
          Keep this screen open. Calls are not recorded.
        </p>
        <button
          type="button"
          disabled
          className="flex h-[52px] w-full items-center justify-center gap-2 rounded-full font-extrabold text-white opacity-70"
          style={{ backgroundColor: ZP.accent }}
        >
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          Waiting for the veterinarian…
        </button>
        <button type="button" disabled={leaving} onClick={onLeave} className="block w-full text-center text-sm font-extrabold" style={{ color: ZP.accent }}>
          Leave waiting room
        </button>
      </StickyFooter>
    </div>
  );
}

function CallScreen({
  url,
  joining,
  error,
  logoUrl,
  clinicianName,
  startedAt,
  patientName,
  onRejoin,
  onClose,
  transcript,
}: {
  url: string | null;
  joining: boolean;
  error: string | null;
  logoUrl: string | null;
  clinicianName: string | null;
  startedAt: Date | string | null;
  patientName: string;
  onRejoin: () => void;
  onClose: () => void;
  transcript: {
    status: string;
    disclosure: string | null;
    busy: boolean;
    onAnswer: (allow: boolean) => void;
    onStop: () => void;
  };
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ backgroundColor: "#0E2D47" }}>
      <div className="flex items-center justify-between gap-2 px-4 pb-2" style={{ paddingTop: "max(12px, env(safe-area-inset-top))" }}>
        <div className="flex min-w-0 items-center gap-2.5 rounded-full py-1.5 pl-1.5 pr-3.5 text-white" style={{ backgroundColor: "rgba(255,255,255,0.12)" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={portalLogo(logoUrl)} alt="" className="h-8 w-8 rounded-full bg-white object-cover" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-extrabold">{clinicianName ?? "Your veterinarian"}</span>
            <span className="block truncate text-xs font-bold text-[#BFE3FB]">
              {elapsed(startedAt)} · {patientName}&apos;s recheck
            </span>
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the call screen"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white"
          style={{ backgroundColor: "rgba(255,255,255,0.16)" }}
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
      {transcript.status === "active" ? (
        <div className="flex items-center justify-between gap-2 px-4 pb-2">
          <span className="flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-extrabold text-white" style={{ backgroundColor: "rgba(255,255,255,0.12)" }}>
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-400" aria-hidden="true" />
            Transcript on
          </span>
          <button
            type="button"
            onClick={transcript.onStop}
            disabled={transcript.busy}
            className="rounded-full px-3 py-1.5 text-xs font-extrabold text-white disabled:opacity-60"
            style={{ backgroundColor: "rgba(255,255,255,0.16)" }}
          >
            Stop transcript
          </button>
        </div>
      ) : null}
      {url ? (
        <iframe
          title="Video visit"
          src={url}
          allow="camera; microphone; autoplay; fullscreen; display-capture"
          className="w-full flex-1 border-0"
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center text-white">
          {joining ? (
            <>
              <Loader2 className="h-8 w-8 animate-spin" aria-hidden="true" />
              <p className="font-bold">Connecting your video call…</p>
            </>
          ) : (
            <>
              <p className="font-bold">{error ?? "Your veterinarian is ready."}</p>
              <button
                type="button"
                onClick={onRejoin}
                className="flex h-[52px] items-center gap-2 rounded-full px-6 font-extrabold"
                style={{ backgroundColor: ZP.sun, color: ZP.ink }}
              >
                <Video className="h-5 w-5" aria-hidden="true" />
                Join the visit
              </button>
            </>
          )}
        </div>
      )}
      {transcript.status === "requested" && transcript.disclosure ? (
        <div className="absolute inset-x-0 bottom-0 z-10 rounded-t-3xl bg-white p-5" role="dialog" aria-modal="false" aria-label="Allow a transcript of this visit" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 20px)", color: ZP.ink }}>
          <div className="mx-auto max-w-md space-y-3">
            <div className="flex items-center gap-2.5">
              <span className="flex h-10 w-10 items-center justify-center rounded-full" style={{ backgroundColor: ZP.chip, color: ZP.accent }}>
                <FileText className="h-5 w-5" aria-hidden="true" />
              </span>
              <h2 className="text-lg font-black">Allow a transcript of this visit?</h2>
            </div>
            <p className="text-sm leading-relaxed" style={{ color: ZP.muted }}>{transcript.disclosure}</p>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                disabled={transcript.busy}
                onClick={() => transcript.onAnswer(false)}
                className="min-h-12 rounded-full border font-extrabold disabled:opacity-60"
                style={{ borderColor: ZP.border }}
              >
                No thanks
              </button>
              <button
                type="button"
                disabled={transcript.busy}
                onClick={() => transcript.onAnswer(true)}
                className="min-h-12 rounded-full font-extrabold text-white disabled:opacity-60"
                style={{ backgroundColor: ZP.accent }}
              >
                Allow transcript
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function VisitSummary({
  visit,
  onDone,
}: {
  visit: {
    id: string;
    reason: string;
    startedAt: Date | string | null;
    endedAt: Date | string | null;
    patientName: string;
    patientPhotoUrl: string | null;
    clinicianName: string | null;
  };
  onDone: () => void;
}) {
  const router = useRouter();
  const [rating, setRating] = useState(0);
  const sendRating = trpc.portal.createMessage.useMutation();
  const minutes = minutesBetween(visit.startedAt, visit.endedAt);

  function rate(stars: number) {
    if (rating) return;
    setRating(stars);
    sendRating.mutate({
      content: `Video visit feedback for ${visit.patientName}: ${stars} out of 5 stars.`,
    });
  }

  return (
    <div className="pb-48">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-black">Visit summary</h1>
        <button
          type="button"
          aria-label="Close"
          onClick={() => {
            onDone();
            router.push("/portal");
          }}
          className="flex h-11 w-11 items-center justify-center rounded-full border bg-white"
          style={{ borderColor: ZP.border }}
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      <section className="flex items-center gap-3 rounded-[20px] border bg-white p-3" style={{ borderColor: ZP.border }}>
        <PetAvatar name={visit.patientName} photoUrl={visit.patientPhotoUrl} size={52} />
        <div>
          <p className="text-[17px] font-black">{visit.patientName} · Telehealth recheck</p>
          <p className="text-[13px] font-bold" style={{ color: ZP.muted }}>
            Today{minutes ? ` · ${minutes} min` : ""}
            {visit.clinicianName ? ` with ${visit.clinicianName}` : ""}
          </p>
        </div>
      </section>

      <section className="mt-3 space-y-2.5 rounded-[20px] border bg-white p-4" style={{ borderColor: ZP.border }}>
        <h2 className="text-base font-black">What happens next</h2>
        {[
          { n: "1", text: `Reason for the visit: ${visit.reason}`, tint: ZP.chip },
          { n: "2", text: "Your veterinarian's notes and care plan arrive in Messages.", tint: ZP.chip },
          { n: "3", text: "Need an in-home acupuncture follow-up? Book it below.", tint: ZP.sunSoft },
        ].map((item) => (
          <div key={item.n} className="flex items-start gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-black" style={{ backgroundColor: item.tint }}>
              {item.n}
            </span>
            <span className="text-sm font-bold leading-snug">{item.text}</span>
          </div>
        ))}
      </section>

      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <Link href="/portal/messages" className="rounded-[18px] border bg-white p-3" style={{ borderColor: ZP.border }}>
          <span className="block text-xs font-extrabold uppercase tracking-wide" style={{ color: ZP.muted }}>Notes</span>
          <span className="flex items-center gap-1.5 text-sm font-extrabold"><FileText className="h-4 w-4" aria-hidden="true" /> Open Messages</span>
        </Link>
        <Link href="/portal/invoices" className="rounded-[18px] border bg-white p-3" style={{ borderColor: ZP.border }}>
          <span className="block text-xs font-extrabold uppercase tracking-wide" style={{ color: ZP.muted }}>Billing</span>
          <span className="text-sm font-extrabold">View invoices</span>
        </Link>
      </div>

      <div className="mt-4 flex flex-col items-center gap-1.5">
        <span className="text-sm font-extrabold">{rating ? "Thanks for the feedback!" : "How was your visit?"}</span>
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              aria-label={`${n} star${n === 1 ? "" : "s"}`}
              aria-pressed={rating === n}
              disabled={rating > 0}
              onClick={() => rate(n)}
              className="flex h-11 w-11 items-center justify-center"
            >
              <Star className="h-[30px] w-[30px]" style={{ color: "#C99A00" }} fill={n <= rating ? ZP.sun : "none"} aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>

      <StickyFooter>
        <Link href="/portal/book" className="flex h-[52px] items-center justify-center rounded-full font-extrabold" style={{ backgroundColor: ZP.sun, color: ZP.ink }}>
          Book the acupuncture follow-up
        </Link>
        <button
          type="button"
          onClick={() => {
            onDone();
            router.push("/portal");
          }}
          className="block w-full py-1.5 text-center text-sm font-extrabold"
          style={{ color: ZP.accent }}
        >
          Done
        </button>
      </StickyFooter>
    </div>
  );
}
