import { describe, expect, it } from "vitest";
import {
  inboxAlertEmailFromSettings,
  renderInboxAlertEmail,
} from "../inbox-alert";

describe("inboxAlertEmailFromSettings", () => {
  it("returns the configured address", () => {
    expect(
      inboxAlertEmailFromSettings({ inboxAlertEmail: " frontdesk@clinic.test " }),
    ).toBe("frontdesk@clinic.test");
  });

  it("is off when unset, blank or invalid", () => {
    expect(inboxAlertEmailFromSettings(null)).toBeNull();
    expect(inboxAlertEmailFromSettings({})).toBeNull();
    expect(inboxAlertEmailFromSettings({ inboxAlertEmail: "" })).toBeNull();
    expect(inboxAlertEmailFromSettings({ inboxAlertEmail: null })).toBeNull();
    expect(
      inboxAlertEmailFromSettings({ inboxAlertEmail: "not an email" }),
    ).toBeNull();
  });
});

describe("renderInboxAlertEmail", () => {
  it("escapes client-written content and links to the inbox", () => {
    const { subject, html } = renderInboxAlertEmail({
      practiceName: "Paws Clinic",
      subject: "Appointment request for Rex",
      content: "Pet: Rex\nReason: <script>alert(1)</script>",
      inboxUrl: "https://app.clinic.test/inbox",
    });
    expect(subject).toBe("Paws Clinic: Appointment request for Rex");
    expect(html).toContain("Pet: Rex<br>Reason: &lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain('href="https://app.clinic.test/inbox"');
  });
});
