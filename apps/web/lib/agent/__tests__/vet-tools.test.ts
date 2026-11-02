import { afterEach, describe, expect, it, vi } from "vitest";

const soapMocks = vi.hoisted(() => ({
  getAppointmentSoapDraft: vi.fn(),
  saveAppointmentSoapDraft: vi.fn(),
}));

vi.mock("@/lib/records/soap-lifecycle", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/records/soap-lifecycle")>();
  return {
    ...actual,
    getAppointmentSoapDraft: soapMocks.getAppointmentSoapDraft,
    saveAppointmentSoapDraft: soapMocks.saveAppointmentSoapDraft,
  };
});

import { AGENT_TOOLS, getTool, type AgentToolContext } from "../tools";
import {
  VET_ASSISTANT_TOOLS,
  directionsUrl,
  formatClientAddress,
  latestDosePerVaccine,
} from "../vet-tools";
import { buildRunContextPrompt } from "../runner";
import { SoapLifecycleError } from "@/lib/records/soap-lifecycle";

const PRACTICE_ID = "00000000-0000-0000-0000-000000000001";
const PATIENT_ID = "00000000-0000-0000-0000-000000000003";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000005";
const VET_ID = "00000000-0000-0000-0000-000000000004";

function soapCtx(role = "veterinarian"): AgentToolContext {
  const db = {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return {
    db: db as unknown as AgentToolContext["db"],
    practiceId: PRACTICE_ID,
    userId: VET_ID,
    staffUser: { id: VET_ID, name: "Dr. Example", role },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("vet assistant tool registry", () => {
  it("registers the clinician tools alongside the existing agent tools", () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    for (const name of [
      "get_my_day",
      "search_patient_history",
      "list_medications",
      "get_my_todo",
      "save_soap_draft",
    ]) {
      expect(names).toContain(name);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps everything read-only except the SOAP draft", () => {
    const writes = VET_ASSISTANT_TOOLS.filter((t) => !t.readOnly).map(
      (t) => t.name,
    );
    expect(writes).toEqual(["save_soap_draft"]);
    expect(getTool("save_soap_draft")?.requiredApiScopes).toEqual([
      "records:write",
    ]);
  });

  it("limits personal tools to signed-in staff", () => {
    expect(getTool("get_my_todo")?.requiresStaffUser).toBe(true);
    expect(getTool("save_soap_draft")?.requiresStaffUser).toBe(true);
    expect(getTool("get_my_day")?.requiresStaffUser).toBeFalsy();
  });

  it("never offers a tool that sends messages, prescribes, or finalizes", () => {
    const names = AGENT_TOOLS.map((t) => t.name).join(" ");
    expect(names).not.toMatch(/send|prescri|finaliz|refill/);
  });
});

describe("vet assistant input validation", () => {
  it("get_my_day accepts only YYYY-MM-DD dates", () => {
    const zod = getTool("get_my_day")!.zod;
    expect(zod.safeParse({}).success).toBe(true);
    expect(zod.safeParse({ date: "2026-11-02", onlyMine: true }).success).toBe(
      true,
    );
    expect(zod.safeParse({ date: "11/02/2026" }).success).toBe(false);
  });

  it("search_patient_history bounds the page and record types", () => {
    const zod = getTool("search_patient_history")!.zod;
    expect(zod.safeParse({ patientId: PATIENT_ID }).success).toBe(true);
    expect(
      zod.safeParse({ patientId: PATIENT_ID, recordTypes: ["soap_note"] })
        .success,
    ).toBe(true);
    expect(
      zod.safeParse({ patientId: PATIENT_ID, recordTypes: ["invoice"] })
        .success,
    ).toBe(false);
    expect(zod.safeParse({ patientId: PATIENT_ID, limit: 26 }).success).toBe(
      false,
    );
    expect(zod.safeParse({ patientId: "not-a-uuid" }).success).toBe(false);
  });

  it("save_soap_draft requires at least one section", () => {
    const zod = getTool("save_soap_draft")!.zod;
    expect(
      zod.safeParse({ patientId: PATIENT_ID, appointmentId: APPOINTMENT_ID })
        .success,
    ).toBe(false);
    expect(
      zod.safeParse({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        subjective: "   ",
      }).success,
    ).toBe(false);
    expect(
      zod.safeParse({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        plan: "Recheck in 2 weeks.",
      }).success,
    ).toBe(true);
  });
});

describe("save_soap_draft", () => {
  const tool = () => getTool("save_soap_draft")!;
  const args = {
    patientId: PATIENT_ID,
    appointmentId: APPOINTMENT_ID,
    subjective: "Owner reports limping on left hind for 3 days.",
    plan: "Recheck in 2 weeks.",
  };

  it("creates a new draft attributed to the signed-in clinician", async () => {
    soapMocks.getAppointmentSoapDraft.mockResolvedValue(null);
    soapMocks.saveAppointmentSoapDraft.mockResolvedValue({
      outcome: "saved",
      draft: { revision: 1 },
    });
    const result = await tool().execute(args, soapCtx());
    expect(result).toMatchObject({
      saved: true,
      status: "draft",
      visitLink: `/encounters/${APPOINTMENT_ID}`,
    });
    expect(soapMocks.saveAppointmentSoapDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        expectedRevision: 0,
        actor: { id: VET_ID, name: "Dr. Example" },
        sections: {
          subjective: args.subjective,
          objective: null,
          assessment: null,
          plan: args.plan,
        },
      }),
    );
  });

  it("does not overwrite a draft that already has content", async () => {
    soapMocks.getAppointmentSoapDraft.mockResolvedValue({
      id: "draft-1",
      revision: 3,
      subjective: "Earlier notes",
      objective: null,
      assessment: null,
      plan: null,
    });
    const result = await tool().execute(args, soapCtx());
    expect(result).toMatchObject({
      saved: false,
      existingDraft: { subjective: "Earlier notes" },
    });
    expect(soapMocks.saveAppointmentSoapDraft).not.toHaveBeenCalled();
  });

  it("replaces an existing draft only when asked, at its current revision", async () => {
    soapMocks.getAppointmentSoapDraft.mockResolvedValue({
      id: "draft-1",
      revision: 3,
      subjective: "Earlier notes",
      objective: null,
      assessment: null,
      plan: null,
    });
    soapMocks.saveAppointmentSoapDraft.mockResolvedValue({
      outcome: "saved",
      draft: { revision: 4 },
    });
    const result = await tool().execute(
      { ...args, replaceExisting: true },
      soapCtx(),
    );
    expect(result).toMatchObject({ saved: true, revision: 4 });
    expect(soapMocks.saveAppointmentSoapDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ noteId: "draft-1", expectedRevision: 3 }),
    );
  });

  it("reports an already-finalized note instead of changing it", async () => {
    soapMocks.getAppointmentSoapDraft.mockResolvedValue(null);
    soapMocks.saveAppointmentSoapDraft.mockResolvedValue({
      outcome: "already_finalized",
      note: {},
    });
    const result = await tool().execute(args, soapCtx());
    expect(result).toMatchObject({ saved: false });
    expect(JSON.stringify(result)).toContain("addendum");
  });

  it("turns lifecycle errors (e.g. a closed visit) into a readable error", async () => {
    soapMocks.getAppointmentSoapDraft.mockResolvedValue(null);
    soapMocks.saveAppointmentSoapDraft.mockRejectedValue(
      new SoapLifecycleError("PRECONDITION_FAILED", "This visit is closed."),
    );
    const result = await tool().execute(args, soapCtx());
    expect(result).toEqual({ error: "This visit is closed." });
  });

  it("refuses staff who cannot write SOAP notes, and runs with no staff user", async () => {
    const tech = await tool().execute(args, soapCtx("technician"));
    expect(tech).toMatchObject({ error: expect.stringContaining("veterinarians") });
    const noUser = await tool().execute(args, {
      ...soapCtx(),
      staffUser: undefined,
    });
    expect(noUser).toMatchObject({ error: expect.any(String) });
    expect(soapMocks.saveAppointmentSoapDraft).not.toHaveBeenCalled();
  });
});

