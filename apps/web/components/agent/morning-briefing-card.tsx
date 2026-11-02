"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Sunrise } from "lucide-react";
import { trpc } from "@/lib/trpc";

function hourLabel(hour: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:00 ${suffix}`;
}

/**
 * Who gets the morning briefing email, and when. Administrators manage every
 * veterinarian and administrator; a veterinarian manages only themselves.
 */
export function MorningBriefingCard() {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const settings = trpc.agent.briefingSettings.useQuery(undefined, {
    enabled: open,
  });
  const update = trpc.agent.setBriefing.useMutation({
    onSuccess: () => utils.agent.briefingSettings.invalidate(),
  });
  const data = settings.data;

  return (
    <div className="mb-3 rounded-xl border border-border bg-card text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
      >
        <Sunrise className="h-4 w-4 text-primary" />
        <span className="font-medium">Morning briefing email</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          Your visits, addresses and to-dos, emailed each morning
        </span>
        {open ? (
          <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {open ? (
        <div className="border-t border-border px-3 py-3">
          {settings.isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : settings.error ? (
            <p className="text-destructive">{settings.error.message}</p>
          ) : data ? (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Sent once a day (only when there is something on the schedule
                or waiting), using the clinic&apos;s time zone. It includes
                client names and addresses, so it goes only to the person&apos;s
                own login email.
              </p>
              <label className="flex items-center gap-2">
                <span>Send at</span>
                <select
                  value={data.hour}
                  disabled={!data.canManageOthers || update.isPending}
                  onChange={(e) => {
                    const me = data.people.find((p) => p.isMe) ?? data.people[0];
                    if (!me) return;
                    update.mutate({
                      userId: me.id,
                      enabled: me.enabled,
                      hour: Number(e.target.value),
                    });
                  }}
                  className="rounded-md border border-border bg-background px-2 py-1"
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </select>
              </label>
              <ul className="space-y-1.5">
                {data.people.map((person) => (
                  <li key={person.id}>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={person.enabled}
                        disabled={update.isPending}
                        onChange={(e) =>
                          update.mutate({
                            userId: person.id,
                            enabled: e.target.checked,
                          })
                        }
                        className="h-4 w-4 rounded border-border"
                      />
                      <span>
                        {person.name}
                        {person.isMe ? " (you)" : ""}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              {update.error ? (
                <p className="text-xs text-destructive">{update.error.message}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
