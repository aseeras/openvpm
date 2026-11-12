import { describe, expect, it } from "vitest";
import { PATIENT_SPECIES } from "@/lib/patients/species";
import {
  PUBLIC_BOOKING_SPECIES_GROUPS,
  formatBookingDate,
  formatBookingTime,
} from "../public-form";

describe("formatBookingTime", () => {
  it("uses a 12-hour clock for US visitors", () => {
    expect(formatBookingTime("08:00", "en-US")).toBe("8:00 AM");
    expect(formatBookingTime("14:30", "en-US")).toBe("2:30 PM");
    expect(formatBookingTime("12:00", "en-US")).toBe("12:00 PM");
  });

  it("keeps a 24-hour clock where that is the local habit", () => {
    expect(formatBookingTime("14:30", "en-GB")).toBe("14:30");
  });

  it("leaves anything unexpected as it is", () => {
    expect(formatBookingTime("soon", "en-US")).toBe("soon");
    expect(formatBookingTime("25:00", "en-US")).toBe("25:00");
  });
});

describe("formatBookingDate", () => {
  it("shows the weekday without shifting the day across time zones", () => {
    expect(formatBookingDate("2026-11-17", "en-US")).toBe("Tue, Nov 17");
  });
});

describe("PUBLIC_BOOKING_SPECIES_GROUPS", () => {
  it("offers every species exactly once, with dogs first", () => {
    const values = PUBLIC_BOOKING_SPECIES_GROUPS.flatMap((g) =>
      g.options.map((o) => o.value),
    );
    expect(values[0]).toBe("canine");
    expect([...values].sort()).toEqual([...PATIENT_SPECIES].sort());
  });
});
