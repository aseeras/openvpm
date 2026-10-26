import { TELEHEALTH_FEE_LABEL } from "@/lib/telehealth/visits";

/**
 * What the ZenPaws app shows before anyone signs in, so a first-time visitor
 * sees what the practice offers. Mirrors the services and prices published
 * on zenpawsdvm.com.
 */
export const ZENPAWS_PRACTICE_NAME = "ZenPaws";
export const ZENPAWS_WEBSITE = "https://zenpawsdvm.com";
export const ZENPAWS_PHONE_DISPLAY = "(312) 371-4652";
export const ZENPAWS_PHONE_TEL = "tel:+13123714652";
export const ZENPAWS_PHONE_SMS = "sms:+13123714652";

export const ZENPAWS_SERVICES = [
  {
    name: "First visit & acupuncture",
    detail: "In-home exam and history, then your pet's first acupuncture treatment",
    duration: "75–90 min",
    price: "$430",
  },
  {
    name: "Follow-up acupuncture",
    detail: "For pets on an ongoing treatment plan",
    duration: "30–45 min",
    price: "$135–$165",
  },
  {
    name: "Rehab & therapeutic exercise",
    detail: "Mobility work for post-surgical and senior pets",
    duration: "30–45 min",
    price: "$85–$110",
  },
  {
    name: "Herbal & food-therapy consult",
    detail: "On its own or paired with acupuncture",
    duration: "20–30 min",
    price: "$50–$75",
  },
  {
    name: "Telehealth recheck",
    detail: "Video visit for pets we've already seen in person",
    duration: "15 min",
    price: TELEHEALTH_FEE_LABEL,
  },
] as const;
