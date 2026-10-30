"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Loader2, Mic, MicOff, Video, VideoOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { useVideoCall, type VideoConnection } from "@/lib/telehealth/use-video-call";

export type VideoCallPanelHandle = {
  /** Stop recording (if any) and upload it. Resolves when done. */
  finishRecording: () => Promise<void>;
};

type Props = {
  /** The clinician's signed connection to the visit's channel. */
  connection: VideoConnection;
  visitId: string;
  clientName: string;
  /** "active" means the client agreed and the call should be recorded. */
  transcriptStatus: string;
  onUploaded?: () => void;
};

function StreamVideo({ stream, muted, mirror, className }: { stream: MediaStream | null; muted?: boolean; mirror?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.srcObject = stream;
    if (stream) void element.play().catch(() => {});
  }, [stream]);
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

function preferredAudioType(): string {
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

/**
 * The clinician's side of a video visit: a direct WebRTC call with the
 * client. When the client has agreed to a transcript, the call audio is
 * recorded in stereo (clinician left, client right) and uploaded for Amazon
 * Transcribe when the transcript stops.
 */
export const VideoCallPanel = forwardRef<VideoCallPanelHandle, Props>(function VideoCallPanel(
  { connection, visitId, clientName, transcriptStatus, onUploaded },
  ref,
) {
  const rejoin = trpc.telehealth.rejoin.useMutation();
  const call = useVideoCall({
    connection,
    refreshConnection: async () => (await rejoin.mutateAsync({ visitId })).connection,
  });
  const localAudio = call.localAudioTrack;
  const remoteAudio = call.remoteAudioTrack;

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

  const connected = call.state === "connected" && call.remoteStream;

  return (
    <div className="relative h-[70vh] min-h-[420px] w-full overflow-hidden rounded-lg border border-border bg-black">
      {connected ? (
        <StreamVideo stream={call.remoteStream} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-white/80">
          {call.state === "starting" ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Starting your camera…
            </span>
          ) : call.state === "failed" ? (
            call.failure
          ) : (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Waiting for {clientName} to join…
            </span>
          )}
        </div>
      )}
      {call.localStream ? (
        <StreamVideo
          stream={call.localStream}
          muted
          mirror
          className="absolute right-3 top-3 h-28 w-48 rounded-md border border-white/70 bg-neutral-800 object-cover shadow-lg"
        />
      ) : null}
      {connected ? (
        <span className="absolute bottom-3 left-3 rounded-md bg-black/60 px-2 py-1 text-xs font-medium text-white">
          {clientName}
        </span>
      ) : null}
      <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-2">
        <Button
          type="button"
          size="sm"
          variant={call.micOn ? "secondary" : "destructive"}
          onClick={call.toggleMic}
          aria-label={call.micOn ? "Mute microphone" : "Unmute microphone"}
        >
          {call.micOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={call.cameraOn ? "secondary" : "destructive"}
          onClick={call.toggleCamera}
          aria-label={call.cameraOn ? "Turn camera off" : "Turn camera on"}
        >
          {call.cameraOn ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
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
