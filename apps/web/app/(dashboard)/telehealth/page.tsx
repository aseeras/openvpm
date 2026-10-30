"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Loader2, PhoneOff, Video, VideoOff, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { TELEHEALTH_POLL_INTERVAL_MS } from "@/lib/telehealth/visits";
import {
  CallTranscriptControls,
  FinishedVisitNote,
} from "@/components/telehealth/transcript-controls";
import {
  VideoCallPanel,
  type VideoCallPanelHandle,
} from "@/components/telehealth/video-call-panel";
import type { VideoConnection } from "@/lib/telehealth/use-video-call";

const CLINICIAN_ROLES = new Set(["admin", "veterinarian"]);

function minutesSince(value: Date | string): string {
  const minutes = Math.max(
    0,
    Math.round((Date.now() - new Date(value).getTime()) / 60000),
  );
  return minutes === 0 ? "just now" : `${minutes} min`;
}

function formatTime(value: Date | string | null): string {
  return value
    ? new Date(value).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
}

const STATUS_LABEL: Record<string, string> = {
  completed: "Completed",
  cancelled: "Client left",
  declined: "Declined",
};

/**
 * The clinic's video-visit queue: turn video visits on or off, see who is
 * waiting, start the call next to the pet's chart, and end it.
 */
export default function TelehealthPage() {
  const { data: session } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role ?? "";
  const isClinician = CLINICIAN_ROLES.has(role);
  const utils = trpc.useUtils();
  const queue = trpc.telehealth.queue.useQuery(undefined, {
    refetchInterval: TELEHEALTH_POLL_INTERVAL_MS,
  });
  const [call, setCall] = useState<{ visitId: string; connection: VideoConnection } | null>(
    null,
  );

  const callPanel = useRef<VideoCallPanelHandle>(null);
  const [ending, setEnding] = useState(false);
  const refresh = () => utils.telehealth.queue.invalidate();
  const onError = (error: { message: string }) => toast.error(error.message);

  const setAccepting = trpc.telehealth.setAccepting.useMutation({
    onSuccess: async (result) => {
      toast.success(
        result.accepting
          ? "You're taking video visits."
          : "Video visits are paused.",
      );
      await refresh();
    },
    onError,
  });
  const start = trpc.telehealth.start.useMutation({
    onSuccess: async (result, input) => {
      setCall({ visitId: input.visitId, connection: result.connection });
      await refresh();
    },
    onError,
  });
  const rejoin = trpc.telehealth.rejoin.useMutation({
    onSuccess: (result, input) =>
      setCall({ visitId: input.visitId, connection: result.connection }),
    onError,
  });
  const end = trpc.telehealth.end.useMutation({
    onSuccess: async () => {
      setCall(null);
      toast.success("Visit ended");
      await refresh();
    },
    onError,
  });
  const decline = trpc.telehealth.decline.useMutation({
    onSuccess: async () => {
      toast.success("Request declined");
      await refresh();
    },
    onError,
  });

  if (queue.isLoading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading video visits...
      </div>
    );
  }
  if (queue.error || !queue.data) {
    return (
      <div className="p-6 text-sm text-destructive">
        Video visits could not be loaded. {queue.error?.message}
      </div>
    );
  }

  const data = queue.data;
  const activeCall = call
    ? data.open.find(
        (visit) => visit.id === call.visitId && visit.status === "in_call",
      )
    : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Video visits</h1>
          <p className="text-sm text-muted-foreground">
            Clients with established pets join from the client portal or the
            ZenPaws app. Video is never recorded. With the client&apos;s consent,
            the call audio is recorded for a written transcript and then deleted.
          </p>
        </div>
        {data.configured ? (
          <Button
            type="button"
            variant={data.accepting ? "outline" : "default"}
            disabled={!isClinician || setAccepting.isPending}
            onClick={() => setAccepting.mutate({ accepting: !data.accepting })}
          >
            {data.accepting ? (
              <VideoOff className="mr-2 h-4 w-4" />
            ) : (
              <Video className="mr-2 h-4 w-4" />
            )}
            {data.accepting
              ? "Pause video visits"
              : "Start taking video visits"}
          </Button>
        ) : null}
      </div>

      {!data.configured ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            Video visits are not set up on this server yet. An administrator
            needs to add the video service key.
          </CardContent>
        </Card>
      ) : (
        <div
          role="status"
          className={`rounded-md border px-3 py-2 text-sm ${
            data.accepting
              ? "border-emerald-500/40 bg-emerald-500/10"
              : "border-border bg-muted/20 text-muted-foreground"
          }`}
        >
          {data.accepting
            ? "Clients can join the waiting room now."
            : "Paused: clients see that video visits aren't available right now."}
        </div>
      )}

      {activeCall && call ? (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
            <div>
              <CardTitle>
                {activeCall.patientName} · {activeCall.clientName}
              </CardTitle>
              <CardDescription>{activeCall.reason}</CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <Link
                  href={`/patients/${activeCall.patientId}`}
                  target="_blank"
                >
                  Open chart
                </Link>
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={end.isPending || ending}
                onClick={async () => {
                  // Send any transcript audio before the call closes.
                  setEnding(true);
                  try {
                    await callPanel.current?.finishRecording();
                  } finally {
                    setEnding(false);
                  }
                  end.mutate({ visitId: activeCall.id });
                }}
              >
                <PhoneOff className="mr-2 h-4 w-4" />
                {ending ? "Saving audio…" : "End visit"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {isClinician ? <CallTranscriptControls visit={activeCall} /> : null}
            <VideoCallPanel
              key={call.visitId}
              ref={callPanel}
              connection={call.connection}
              clientName={activeCall.clientName}
              visitId={activeCall.id}
              transcriptStatus={activeCall.transcriptStatus}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Waiting and in progress</CardTitle>
          <CardDescription>
            Oldest first. Refreshes automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.open.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody is waiting.</p>
          ) : (
            <ul className="divide-y divide-border">
              {data.open.map((visit) => (
                <li
                  key={visit.id}
                  className="flex flex-wrap items-start justify-between gap-3 py-3"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/patients/${visit.patientId}`}
                        className="font-medium hover:underline"
                      >
                        {visit.patientName}
                      </Link>
                      <span className="text-sm text-muted-foreground">
                        {visit.clientName}
                        {visit.clientPhone ? ` · ${visit.clientPhone}` : ""}
                      </span>
                      <Badge
                        variant={
                          visit.status === "in_call" ? "default" : "outline"
                        }
                      >
                        {visit.status === "in_call"
                          ? `In call${visit.clinicianName ? ` with ${visit.clinicianName}` : ""}`
                          : `Waiting ${minutesSince(visit.createdAt)}`}
                      </Badge>
                    </div>
                    <p className="text-sm">{visit.reason}</p>
                    {visit.notes ? (
                      <p className="whitespace-pre-line text-sm text-muted-foreground">
                        {visit.notes}
                      </p>
                    ) : null}
                  </div>
                  {isClinician ? (
                    <div className="flex flex-wrap gap-2">
                      {visit.status === "waiting" ? (
                        <>
                          <Button
                            type="button"
                            disabled={start.isPending}
                            onClick={() => start.mutate({ visitId: visit.id })}
                          >
                            {start.isPending &&
                            start.variables?.visitId === visit.id ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <Video className="mr-2 h-4 w-4" />
                            )}
                            Start visit
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={decline.isPending}
                            aria-label={`Decline ${visit.patientName}'s request`}
                            onClick={() => {
                              const reason = window.prompt(
                                "Optional note for the client (for example: please book a house call):",
                              );
                              if (reason === null) return;
                              decline.mutate({
                                visitId: visit.id,
                                reason: reason || undefined,
                              });
                            }}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </>
                      ) : call?.visitId !== visit.id ? (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            disabled={rejoin.isPending}
                            onClick={() => rejoin.mutate({ visitId: visit.id })}
                          >
                            Rejoin call
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            disabled={end.isPending}
                            onClick={() => end.mutate({ visitId: visit.id })}
                          >
                            End
                          </Button>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {data.recent.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Earlier today</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border text-sm">
              {data.recent.map((visit) => (
                <li
                  key={visit.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span>
                    <Link
                      href={`/patients/${visit.patientId}`}
                      className="font-medium hover:underline"
                    >
                      {visit.patientName}
                    </Link>{" "}
                    <span className="text-muted-foreground">
                      · {visit.clientName} · {visit.reason}
                    </span>
                  </span>
                  <span className="text-muted-foreground">
                    {STATUS_LABEL[visit.status] ?? visit.status}
                    {visit.endedAt ? ` at ${formatTime(visit.endedAt)}` : ""}
                  </span>
                  {visit.status === "completed" ? (
                    <FinishedVisitNote visit={visit} canWrite={isClinician} />
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
