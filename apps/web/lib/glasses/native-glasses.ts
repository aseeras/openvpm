/**
 * Browser side of Meta smart glasses (Ray-Ban Meta, Oakley Meta, Meta Ray-Ban
 * Display). Only the ZenPaws VPM staff iPhone app can reach the glasses: its
 * native plugin connects to them through the Meta AI app and takes a photo
 * with the glasses' camera. The page then uploads the photo like any other
 * clinical photo, so it lands on the patient that is open.
 */

export const GLASSES_PLUGIN = "ZenPawsGlasses";

/**
 * Sent by the staff app whenever glasses mode changes: turned on or off,
 * listening, thinking, or a new spoken reply.
 */
export const GLASSES_MODE_EVENT = "zenpaws:glasses-mode";

export type GlassesModeState = {
  /** Glasses mode is on: the capture button and voice reach ZenPaws. */
  active: boolean;
  /** The glasses microphone is listening for a request. */
  listening: boolean;
  /** Working on a request (asking the assistant, taking a photo). */
  busy: boolean;
  /** The connected glasses have a display (Meta Ray-Ban Display). */
  display: boolean;
  /** The glasses' capture button reaches ZenPaws (needs Meta's approval). */
  buttons: boolean;
  /** The last thing said to or by the glasses, for the phone screen. */
  heard?: string;
  reply?: string;
};

export const GLASSES_MODE_OFF: GlassesModeState = {
  active: false,
  listening: false,
  busy: false,
  display: false,
  buttons: false,
};

/** Reads a mode event's detail, ignoring anything malformed. */
export function readGlassesModeState(detail: unknown): GlassesModeState {
  const value = (detail ?? {}) as Record<string, unknown>;
  const text = (key: string) =>
    typeof value[key] === "string" && value[key] ? (value[key] as string) : undefined;
  return {
    active: value.active === true,
    listening: value.listening === true,
    busy: value.busy === true,
    display: value.display === true,
    buttons: value.buttons === true,
    heard: text("heard"),
    reply: text("reply"),
  };
}

type CapacitorBridge = {
  isNativePlatform?: () => boolean;
  isPluginAvailable?: (name: string) => boolean;
  nativePromise?: (plugin: string, method: string, options?: unknown) => Promise<unknown>;
};

function capacitor(): CapacitorBridge | null {
  if (typeof window === "undefined") return null;
  return ((window as unknown as { Capacitor?: CapacitorBridge }).Capacitor) ?? null;
}

export function glassesAvailable(): boolean {
  const cap = capacitor();
  return Boolean(
    cap?.isNativePlatform?.() && cap.isPluginAvailable?.(GLASSES_PLUGIN) && cap.nativePromise,
  );
}

export type GlassesPhotoResult =
  | { status: "ok"; file: File }
  | { status: "cancelled" }
  | { status: "error"; message: string };

const NOT_IN_APP = "Glasses photos work in the ZenPaws VPM iPhone app.";
const GENERIC_FAILURE = "The glasses didn't take a photo. Check they are on and connected, then try again.";

/** Turns the plugin's base64 JPEG into a File the upload form accepts. */
export function glassesPhotoToFile(
  value: unknown,
  now: Date = new Date(),
): File | null {
  const result = value as { base64?: unknown; mimeType?: unknown } | null;
  if (!result || typeof result.base64 !== "string" || result.base64.length === 0) return null;
  const mimeType = result.mimeType === "image/png" ? "image/png" : "image/jpeg";
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const binary = atob(result.base64);
    bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const extension = mimeType === "image/png" ? "png" : "jpg";
  return new File([bytes], `glasses-${stamp}.${extension}`, { type: mimeType });
}

/**
 * Takes one photo with the connected glasses. The first time, the app sends
 * the vet to the Meta AI app to allow ZenPaws to use the glasses.
 */
export async function captureGlassesPhoto(): Promise<GlassesPhotoResult> {
  const cap = capacitor();
  if (!cap?.nativePromise || !glassesAvailable()) {
    return { status: "error", message: NOT_IN_APP };
  }
  let value: unknown;
  try {
    value = await cap.nativePromise(GLASSES_PLUGIN, "capturePhoto", {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/cancel/i.test(message)) return { status: "cancelled" };
    // The plugin's messages are written for staff; anything else is not.
    const friendly = (error as { code?: unknown })?.code === "GLASSES" && message.length < 200;
    return { status: "error", message: friendly ? message : GENERIC_FAILURE };
  }
  const file = glassesPhotoToFile(value);
  if (!file) return { status: "error", message: GENERIC_FAILURE };
  return { status: "ok", file };
}

async function callMode(method: "startMode" | "stopMode" | "listen" | "modeStatus"): Promise<GlassesModeState> {
  const cap = capacitor();
  if (!cap?.nativePromise || !glassesAvailable()) return GLASSES_MODE_OFF;
  return readGlassesModeState(await cap.nativePromise(GLASSES_PLUGIN, method, {}));
}

/**
 * Turns on glasses mode: the glasses' capture button takes photos for the
 * open patient, a long press (or "Hey Meta, start ZenPaws") listens for a
 * request, and replies play in the glasses. Throws with a staff-readable
 * message when the glasses can't be reached.
 */
export function startGlassesMode(): Promise<GlassesModeState> {
  return callMode("startMode");
}

export function stopGlassesMode(): Promise<GlassesModeState> {
  return callMode("stopMode");
}

/** Listens through the glasses microphone for one request. */
export function glassesListen(): Promise<GlassesModeState> {
  return callMode("listen");
}

export function glassesModeStatus(): Promise<GlassesModeState> {
  return callMode("modeStatus").catch(() => GLASSES_MODE_OFF);
}

/** A staff-readable message from a failed mode call. */
export function glassesErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const friendly = (error as { code?: unknown })?.code === "GLASSES" && message.length < 200;
  return friendly ? message : GENERIC_FAILURE;
}
