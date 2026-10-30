"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  Loader2,
  Mic,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";

export type RecorderSoapDraft = {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
};

/** Longest single recording; a house call rarely runs past this. */
const MAX_RECORDING_MS = 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const SYNC_INTERVAL_MS = 5000;
const RECORDER_MIME_TYPES = [
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return RECORDER_MIME_TYPES.find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatTime(value: Date | string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

const STATUS_LABELS: Record<string, string> = {
  awaiting_audio: "Recording",
  transcribing: "Transcribing",
  transcribed: "Transcript ready",
  failed: "Failed",
  discarded: "Deleted",
};

type WakeLockSentinelLike = { release: () => Promise<void> };

/**
 * Record a house-call visit with the client's consent, send it for
 * transcription, and turn the transcript into a SOAP draft the clinician
 * edits before saving. Nothing here writes to the medical record.
 */
export function VisitRecorder({
  patientId,
  appointmentId,
  visitOpen,
  onDraft,
}: {
  patientId: string;
  appointmentId: string;
  visitOpen: boolean;
  onDraft: (draft: RecorderSoapDraft) => void;
}) {
  const utils = trpc.useUtils();
  const state = trpc.visitRecordings.forAppointment.useQuery({
    patientId,
    appointmentId,
  });
  const [askingConsent, setAskingConsent] = useState(false);
  const [signerName, setSignerName] = useState("");
  const [recording, setRecording] = useState<{
    id: string;
    startedAt: number;
  } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [uploading, setUploading] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);

  useUnsavedChangesGuard(
    Boolean(recording) || uploading,
    "A visit recording is in progress. Leave and lose it?",
  );

  const refresh = () =>
    utils.visitRecordings.forAppointment.invalidate({
      patientId,
      appointmentId,
    });

  const recordConsent = trpc.visitRecordings.recordConsent.useMutation({
    onSuccess: async (consent) => {
      setAskingConsent(false);
      setSignerName("");
      toast.success(
        consent.action === "granted"
          ? "Consent recorded. You can start recording."
          : "Recorded that the client declined.",
      );
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const start = trpc.visitRecordings.start.useMutation();
  const sync = trpc.visitRecordings.sync.useMutation();
  const discard = trpc.visitRecordings.discard.useMutation({
    onSuccess: async () => {
      toast.success("Recording deleted");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const draft = trpc.ai.draftSoapNote.useMutation({
    onSuccess: (result) => {
      onDraft(result);
      toast.success("Draft added to the note. Review it before saving.");
    },
    onError: (error) => toast.error(error.message),
  });

  const data = state.data;
  const transcribingIds =
    data?.recordings
      .filter((item) => item.status === "transcribing")
      .map((item) => item.id) ?? [];
  const transcribingKey = transcribingIds.join(",");

  // Poll transcriptions until each one finishes or fails.
  useEffect(() => {
    if (!transcribingKey) return;
    const ids = transcribingKey.split(",");
    const timer = setInterval(() => {
      void Promise.all(ids.map((id) => sync.mutateAsync({ recordingId: id })))
        .then((results) => {
          if (results.some((item) => item.status !== "transcribing")) {
            void refresh();
          }
        })
        .catch(() => {});
    }, SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcribingKey]);

  // Recording clock, with an automatic stop at the length cap.
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      const ms = Date.now() - recording.startedAt;
      setElapsed(ms);
      if (ms >= MAX_RECORDING_MS) stopRecording();
    }, 500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  useEffect(() => () => releaseDevices(), []);

  function releaseDevices() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
  }

  async function startRecording() {
    const mimeType = pickMimeType();
    if (!navigator.mediaDevices?.getUserMedia || !mimeType) {
      toast.error("This browser cannot record audio.");
      return;
    }
    let slot: { id: string };
    try {
      slot = await start.mutateAsync({ patientId, appointmentId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, {
        mimeType,
        audioBitsPerSecond: 48_000,
      });
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () =>
        void upload(slot.id, recorder.mimeType || mimeType);
      recorder.start(10_000);
      recorderRef.current = recorder;
      const wakeLock = (
        navigator as Navigator & {
          wakeLock?: {
            request: (type: "screen") => Promise<WakeLockSentinelLike>;
          };
        }
      ).wakeLock;
      wakeLockRef.current =
        (await wakeLock?.request("screen").catch(() => null)) ?? null;
      setElapsed(0);
      setRecording({ id: slot.id, startedAt: Date.now() });
      await refresh();
    } catch {
      releaseDevices();
      toast.error("Microphone access was blocked. Allow it and try again.");
      discard.mutate({ recordingId: slot.id });
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recorderRef.current = null;
  }

  async function upload(recordingId: string, mimeType: string) {
    releaseDevices();
    setRecording(null);
    const blob = new Blob(chunksRef.current, { type: mimeType });
    chunksRef.current = [];
    if (blob.size === 0) {
      toast.error("Nothing was recorded.");
      discard.mutate({ recordingId });
      return;
    }
    if (blob.size > MAX_UPLOAD_BYTES) {
      toast.error("The recording is too large to upload.");
      discard.mutate({ recordingId });
      return;
    }
    setUploading(true);
    let serverResponded = false;
    try {
      const response = await fetch(
        `/api/visit-recordings/${recordingId}/audio`,
        {
          method: "POST",
          headers: { "Content-Type": blob.type.split(";")[0] || "audio/mp4" },
          body: blob,
        },
      );
      serverResponded = true;
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        // 502 means the server kept the row as "failed" with a reason to show.
        if (response.status !== 502) {
          discard.mutate({ recordingId });
        }
        throw new Error(body?.error ?? "Upload failed.");
      }
      toast.success("Recording uploaded. Transcribing now.");
    } catch (error) {
      if (!serverResponded) {
        // Network failure: the audio never arrived, so free the slot.
        discard.mutate({ recordingId });
        toast.error("Upload failed. Check the connection and record again.");
      } else {
        toast.error(error instanceof Error ? error.message : "Upload failed.");
      }
    } finally {
      setUploading(false);
      await refresh();
    }
  }

  if (state.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking visit recording...
      </div>
    );
  }
  if (!data || !data.transcriptionConfigured) return null;

  const consent = data.consent;
  const busy = Boolean(recording) || uploading || start.isPending;

  return (
    <section
      aria-label="Visit recording"
      className="space-y-3 rounded-md border border-border bg-muted/10 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Mic className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">Record this visit</span>
        </div>
        {consent ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {consent.active ? (
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
            ) : null}
            {consent.action === "granted"
              ? `${consent.signerName} agreed at ${formatTime(consent.occurredAt)}`
              : `${consent.signerName} declined at ${formatTime(consent.occurredAt)}`}
          </span>
        ) : null}
      </div>

      {recording ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-2 text-sm font-medium text-destructive">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-destructive" />
            Recording {formatElapsed(elapsed)}
          </span>
          <Button type="button" variant="destructive" onClick={stopRecording}>
            <Square className="mr-2 h-4 w-4" />
            Stop and transcribe
          </Button>
          <span className="text-xs text-muted-foreground">
            Keep this screen open while recording.
          </span>
        </div>
      ) : uploading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Uploading the recording...
        </div>
      ) : askingConsent ? (
        <div className="space-y-3">
          <p className="text-sm font-medium">
            Read this to the client, or hand them the phone:
          </p>
          <div className="whitespace-pre-line rounded-md border border-border bg-background p-3 text-sm leading-relaxed">
            {data.disclosure}
          </div>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Client name</span>
            <Input
              value={signerName}
              maxLength={255}
              autoComplete="off"
              placeholder="Name of the person agreeing or declining"
              onChange={(event) => setSignerName(event.currentTarget.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={!signerName.trim() || recordConsent.isPending}
              onClick={() =>
                recordConsent.mutate({
                  patientId,
                  appointmentId,
                  signerName: signerName.trim(),
                  granted: true,
                  disclosureVersion: data.disclosureVersion,
                })
              }
            >
              <Check className="mr-2 h-4 w-4" />
              Client agrees
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!signerName.trim() || recordConsent.isPending}
              onClick={() =>
                recordConsent.mutate({
                  patientId,
                  appointmentId,
                  signerName: signerName.trim(),
                  granted: false,
                  disclosureVersion: data.disclosureVersion,
                })
              }
            >
              <X className="mr-2 h-4 w-4" />
              Client declines
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setAskingConsent(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {consent?.active ? (
            <Button
              type="button"
              disabled={!visitOpen || busy}
              onClick={() => void startRecording()}
            >
              {start.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Mic className="mr-2 h-4 w-4" />
              )}
              Start recording
            </Button>
          ) : null}
          <Button
            type="button"
            variant={consent?.active ? "outline" : "default"}
            disabled={!visitOpen || busy}
            onClick={() => setAskingConsent(true)}
          >
            <ShieldCheck className="mr-2 h-4 w-4" />
            {consent ? "Ask for consent again" : "Ask client for consent"}
          </Button>
          {!visitOpen ? (
            <span className="text-xs text-muted-foreground">
              Start the exam to record.
            </span>
          ) : null}
        </div>
      )}

      {data.recordings.length > 0 ? (
        <ul className="space-y-2">
          {data.recordings
            .filter(
              (item) =>
                item.status !== "awaiting_audio" || item.id === recording?.id,
            )
            .map((item) => (
              <li
                key={item.id}
                className="space-y-2 rounded-md border border-border bg-background p-2.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm">
                    <span>{formatTime(item.createdAt)}</span>
                    <Badge variant="outline">
                      {item.status === "transcribing" ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : null}
                      {STATUS_LABELS[item.status] ?? item.status}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {item.status === "transcribed" ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={
                          !data.aiConfigured || draft.isPending || !visitOpen
                        }
                        title={
                          data.aiConfigured
                            ? undefined
                            : "Add an AI key to the server to draft notes."
                        }
                        onClick={() =>
                          draft.mutate({ patientId, recordingId: item.id })
                        }
                      >
                        {draft.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Sparkles className="mr-2 h-4 w-4" />
                        )}
                        Draft note from recording
                      </Button>
                    ) : null}
                    {item.status !== "discarded" &&
                    item.id !== recording?.id ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={discard.isPending}
                        aria-label="Delete recording and transcript"
                        onClick={() => {
                          if (
                            window.confirm(
                              "Delete this recording's audio and transcript? This cannot be undone.",
                            )
                          ) {
                            discard.mutate({ recordingId: item.id });
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                </div>
                {item.status === "failed" && item.failureReason ? (
                  <p className="text-xs text-destructive">
                    {item.failureReason}
                  </p>
                ) : null}
                {item.status === "transcribed" && !data.aiConfigured ? (
                  <p className="text-xs text-muted-foreground">
                    AI drafting is off until an AI key is added to the server.
                  </p>
                ) : null}
                {item.transcript ? (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-muted-foreground">
                      Show transcript
                    </summary>
                    <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-2 font-sans text-xs leading-relaxed">
                      {item.transcript}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
        </ul>
      ) : null}
    </section>
  );
}
