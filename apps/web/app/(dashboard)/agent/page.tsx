"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Bot, Loader2 } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
import { AgentChat } from "@/components/agent/agent-chat";
import { MorningBriefingCard } from "@/components/agent/morning-briefing-card";
import { canRunAgentRole } from "@/components/agent/assistant-launcher";
import { AGENT_INSTRUCTION_MAX_LENGTH } from "@/lib/agent/policy";

export default function AgentPage() {
  const router = useRouter();
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (
      <div className="mx-auto max-w-3xl rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking agent access...
        </div>
      </div>
    );
  }

  if (!canRunAgentRole(session?.user?.role)) {
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState
          icon={Bot}
          title="Agent access is restricted"
          description="Only administrators and veterinarians can run the OpenVPM Agent."
          action={{
            label: "Back to dashboard",
            onClick: () => router.push("/"),
          }}
        />
      </div>
    );
  }

  return <AgentRunner isAdmin={session?.user?.role === "admin"} />;
}

function AgentRunner({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  const prefilled = useRef(false);
  const [initialInstruction, setInitialInstruction] = useState<string>();
  const [autoSend, setAutoSend] = useState(false);

  // One-shot ?ask= prefill (guides deep-link here with a ready question).
  // ?send=1 also sends it, so a Siri Shortcut can ask in one step.
  // The params are stripped right away so a refresh will not re-run.
  useEffect(() => {
    if (prefilled.current || typeof window === "undefined") return;
    prefilled.current = true;
    const params = new URLSearchParams(window.location.search);
    const ask = params.get("ask");
    if (ask?.trim()) {
      setInitialInstruction(ask.trim().slice(0, AGENT_INSTRUCTION_MAX_LENGTH));
      setAutoSend(params.get("send") === "1");
      router.replace("/agent");
    }
  }, [router]);

  return (
    <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-3xl flex-col">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Bot className="h-5 w-5" />
        </div>
        <div>
          <h1 className="font-heading text-2xl font-semibold">OpenVPM Agent</h1>
          <p className="text-sm text-muted-foreground">
            Ask about your day, your patients or your clinic. It looks things
            up and, with your okay, does the work.
          </p>
        </div>
      </div>
      <MorningBriefingCard />
      <AgentChat
        isAdmin={isAdmin}
        variant="page"
        initialInstruction={initialInstruction}
        autoSend={autoSend}
      />
    </div>
  );
}
