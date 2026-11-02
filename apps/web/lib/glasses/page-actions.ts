/**
 * Things the staff app's glasses mode can ask the open page to do, such as
 * "take a photo for this patient" or "start recording the visit". Pages
 * register a handler while they are on screen; the iPhone app runs it and
 * speaks the message it returns through the glasses.
 *
 * A page's own handler always beats an app-wide fallback (the layout's
 * "save the photo to the chart"), whatever order they registered in. Among
 * handlers of the same kind, the newest wins.
 */

import { useEffect, useRef } from "react";

export type GlassesActionName = "photo" | "recordStart" | "recordStop";

/** Resolves to what the glasses say back. */
export type GlassesActionHandler = () => Promise<string>;

type Entry = { handler: GlassesActionHandler; fallback: boolean };

/** The native side looks the handler up here by name. */
export const GLASSES_ACTIONS_GLOBAL = "zenpawsGlassesActions";

export type GlassesActionsTarget = {
  [GLASSES_ACTIONS_GLOBAL]?: Partial<Record<GlassesActionName, GlassesActionHandler>>;
};

const registry = new Map<GlassesActionName, Entry[]>();

function pick(entries: Entry[]): GlassesActionHandler | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (!entries[i].fallback) return entries[i].handler;
  }
  return entries[entries.length - 1]?.handler;
}

function publish(target: GlassesActionsTarget) {
  const current: Partial<Record<GlassesActionName, GlassesActionHandler>> = {};
  for (const [name, entries] of registry) {
    const handler = pick(entries);
    if (handler) current[name] = handler;
  }
  target[GLASSES_ACTIONS_GLOBAL] = current;
}

/** Registers a handler and returns a function that removes it. */
export function registerGlassesAction(
  name: GlassesActionName,
  handler: GlassesActionHandler,
  options: { fallback?: boolean; target?: GlassesActionsTarget } = {},
): () => void {
  const target = options.target ?? (window as unknown as GlassesActionsTarget);
  const entry: Entry = { handler, fallback: options.fallback === true };
  const entries = registry.get(name) ?? [];
  entries.push(entry);
  registry.set(name, entries);
  publish(target);
  return () => {
    const index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
    if (entries.length === 0) registry.delete(name);
    publish(target);
  };
}

/**
 * Keeps a glasses action registered while the component is mounted and
 * `enabled`. The latest `handler` is always the one that runs.
 */
export function useGlassesAction(
  name: GlassesActionName,
  handler: GlassesActionHandler,
  enabled = true,
  fallback = false,
) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!enabled) return;
    return registerGlassesAction(name, () => latest.current(), { fallback });
  }, [name, enabled, fallback]);
}
