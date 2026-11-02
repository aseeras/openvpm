"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Browser speech-to-text for the assistant composer. Uses the Web Speech API
 * (Chrome, Edge, Safari on iOS and macOS); the button hides itself where the
 * browser has no recognizer. Audio is handled by the browser, and only the
 * final text is handed to `onText`.
 */

type RecognitionResultEvent = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};

interface BrowserRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
}

type RecognitionConstructor = new () => BrowserRecognition;

function recognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function DictationButton({
  disabled,
  onText,
}: {
  disabled?: boolean;
  onText: (text: string) => void;
}) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<BrowserRecognition | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  useEffect(() => {
    setSupported(recognitionConstructor() !== null);
    return () => recognitionRef.current?.abort();
  }, []);

  useEffect(() => {
    if (disabled && listening) recognitionRef.current?.stop();
  }, [disabled, listening]);

  if (!supported) return null;

  function start() {
    const Recognition = recognitionConstructor();
    if (!Recognition) return;
    setError(null);
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang =
      (typeof navigator !== "undefined" && navigator.language) || "en-US";
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result?.isFinal) {
          const text = result[0].transcript.trim();
          if (text) onTextRef.current(text);
        }
      }
    };
    recognition.onerror = (event) => {
      setError(
        event.error === "not-allowed" || event.error === "service-not-allowed"
          ? "Microphone access is blocked. Allow it in your browser settings."
          : event.error === "no-speech"
            ? null
            : "Dictation stopped. Tap the mic to try again.",
      );
    };
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      setError("Dictation could not start. Tap the mic to try again.");
    }
  }

  function stop() {
    recognitionRef.current?.stop();
  }

  return (
    <div className="flex items-center gap-2">
      {error ? (
        <span role="status" className="max-w-[12rem] text-xs text-destructive">
          {error}
        </span>
      ) : listening ? (
        <span role="status" className="text-xs text-primary">
          Listening…
        </span>
      ) : null}
      <button
        type="button"
        onClick={listening ? stop : start}
        disabled={disabled && !listening}
        aria-pressed={listening}
        aria-label={listening ? "Stop dictation" : "Dictate"}
        title={listening ? "Stop dictation" : "Dictate"}
        className={cn(
          "inline-flex h-8 w-8 items-center justify-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          listening
            ? "animate-pulse border-destructive bg-destructive text-destructive-foreground"
            : "border-border bg-card text-muted-foreground hover:text-foreground",
        )}
      >
        {listening ? <Square className="h-3.5 w-3.5" /> : <Mic className="h-4 w-4" />}
      </button>
    </div>
  );
}
