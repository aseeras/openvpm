"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, Send, Trash2, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

type AssistantItem = {
  id: string;
  status: string;
  dedupeKey?: string | null;
  content: string | null;
};

/**
 * Staff controls on texting-assistant entries in the Inbox: send or discard
 * a drafted reply, and approve or decline a visit the assistant held.
 */
export function AssistantActions({
  item,
  canMutate,
  onChanged,
}: {
  item: AssistantItem;
  canMutate: boolean;
  onChanged?: () => void;
}) {
  const utils = trpc.useUtils();
  const isDraft = item.status === "draft";
  const isBooking =
    item.dedupeKey?.startsWith("assistant:booking:") === true &&
    item.status !== "read";
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.content ?? "");

  const refresh = () => {
    void utils.communications.listConversations.invalidate();
    void utils.communications.getByClient.invalidate();
    onChanged?.();
  };
  const onError = (error: { message: string }) => toast.error(error.message);

  const sendDraft = trpc.textingAssistant.sendDraft.useMutation({
    onSuccess: () => {
      toast.success("Text sent");
      setEditing(false);
      refresh();
    },
    onError,
  });
  const discardDraft = trpc.textingAssistant.discardDraft.useMutation({
    onSuccess: () => {
      toast.success("Draft discarded");
      refresh();
    },
    onError,
  });
  const decide = trpc.textingAssistant.decideBooking.useMutation({
    onSuccess: (result, input) => {
      const verb =
        input.decision === "approve" ? "Visit confirmed" : "Visit declined";
      toast.success(
        result.texted
          ? `${verb}. The client was texted.`
          : result.error
            ? `${verb}, but the text failed: ${result.error}`
            : `${verb}. A reply to the client is waiting as a draft.`,
      );
      refresh();
    },
    onError,
  });

  if (!canMutate || (!isDraft && !isBooking)) return null;
  const busy =
    sendDraft.isPending || discardDraft.isPending || decide.isPending;

  if (isBooking) {
    return (
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            decide.mutate({ communicationId: item.id, decision: "approve" })
          }
        >
          {decide.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          Approve visit
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            decide.mutate({ communicationId: item.id, decision: "decline" })
          }
        >
          <X className="h-3.5 w-3.5" />
          Decline
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      {editing ? (
        <textarea
          value={text}
          maxLength={600}
          onChange={(event) => setText(event.target.value)}
          rows={4}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || (editing && !text.trim())}
          onClick={() =>
            sendDraft.mutate({
              communicationId: item.id,
              ...(editing ? { content: text.trim() } : {}),
            })
          }
        >
          {sendDraft.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          Send
        </Button>
        {!editing ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => discardDraft.mutate({ communicationId: item.id })}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Discard
        </Button>
      </div>
    </div>
  );
}
