"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Bot, Loader2, Save } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  TEXTING_ASSISTANT_INFO_MAX_LENGTH,
  TEXTING_ASSISTANT_INTRO_MAX_LENGTH,
  type TextingAssistantMode,
  type TextingAssistantSettings,
} from "@/lib/texting-assistant/settings";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MODES: Array<{
  value: TextingAssistantMode;
  label: string;
  help: string;
}> = [
  { value: "off", label: "Off", help: "Staff answer every text." },
  {
    value: "draft",
    label: "Draft replies",
    help: "The assistant writes replies in the Inbox; staff send them.",
  },
  {
    value: "live",
    label: "Reply automatically",
    help: "The assistant texts clients back on its own.",
  },
];

/**
 * Admin settings for the texting assistant: an AI that answers client texts
 * from the clinic's own info sheet. It never confirms visits; it holds the
 * time and staff approve or decline in the Inbox.
 */
export function TextingAssistantCard() {
  const utils = trpc.useUtils();
  const { data, isLoading, error } = trpc.textingAssistant.getSettings.useQuery(
    undefined,
    { retry: false },
  );
  const [draft, setDraft] = useState<TextingAssistantSettings | null>(null);
  const save = trpc.textingAssistant.updateSettings.useMutation({
    onSuccess: async (saved) => {
      setDraft(saved);
      await utils.textingAssistant.getSettings.invalidate();
      toast.success("Texting assistant saved");
    },
    onError: (mutationError) => toast.error(mutationError.message),
  });

  // Only admins can see or change this.
  if (error) return null;
  if (isLoading || !data) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading texting assistant…
      </div>
    );
  }

  const current: TextingAssistantSettings = draft ?? {
    mode: data.mode,
    info: data.info,
    hours: data.hours,
    intro: data.intro,
    sharePrices: data.sharePrices,
  };
  const update = (patch: Partial<TextingAssistantSettings>) =>
    setDraft({ ...current, ...patch });

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4 sm:p-5">
      <div>
        <p className="flex items-center gap-2 font-medium">
          <Bot className="h-4 w-4" /> Texting assistant (AI)
        </p>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Answers client texts using only the info sheet below. It never gives
          medical advice, sends emergencies to a 24-hour hospital, hands
          anything else to staff, and holds requested visits for you to approve
          in the Inbox. It goes quiet for 12 hours after staff reply.
        </p>
      </div>

      {!data.aiConfigured ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          AI isn&apos;t set up on this server yet, so the assistant will only
          send emergency and after-hours notes.
        </p>
      ) : null}
      {current.mode === "live" && !data.textingEnabled ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          Outgoing texting isn&apos;t active yet, so automatic replies will
          fail. Use Draft replies until texting is approved.
        </p>
      ) : null}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Mode</legend>
        {MODES.map((mode) => (
          <label key={mode.value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="texting-assistant-mode"
              className="mt-1"
              checked={current.mode === mode.value}
              onChange={() => update({ mode: mode.value })}
            />
            <span>
              <span className="font-medium">{mode.label}</span>
              <span className="text-muted-foreground"> · {mode.help}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="space-y-1">
        <label htmlFor="texting-assistant-info" className="text-sm font-medium">
          Info sheet
        </label>
        <p className="text-xs text-muted-foreground">
          Services, area served, how visits work, what to expect. The assistant
          says only what is written here.
        </p>
        <textarea
          id="texting-assistant-info"
          value={current.info}
          maxLength={TEXTING_ASSISTANT_INFO_MAX_LENGTH}
          onChange={(event) => update({ info: event.target.value })}
          rows={10}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={current.sharePrices}
          onChange={(event) => update({ sharePrices: event.target.checked })}
        />
        Let the assistant share prices from the info sheet
      </label>

      <div className="space-y-1">
        <label
          htmlFor="texting-assistant-intro"
          className="text-sm font-medium"
        >
          First-message introduction
        </label>
        <Input
          id="texting-assistant-intro"
          value={current.intro}
          maxLength={TEXTING_ASSISTANT_INTRO_MAX_LENGTH}
          placeholder="Hi, this is the clinic assistant (AI)."
          onChange={(event) => update({ intro: event.target.value })}
        />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Office hours</p>
        <p className="text-xs text-muted-foreground">
          Outside these hours the assistant sends one &quot;we&apos;re
          closed&quot; note and leaves the rest for staff.
        </p>
        <div className="flex flex-wrap gap-3">
          {DAYS.map((label, day) => (
            <label key={label} className="flex items-center gap-1.5 text-sm">
              <Checkbox
                checked={current.hours.days.includes(day)}
                onChange={(event) =>
                  update({
                    hours: {
                      ...current.hours,
                      days: event.target.checked
                        ? [...current.hours.days, day].sort()
                        : current.hours.days.filter((d) => d !== day),
                    },
                  })
                }
              />
              {label}
            </label>
          ))}
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Input
            type="time"
            className="w-32"
            value={current.hours.start}
            onChange={(event) =>
              update({ hours: { ...current.hours, start: event.target.value } })
            }
          />
          to
          <Input
            type="time"
            className="w-32"
            value={current.hours.end}
            onChange={(event) =>
              update({ hours: { ...current.hours, end: event.target.value } })
            }
          />
        </div>
      </div>

      <Button
        disabled={save.isPending || !draft}
        onClick={() => save.mutate(current)}
      >
        {save.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Save className="h-4 w-4" />
        )}
        Save
      </Button>
    </div>
  );
}
