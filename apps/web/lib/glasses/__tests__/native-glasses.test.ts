import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureGlassesPhoto,
  glassesAvailable,
  glassesPhotoToFile,
  GLASSES_PLUGIN,
} from "../native-glasses";

const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
const JPEG_BASE64 = Buffer.from(JPEG_BYTES).toString("base64");

function installCapacitor(nativePromise: (plugin: string, method: string) => Promise<unknown>, plugins = [GLASSES_PLUGIN]) {
  vi.stubGlobal("window", {
    Capacitor: {
      isNativePlatform: () => true,
      isPluginAvailable: (name: string) => plugins.includes(name),
      nativePromise,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("glassesAvailable", () => {
  it("is false in a normal browser", () => {
    expect(glassesAvailable()).toBe(false);
    vi.stubGlobal("window", {});
    expect(glassesAvailable()).toBe(false);
  });

  it("is false in an app build without the glasses plugin", () => {
    installCapacitor(async () => ({}), ["ZenPawsAppleSignIn"]);
    expect(glassesAvailable()).toBe(false);
  });

  it("is true in the staff app with the glasses plugin", () => {
    installCapacitor(async () => ({}));
    expect(glassesAvailable()).toBe(true);
  });
});

describe("glassesPhotoToFile", () => {
  it("turns the plugin's base64 JPEG into a named image file", async () => {
    const file = glassesPhotoToFile(
      { base64: JPEG_BASE64, mimeType: "image/jpeg" },
      new Date("2026-11-02T07:05:09.123Z"),
    );
    expect(file).not.toBeNull();
    expect(file!.type).toBe("image/jpeg");
    expect(file!.name).toBe("glasses-2026-11-02T07-05-09.jpg");
    expect(new Uint8Array(await file!.arrayBuffer())).toEqual(JPEG_BYTES);
  });

  it("treats anything but PNG as JPEG", () => {
    expect(glassesPhotoToFile({ base64: JPEG_BASE64, mimeType: "text/html" })!.type).toBe("image/jpeg");
  });

  it("rejects missing or broken data", () => {
    expect(glassesPhotoToFile(null)).toBeNull();
    expect(glassesPhotoToFile({})).toBeNull();
    expect(glassesPhotoToFile({ base64: "" })).toBeNull();
    expect(glassesPhotoToFile({ base64: "%%%not base64%%%" })).toBeNull();
  });
});

describe("captureGlassesPhoto", () => {
  it("explains that it only works in the app", async () => {
    await expect(captureGlassesPhoto()).resolves.toEqual({
      status: "error",
      message: "Glasses photos work in the ZenPaws VPM iPhone app.",
    });
  });

  it("asks the plugin for a photo and returns it as a file", async () => {
    const nativePromise = vi.fn(async () => ({ base64: JPEG_BASE64, mimeType: "image/jpeg" }));
    installCapacitor(nativePromise);
    const result = await captureGlassesPhoto();
    expect(nativePromise).toHaveBeenCalledWith(GLASSES_PLUGIN, "capturePhoto", {});
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.file.type).toBe("image/jpeg");
  });

  it("passes on the plugin's own message for staff", async () => {
    installCapacitor(async () => {
      throw Object.assign(new Error("Allow ZenPaws in the Meta AI app, then come back and take the photo again."), {
        code: "GLASSES",
      });
    });
    await expect(captureGlassesPhoto()).resolves.toEqual({
      status: "error",
      message: "Allow ZenPaws in the Meta AI app, then come back and take the photo again.",
    });
  });

  it("hides unexpected errors behind a plain message", async () => {
    installCapacitor(async () => {
      throw new Error("EXC_BAD_ACCESS in MWDATCore");
    });
    const result = await captureGlassesPhoto();
    expect(result).toEqual({
      status: "error",
      message: "The glasses didn't take a photo. Check they are on and connected, then try again.",
    });
  });

  it("reports an empty answer as a failure", async () => {
    installCapacitor(async () => ({}));
    expect((await captureGlassesPhoto()).status).toBe("error");
  });
});
