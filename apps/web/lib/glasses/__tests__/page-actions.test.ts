import { describe, expect, it } from "vitest";
import {
  GLASSES_ACTIONS_GLOBAL,
  registerGlassesAction,
  type GlassesActionsTarget,
} from "../page-actions";

const say = (text: string) => async () => text;

describe("registerGlassesAction", () => {
  it("publishes the handler for the native app to call", async () => {
    const target: GlassesActionsTarget = {};
    const remove = registerGlassesAction("recordStart", say("Recording."), { target });
    expect(await target[GLASSES_ACTIONS_GLOBAL]?.recordStart?.()).toBe("Recording.");
    remove();
    expect(target[GLASSES_ACTIONS_GLOBAL]?.recordStart).toBeUndefined();
  });

  it("prefers a page's own handler over the app-wide fallback in either order", async () => {
    const target: GlassesActionsTarget = {};
    const page = registerGlassesAction("photo", say("Added to the workup."), { target });
    const fallback = registerGlassesAction("photo", say("Saved to the chart."), {
      target,
      fallback: true,
    });
    expect(await target[GLASSES_ACTIONS_GLOBAL]?.photo?.()).toBe("Added to the workup.");
    page();
    expect(await target[GLASSES_ACTIONS_GLOBAL]?.photo?.()).toBe("Saved to the chart.");
    fallback();
    expect(target[GLASSES_ACTIONS_GLOBAL]?.photo).toBeUndefined();
  });

  it("uses the newest of several page handlers", async () => {
    const target: GlassesActionsTarget = {};
    const first = registerGlassesAction("recordStop", say("first"), { target });
    const second = registerGlassesAction("recordStop", say("second"), { target });
    expect(await target[GLASSES_ACTIONS_GLOBAL]?.recordStop?.()).toBe("second");
    second();
    expect(await target[GLASSES_ACTIONS_GLOBAL]?.recordStop?.()).toBe("first");
    first();
  });
});
