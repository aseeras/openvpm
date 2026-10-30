"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Captions, FileText, Loader2, Square } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";

type CallVisit = {
  id: string;
  transcriptStatus: string;
  transcriptError: string | null;
};

/**
 * During a video visit: ask the client to agree to a transcript, see
 * whether it is running, and stop it. The client answers in their app.
 */
export function CallTranscriptControls({ visit }: { visit: CallVisit }) {
  const utils = trpc.useUtils();
  const refresh = () => utils.telehealth.queue.invalidate();
  const onError = (error: { message: string }) => toast.error(error.message);
  const request = trpc.telehealth.requestTranscript.useMutation({
    onSuccess: async () => {
      toast.success("Asked the client to allow a transcript.");
      await refresh();
    },
    onError,
  });
  const stop = trpc.telehealth.stopTranscript.useMutation({
    onSuccess: refresh,
    onError,
  });

  const status = visit.transcriptStatus;
  if (status === "requested") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          Waiting for the client to allow a transcript
        </Badge>
        <Button type="button" variant="ghost" size="sm" disabled={stop.isPending} onClick={() => stop.mutate({ visitId: visit.id })}>
          Cancel
        </Button>
      </div>
    );
  }
  if (status === "active") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Badge>
          <span className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" aria-hidden="true" />
          Recording audio for the transcript (client agreed)
        </Badge>
        <Button type="button" variant="outline" size="sm" disabled={stop.isPending} onClick={() => stop.mutate({ visitId: visit.id })}>
          <Square className="mr-1.5 h-3.5 w-3.5" />
          Stop transcript
        </Button>
      </div>
    );
  }
  if (status === "stopped" || status === "processing" || status === "ready") {
    return (
      <Badge variant="outline">
        <Captions className="mr-1 h-3 w-3" />
        Transcript recorded · it will be ready after the call
      </Badge>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" disabled={request.isPending} onClick={() => request.mutate({ visitId: visit.id })}>
        <Captions className="mr-2 h-4 w-4" />
        Transcribe visit
      </Button>
      {status === "declined" ? (
        <span className="text-sm text-muted-foreground">The client said no to a transcript.</span>
      ) : null}
      {status === "failed" && visit.transcriptError ? (
        <span className="text-sm text-destructive">{visit.transcriptError}</span>
      ) : null}
    </div>
  );
}

type FinishedVisit = {
  id: string;
  patientId: string;
  appointmentId: string | null;
  transcriptStatus: string;
  transcriptError: string | null;
};

const SYNC_INTERVAL_MS = 10_000;

/**
 * After a video visit: fetch the transcript when it is ready, read it, and
 * write the visit note (drafted from the transcript when there is one).
 */
export function FinishedVisitNote({ visit, canWrite }: { visit: FinishedVisit; canWrite: boolean }) {
  const utils = trpc.useUtils();
  const sync = trpc.telehealth.syncTranscript.useMutation({
    onSuccess: async (result) => {
      if (result.transcriptStatus !== "processing") await utils.telehealth.queue.invalidate();
    },
  });
  const processing = visit.transcriptStatus === "processing" || visit.transcriptStatus === "stopped";
  const ready = visit.transcriptStatus === "ready";
  const transcript = trpc.telehealth.transcript.useQuery(
    { visitId: visit.id },
    { enabled: canWrite && ready, staleTime: 60_000 },
  );

  useEffect(() => {
    if (!canWrite || !processing) return;
    sync.mutate({ visitId: visit.id });
    const timer = setInterval(() => sync.mutate({ visitId: visit.id }), SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canWrite, processing, visit.id]);

  if (!canWrite) return null;
  const noteHref = visit.appointmentId
    ? `/records/new-soap/${visit.patientId}?appointmentId=${visit.appointmentId}${ready ? `&telehealthVisitId=${visit.id}` : ""}`
    : null;

  return (
    <div className="mt-2 w-full space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {processing ? (
          <Badge variant="outline">
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            Saving transcript
          </Badge>
        ) : null}
        {visit.transcriptStatus === "failed" ? (
          <span className="text-xs text-destructive">{visit.transcriptError ?? "The transcript could not be saved."}</span>
        ) : null}
        {noteHref ? (
          <Button asChild size="sm" variant={ready ? "default" : "outline"}>
            <Link href={noteHref}>
              <FileText className="mr-1.5 h-3.5 w-3.5" />
              {ready ? "Write note from transcript" : "Write visit note"}
            </Link>
          </Button>
        ) : null}
      </div>
      {ready && transcript.data?.transcript ? (
        <details className="rounded-md border border-border bg-muted/20 p-3">
          <summary className="cursor-pointer text-sm font-medium">
            Transcript
            {transcript.data.consent
              ? ` · ${transcript.data.consent.signerName} agreed at ${new Date(transcript.data.consent.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
              : ""}
          </summary>
          <div className="mt-2 max-h-80 space-y-1.5 overflow-y-auto text-sm">
            {transcript.data.transcript.split("\n").map((line, index) => {
              const at = line.indexOf(": ");
              return at > 0 && at < 60 ? (
                <p key={index}>
                  <span className="font-medium">{line.slice(0, at)}:</span> {line.slice(at + 2)}
                </p>
              ) : (
                <p key={index}>{line}</p>
              );
            })}
          </div>
        </details>
      ) : null}
    </div>
  );
}
