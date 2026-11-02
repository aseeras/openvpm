"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { Maximize2, Sparkles, X } from "lucide-react";
import { AgentChat, type AgentChatHints } from "./agent-chat";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function canRunAgentRole(role?: string | null): boolean {
  return role === "admin" || role === "veterinarian";
}

/**
 * What the clinician is looking at, read from the URL, so "this patient" and
 * "this visit" resolve without them naming it.
 */
export function assistantHintsForPath(pathname: string | null): AgentChatHints {
  if (!pathname) return {};
  const [, section, id] = pathname.split("/");
  if (!id || !UUID.test(id)) return {};
  if (section === "patients") return { patientId: id };
  if (section === "encounters") return { appointmentId: id };
  return {};
}

/**
 * "Ask" button available on every dashboard page for clinicians. Opens the
 * assistant in a side panel (full screen on phones) that knows which patient
 * or visit is on screen. Hidden on the full Agent page itself.
 */
export function AssistantLauncher() {
  const { data: session } = useSession();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const role = session?.user?.role;
  const onAgentPage = pathname === "/agent" || pathname?.startsWith("/agent/");
  const hints = assistantHintsForPath(pathname);
  const contextKey = `${hints.patientId ?? ""}:${hints.appointmentId ?? ""}`;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!canRunAgentRole(role) || onAgentPage) return null;

  return (
    <>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-40 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-medium text-primary-foreground shadow-lg transition-transform hover:scale-[1.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 print:hidden"
          aria-label="Ask the assistant"
        >
          <Sparkles className="h-4 w-4" />
          Ask
        </button>
      ) : (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="Assistant"
          className="fixed inset-0 z-50 flex flex-col bg-background p-3 shadow-2xl sm:inset-auto sm:bottom-4 sm:right-4 sm:top-4 sm:w-[26rem] sm:rounded-2xl sm:border sm:border-border print:hidden"
        >
          <div className="mb-2 flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Sparkles className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-heading text-base font-semibold">Assistant</p>
              {hints.patientId || hints.appointmentId ? (
                <p className="truncate text-xs text-muted-foreground">
                  Knows the {hints.appointmentId ? "visit" : "patient"} on
                  screen
                </p>
              ) : null}
            </div>
            <Link
              href="/agent"
              onClick={() => setOpen(false)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Open full page"
              title="Open full page"
            >
              <Maximize2 className="h-4 w-4" />
            </Link>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Close assistant"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {/* A new patient or visit on screen starts a fresh conversation. */}
          <AgentChat
            key={contextKey}
            isAdmin={role === "admin"}
            variant="panel"
            hints={hints}
            onNavigate={() => {
              if (window.matchMedia("(max-width: 639px)").matches) setOpen(false);
            }}
          />
        </div>
      )}
    </>
  );
}
