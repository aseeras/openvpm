/**
 * Browser side of Meta smart glasses (Ray-Ban Meta, Oakley Meta, Meta Ray-Ban
 * Display). Only the ZenPaws VPM staff iPhone app can reach the glasses: its
 * native plugin connects to them through the Meta AI app and takes a photo
 * with the glasses' camera. The page then uploads the photo like any other
 * clinical photo, so it lands on the patient that is open.
 */

export const GLASSES_PLUGIN = "ZenPawsGlasses";

/**
 * Sent by the staff app when the vet says "Hey Meta, start ZenPaws" (or
 * presses the glasses capture shortcut): a page that can take a glasses
 * photo for the open patient does so.
 */
export const GLASSES_CAPTURE_EVENT = "zenpaws:glasses-capture";

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