describe("latestDosePerVaccine", () => {
  const dose = (id: string, vaccineName: string, given: string, due: string) => ({
    id,
    patientId: PATIENT_ID,
    vaccineName,
    nextDueDate: due,
    administeredAt: new Date(given),
    createdAt: new Date(given),
  });

  it("ignores an older dose once a booster was given", () => {
    const rows = [
      dose("a", "Rabies", "2023-05-01T12:00:00Z", "2024-05-01"),
      dose("b", " rabies ", "2024-05-03T12:00:00Z", "2027-05-03"),
      dose("c", "DHPP", "2025-10-01T12:00:00Z", "2026-10-01"),
    ];
    const latest = latestDosePerVaccine(rows).map((r) => r.id).sort();
    expect(latest).toEqual(["b", "c"]);
  });
});

describe("address helpers", () => {
  it("formats a one-line address and skips missing parts", () => {
    expect(
      formatClientAddress({
        address: "12 Palm Way",
        city: "Tampa",
        state: "FL",
        zip: "33602",
      }),
    ).toBe("12 Palm Way, Tampa, FL 33602");
    expect(formatClientAddress({ city: "Tampa", state: "FL" })).toBe(
      "Tampa, FL",
    );
    expect(formatClientAddress({ address: "  " })).toBeNull();
  });

  it("builds an encoded directions link", () => {
    expect(directionsUrl("12 Palm Way, Tampa, FL")).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=12%20Palm%20Way%2C%20Tampa%2C%20FL",
    );
  });
});

describe("buildRunContextPrompt", () => {
  const now = new Date("2026-11-02T14:30:00Z");

  it("states the date in the practice time zone and who is asking", () => {
    const prompt = buildRunContextPrompt({
      now,
      timeZone: "America/New_York",
      staffUser: { name: "Dr. Example", role: "veterinarian" },
    });
    expect(prompt).toContain("Monday, November 2, 2026");
    expect(prompt).toContain("9:30 AM");
    expect(prompt).toContain("(America/New_York)");
    expect(prompt).toContain("You are helping Dr. Example (role: veterinarian)");
  });

  it("names the patient or visit on screen", () => {
    const prompt = buildRunContextPrompt({
      now,
      timeZone: null,
      hints: { patientId: PATIENT_ID, appointmentId: APPOINTMENT_ID },
    });
    expect(prompt).toContain(`viewing patient ${PATIENT_ID}`);
    expect(prompt).toContain(`viewing visit (appointment) ${APPOINTMENT_ID}`);
    expect(prompt).toContain("(UTC)");
  });

  it("falls back to an ISO time for an invalid time zone", () => {
    const prompt = buildRunContextPrompt({ now, timeZone: "Not/AZone" });
    expect(prompt).toContain("2026-11-02T14:30:00.000Z");
  });
});
