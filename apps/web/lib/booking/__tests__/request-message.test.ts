import { describe, expect, it } from "vitest";
import {
  appointmentRequestMessage,
  formatRequestedSlot,
} from "../request-message";

describe("formatRequestedSlot", () => {
  it("formats the clinic's date and time for an owner", () => {
    expect(formatRequestedSlot("2026-12-15", "15:30")).toBe(
      "Tue, Dec 15, 2026, 3:30 PM",
    );
    expect(formatRequestedSlot("2027-01-04", "08:00")).toBe(
      "Mon, Jan 4, 2027, 8:00 AM",
    );
    expect(formatRequestedSlot("2026-11-30", "00:15")).toBe(
      "Mon, Nov 30, 2026, 12:15 AM",
    );
    expect(formatRequestedSlot("2026-11-30", "12:00")).toBe(
      "Mon, Nov 30, 2026, 12:00 PM",
    );
  });

  it("leaves values it cannot read as they are", () => {
    expect(formatRequestedSlot("2026-02-30", "09:00")).toBe("2026-02-30 09:00");
    expect(formatRequestedSlot("tomorrow", "9am")).toBe("tomorrow 9am");
    expect(formatRequestedSlot("2026-12-15", "25:00")).toBe("2026-12-15 25:00");
  });
});

describe("appointmentRequestMessage", () => {
  it("reads as the owner's own request, without staff notes", () => {
    const message = appointmentRequestMessage({
      petName: "Pepper",
      date: "2026-12-15",
      time: "15:30",
      locationName: "Main Location",
      locationCount: 1,
      reason: "[Online request] Interested in: Electroacupuncture. Stiff hips",
    });
    expect(message).toBe(
      [
        "Pet: Pepper",
        "Requested: Tue, Dec 15, 2026, 3:30 PM",
        "Reason: Interested in: Electroacupuncture. Stiff hips",
      ].join("\n"),
    );
    expect(message).not.toMatch(/new client|Main Location|Online request/);
  });

  it("names the location when the clinic has more than one", () => {
    expect(
      appointmentRequestMessage({
        petName: "Pepper",
        date: "2026-12-15",
        time: "09:00",
        locationName: "Westside",
        locationCount: 2,
        reason: "[Portal request] Limping",
      }),
    ).toBe(
      "Pet: Pepper\nRequested: Tue, Dec 15, 2026, 9:00 AM\nLocation: Westside\nReason: Limping",
    );
  });
});
