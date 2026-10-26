"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import Daily, { type DailyCall, type DailyParticipant } from "@daily-co/daily-js";
import { Loader2, Mic, MicOff, Video, VideoOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export type DailyCallPanelHandle = {
  /** Stop recording (if any) and upload it. Resolves when done. */
  finishRecording: () => Promise<void>;
};

type Props = {
  /** The clinician's join link: https://<domain>.daily.co/<room>?t=<token> */
  url: string;
  visitId: string;
  /** "active" means the client agreed and the call should be recorded. */
  transcriptStatus: string;
  onUploaded?: () => void;
};

function MediaTile({ track, muted, mirror, className }: { track?: MediaStreamTrack | null; muted?: boolean; mirror?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.srcObject = track ? new MediaStream([track]) : null;
  }, [track]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={className}
      style={mirror ? { transform: "scaleX(-1)" } : undefined}
    />
  );
}

function RemoteAudio({ track }: { track?: MediaStreamTrack | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.srcObject = track ? new MediaStream([track]) : null;
    if (track) void element.play().catch(() => {});
  }, [track]);
  return <audio ref={ref} autoPlay />;
}

function preferredAudioType(): string {
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

/**
 * The clinician's side of a video visit, joined with Daily's call object so
 * the page can hear both people. When the client has agreed to a
 * transcript, the call audio is recorded in stereo (clinician left, client
 * right) and uploaded for Amazon Transcribe when the transcript stops.
 */
export const DailyCallPanel = forwardRef<DailyCallPanelHandle, Props>(function DailyCallPanel(
  { url, visitId, transcriptStatus, onUploaded },
  ref,
) {
  const callRef = useRef<DailyCall | null>(null);
  const [participants, setParticipants] = useState<Record<string, DailyParticipant>>({});
  const [joining, setJoining] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const link = new URL(url);
    const token = link.searchParams.get("t") ?? undefined;
    link.search = "";
    const call = Daily.createCallObject({ dailyConfig: { avoidEval: true } });
    callRef.current = call;
    const refresh = () => setParticipants({ ...call.participants() });
    const events = [
      "joined-meeting",
      "participant-joined",
      "participant-updated",
      "participant-left",
      "track-started",
      "track-stopped",
    ] as const;
    for (const event of events) call.on(event, refresh);
    call.on("error", (event) => setFailure(event?.errorMsg ?? "The video call stopped."));
    call
      .join({ url: link.toString(), token })
      .then(() => refresh())
      .catch(() => setFailure("Could not join the video call."))
      .finally(() => setJoining(false));
    return () => {
      callRef.current = null;
      void call.leave().catch(() => {}).finally(() => call.destroy());
    };
  }, [url]);

  const local = participants.local;
  const remote = Object.values(participants).find((participant) => !participant.local);
  const localAudio = local?.tracks.audio.persistentTrack ?? null;
  const remoteAudio = remote?.tracks.audio.persistentTrack ?? null;

  // --- Recording for the transcript -------------------------------------
  const recording = useRef<{
    recorder: MediaRecorder;
    chunks: Blob[];
    context: AudioContext;
    merger: ChannelMergerNode;
    remoteSource: MediaStreamAudioSourceNode | null;
    remoteTrackId: string | null;
    type: string;
  } | null>(null);
  const [uploading, setUploading] = useState(false);

  const connect = (
    context: AudioContext,
    merger: ChannelMergerNode,
    track: MediaStreamTrack,
    channel: 0 | 1,
  ) => {
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const mono = context.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = "explicit";
    mono.channelInterpretation = "speakers";
    source.connect(mono);
    mono.connect(merger, 0, channel);
    return source;
  };

  const start = useCallback(() => {
    if (recording.current || !localAudio) return;
    const type = preferredAudioType();
    if (!type) {
      toast.error("This browser can't record the call. Use Chrome, Edge or Safari for transcripts.");
      return;
    }
    const context = new AudioContext();
    const merger = context.createChannelMerger(2);
    const destination = context.createMediaStreamDestination();
    destination.channelCount = 2;
    merger.connect(destination);
    connect(context, merger, localAudio, 0);
    const remoteSource = remoteAudio ? connect(context, merger, remoteAudio, 1) : null;
    const recorder = new MediaRecorder(destination.stream, { mimeType: type });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.start(1000);
    recording.current = {
      recorder,
      chunks,
      context,
      merger,
      remoteSource,
      remoteTrackId: remoteAudio?.id ?? null,
      type,
    };
  }, [localAudio, remoteAudio]);

  // The client may join or reconnect after recording starts.
  useEffect(() => {
    const current = recording.current;
    if (!current || !remoteAudio || current.remoteTrackId === remoteAudio.id) return;
    current.remoteSource?.disconnect();
    current.remoteSource = connect(current.context, current.merger, remoteAudio, 1);
    current.remoteTrackId = remoteAudio.id;
  }, [remoteAudio]);

  const finishRecording = useCallback(async () => {
    const current = recording.current;
    if (!current) return;
    recording.current = null;
    const stopped = new Promise<void>((resolve) => {
      current.recorder.onstop = () => resolve();
    });
    if (current.recorder.state !== "inactive") current.recorder.stop();
    await stopped;
    void current.context.close().catch(() => {});
    const blob = new Blob(current.chunks, { type: current.type });
    if (blob.size === 0) return;
    setUploading(true);
    try {
      const response = await fetch(`/api/telehealth/${visitId}/audio`, {
        method: "POST",
        headers: { "Content-Type": current.type.split(";")[0]! },
        body: blob,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? "The call audio could not be uploaded for the transcript.");
      } else {
        toast.success("Call audio sent for the transcript.");
        onUploaded?.();
      }
    } catch {
      toast.error("The call audio could not be uploaded for the transcript.");
    } finally {
      setUploading(false);
    }
  }, [visitId, onUploaded]);

  useImperativeHandle(ref, () => ({ finishRecording }), [finishRecording]);

  // Record while the transcript is on; stop and upload when it goes off.
  useEffect(() => {
    if (transcriptStatus === "active") start();
    else if (recording.current) void finishRecording();
  }, [transcriptStatus, start, finishRecording]);

  // Leaving the page mid-recording loses the audio; warn first.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (recording.current || uploading) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);

  const audioOn = local?.audio ?? false;
  const videoOn = local?.video ?? false;

  return (
    <div className="relative h-[70vh] min-h-[420px] w-full overflow-hidden rounded-lg border border-border bg-black">
      {remote ? (
        <MediaTile track={remote.tracks.video.persistentTrack} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-white/80">
          {joining ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Joining the call…
            </span>
          ) : (
            failure ?? "Waiting for the client to join…"
          )}
        </div>
      )}
      <RemoteAudio track={remoteAudio} />
      {local ? (
        <MediaTile
          track={local.tracks.video.persistentTrack}
          muted
          mirror
          className="absolute right-3 top-3 h-28 w-48 rounded-md border border-white/70 bg-neutral-800 object-cover shadow-lg"
        />
      ) : null}
      {remote ? (
        <span className="absolute bottom-3 left-3 rounded-md bg-black/60 px-2 py-1 text-xs font-medium text-white">
          {remote.user_name || "Client"}
        </span>
      ) : null}
      <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-2">
        <Button
          type="button"
          size="sm"
          variant={audioOn ? "secondary" : "destructive"}
          onClick={() => callRef.current?.setLocalAudio(!audioOn)}
          aria-label={audioOn ? "Mute microphone" : "Unmute microphone"}
        >
          {audioOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={videoOn ? "secondary" : "destructive"}
          onClick={() => callRef.current?.setLocalVideo(!videoOn)}
          aria-label={videoOn ? "Turn camera off" : "Turn camera on"}
        >
          {videoOn ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
        </Button>
      </div>
      {uploading ? (
        <span className="absolute left-3 top-3 flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 text-xs text-white">
          <Loader2 className="h-3 w-3 animate-spin" /> Sending call audio…
        </span>
      ) : null}
    </div>
  );
});
