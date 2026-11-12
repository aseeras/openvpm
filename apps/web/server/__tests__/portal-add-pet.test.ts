import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(async () => ({
    success: true,
    remaining: 4,
    resetAt: new Date(),
  })),
  billingEnforced: vi.fn(() => false),
  hasHostedFullAccess: vi.fn(() => true),
}));

vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: mocks.billingEnforced,
  hasHostedFullAccess: mocks.hasHostedFullAccess,
}));

const { portalRouter, PORTAL_SELF_ADDED_PET_LIMIT } = await import(
  "../routers/portal"
);
const { communications, patients } = await import("@openpims/db");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const CLIENT_ID = "00000000-0000-0000-0000-0000000000bb";
const NEW_PET_ID = "00000000-0000-0000-0000-0000000000cc";
const CLIENT_ROW = {
  id: CLIENT_ID,
  practiceId: PRACTICE_ID,
  firstName: "Tom",
  lastName: "Rivera",
};

/**
 * A db stub answering the selects in the order addPet makes them: the
 * session's client, its practice, the write-access practice check, then the
 * client's active pets.
 */
function createDb(existingPets: Array<{ id: string; name: string }>) {
  const selectResults: unknown[][] = [
    [CLIENT_ROW],
    [{ id: PRACTICE_ID }],
    [{ tier: "pro", billingStatus: "active", trialEndsAt: null }],
    existingPets,
  ];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const afterWhere = {
      limit: vi.fn(async () => result),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject),
    };
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => afterWhere),
      limit: vi.fn(async () => result),
    };
    return builder;
  });
  const inserted: Array<{ table: unknown; values: Record<string, unknown> }> =
    [];
  const insert = vi.fn((table: unknown) => ({
    values: vi.fn((values: Record<string, unknown>) => {
      inserted.push({ table, values });
      const returned = [{ id: NEW_PET_ID, name: values.name }];
      return {
        returning: vi.fn(async () => returned),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(undefined).then(resolve),
      };
    }),
  }));
  const db: Record<string, unknown> = {
    select,
    insert,
    execute: vi.fn(async () => undefined),
    update: vi.fn(),
  };
  db.transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { db, inserted };
}

function caller(db: Record<string, unknown>) {
  return portalRouter.createCaller({
    db,
    ip: "203.0.113.10",
    portalSessionId: "portal-session",
    portalClient: { id: CLIENT_ID, practiceId: PRACTICE_ID },
  } as never);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("portal.addPet", () => {
  it("puts a new client's first pet on file and tells the clinic", async () => {
    const { db, inserted } = createDb([]);

    const result = await caller(db).addPet({
      name: "  Duke ",
      species: "canine",
      breed: "Shepherd mix",
    });

    expect(result).toEqual({
      success: true,
      patientId: NEW_PET_ID,
      created: true,
    });
    const pet = inserted.find((row) => row.table === patients);
    expect(pet?.values).toEqual({
      practiceId: PRACTICE_ID,
      clientId: CLIENT_ID,
      name: "Duke",
      species: "canine",
      breed: "Shepherd mix",
    });
    const note = inserted.find((row) => row.table === communications);
    expect(note?.values).toMatchObject({
      practiceId: PRACTICE_ID,
      clientId: CLIENT_ID,
      channel: "portal",
      direction: "inbound",
      status: "pending",
      subject: "New pet added in the portal: Duke",
    });
    expect(String(note?.values.content)).toContain("Species: Canine");
    expect(String(note?.values.content)).toContain("Breed: Shepherd mix");
  });

  it("reuses a pet already on file with the same name", async () => {
    const { db, inserted } = createDb([
      { id: "00000000-0000-0000-0000-0000000000dd", name: "duke" },
    ]);

    const result = await caller(db).addPet({ name: "Duke", species: "canine" });

    expect(result).toEqual({
      success: true,
      patientId: "00000000-0000-0000-0000-0000000000dd",
      created: false,
    });
    expect(inserted).toHaveLength(0);
  });

  it("sends larger households to the clinic", async () => {
    const pets = Array.from({ length: PORTAL_SELF_ADDED_PET_LIMIT }, (_, i) => ({
      id: `00000000-0000-0000-0000-0000000001${String(i).padStart(2, "0")}`,
      name: `Pet ${i}`,
    }));
    const { db, inserted } = createDb(pets);

    await expect(
      caller(db).addPet({ name: "One more", species: "feline" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(inserted).toHaveLength(0);
  });

  it("rejects a blank name or an unknown species", async () => {
    const { db } = createDb([]);

    await expect(
      caller(db).addPet({ name: "   ", species: "canine" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller(db).addPet({ name: "Duke", species: "dragon" as never }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("is rate limited per session", async () => {
    mocks.rateLimit
      .mockResolvedValueOnce({ success: true, remaining: 1, resetAt: new Date() })
      .mockResolvedValueOnce({ success: false, remaining: 0, resetAt: new Date() });
    const { db, inserted } = createDb([]);

    await expect(
      caller(db).addPet({ name: "Duke", species: "canine" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(inserted).toHaveLength(0);
  });
});
