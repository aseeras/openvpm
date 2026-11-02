"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Glasses, Loader2, Mic, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { assistantHintsForPath } from "@/components/agent/assistant-launcher";
import {
  captureGlassesPhoto,
  glassesAvailable,
  glassesErrorMessage,
  glassesListen,
  glassesModeStatus,
  GLASSES_MODE_EVENT,
  GLASSES_MODE_OFF,
  readGlassesModeState,
  startGlassesMode,
  stopGlassesMode,
  type GlassesModeState,
} from "@/lib/glasses/native-glasses";
import { useGlassesAction } from "@/lib/glasses/page-actions";
import { uploadClinicalPhoto } from "@/lib/glasses/upload-photo";

/**
 * Glasses mode for the staff iPhone app. While it is on, the Meta glasses'
 * capture button saves a photo to the patient on screen, a long press (or
 * "Hey Meta, start ZenPaws") listens for a request such as "record visit" or
 * a question for the assistant, and replies play in the glasses. Meta Ray-Ban
 * Display glasses also show the reply on the lens. Hidden outside the app.
 */
export function GlassesMode() {
  const pathname = usePathname();
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState<GlassesModeState>(GLASSES_MODE_OFF);
  const [starting, setStarting] = useState(false);
  const hints = assistantHintsForPath(pathname);
  const appointment = trpc.appointments.getById.useQuery(
    { id: hints.appointmentId ?? "" },
    { enabled: available && state.active && Boolean(hints.appointmentId) },
  );
  const patientId = hints.patientId ?? appointment.data?.patientId ?? null;

  useEffect(() => {
    const isAvailable = glassesAvailable();
    setAvailable(isAvailable);
    if (!isAvailable) return;
    void glassesModeStatus().then(setState);
    const onChange = (event: Event) =>
      setState(readGlassesModeState((event as CustomEvent).detail));
    window.addEventListener(GLASSES_MODE_EVENT, onChange);
    return () => window.removeEventListener(GLASSES_MODE_EVENT, onChange);
  }, []);

  // Any page: the capture button saves a clinical photo to the patient on
  // screen. Pages with a better place for it (the holistic workup) take over.
  useGlassesAction(
    "photo",
    async () => {
      if (!patientId) return "Open a patient or a visit first, then take the photo.";
      const result = await captureGlassesPhoto();
      if (result.status === "cancelled") return "Photo cancelled.";
      if (result.status === "error") return result.message;
      try {
        await uploadClinicalPhoto(result.file, patientId);
        toast.success("Glasses photo saved to the chart");
        return "Photo saved to the chart.";
      } catch (error) {
        const message = error instanceof Error ? error.message : "Upload failed";
        toast.error(message);
        return "The photo didn't save. Check the phone.";
      }
    },
    available,
    true,
  );

  if (!available) return null;

  async function turnOn() {
    setStarting(true);
    try {
      setState(await startGlassesMode());
    } catch (error) {
      toast.error(glassesErrorMessage(error));
    } finally {
      setStarting(false);
    }
  }

  async function turnOff() {
    try {
      setState(await stopGlassesMode());
    } catch {
      setState(GLASSES_MODE_OFF);
    }
  }

  async function talk() {
    try {
      setState(await glassesListen());
    } catch (error) {
      toast.error(glassesErrorMessage(error));
    }
  }

  if (!state.active) {
    return (
      <button
        type="button"
        onClick={() => void turnOn()}
        disabled={starting}
        className="fixed bottom-20 right-5 z-40 inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-2 text-sm font-medium shadow-md print:hidden"
        aria-label="Turn on glasses mode"
      >
        {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Glasses className="h-4 w-4" />}
        Glasses
      </button>
    );
  }

  const status = state.listening
    ? "Listening..."
    : state.busy
      ? "Working on it..."
      : state.reply ??
        (state.buttons
          ? "Hold the capture button to talk, or press it for a photo."
          : "Tap the microphone to talk.");

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-20 right-5 z-40 flex w-[min(22rem,calc(100vw-2.5rem))] items-start gap-2 rounded-2xl border border-primary/40 bg-background p-3 text-sm shadow-lg print:hidden"
    >
      <Glasses className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          Glasses mode{state.display ? " · lens on" : ""}
        </p>
        {state.heard && !state.listening ? (
          <p className="truncate text-xs text-muted-foreground">You said: {state.heard}</p>
        ) : null}
        <p className="line-clamp-3 text-muted-foreground">{status}</p>
      </div>
      <button
        type="button"
        onClick={() => void talk()}
        disabled={state.listening || state.busy}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-50"
        aria-label="Talk to ZenPaws through the glasses"
      >
        {state.listening || state.busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Mic className="h-4 w-4" />
        )}
      </button>
      <button
        type="button"
        onClick={() => void turnOff()}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent"
        aria-label="Turn off glasses mode"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
