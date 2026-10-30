import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../../../packages/db/schema/index";

// The video service and the request limiter are outside this contract: the
// video channel calls are recorded so the test can check what was asked of
// Amazon, and every request is allowed through.
const video = vi.hoisted(() => ({
  created: [] as string[],
  connections: [] as Array<{ channelArn: string; role: string; clientId?: string }>,
  deleted: [] as string[],
}));

vi.mock("@/lib/telehealth/kvs", () => ({
  TelehealthVideoUnavailableError: class TelehealthVideoUnavailableError extends Error {},
  telehealthVideoConfigured: () => true,
  createVisitChannel: async (visitId: string) => {
    video.created.push(visitId);
    return {
      channelArn: `arn:aws:kinesisvideo:us-east-2:111122223333:channel/openvpm-visit-${visitId}/1700000000000`,
    };
  },
  channelConnection: async (input: { channelArn: string; role: "MASTER" | "VIEWER"; clientId?: string }) => {
    video.connections.push(input);
    return {
      signalingUrl: `wss://signaling.example.invalid/?X-Amz-ChannelARN=${encodeURIComponent(input.channelArn)}`,
      iceServers: [],
      role: input.role,
      clientId: input.clientId ?? null,
    };
  },
  deleteVisitChannel: async (channelArn: string) => {
    video.deleted.push(channelArn);
  },
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: async () => ({ success: true, remaining: 100, resetAt: new Date() }),
}));

vi.mock("@/lib/visit-recordings/aws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/visit-recordings/aws")>()),
  visitRecordingTranscriptionConfigured: () => true,
}));

const { telehealthRouter } = await import("../routers/telehealth");
const { portalTelehealthRouter } = await import("../routers/portal-telehealth");

const repoRoot = resolve(process.cwd(), "../..");
const describeWithTelehealthPostgres =
  process.env.TELEHEALTH_DB_INTEGRATION === "1" ? describe : describe.skip;

type Db = ReturnType<typeof drizzle<typeof schema>>;

describeWithTelehealthPostgres("video visits PostgreSQL contract", () => {
  const databaseName = `openpims_telehealth_${randomUUID().replaceAll("-", "")}`;
  let adminSql: ReturnType<typeof postgres>;
  let ownerSql: ReturnType<typeof postgres> | undefined;
  let db: Db;

  const ids = {
    practice: "",
    otherPractice: "",
    vet: "",
    frontDesk: "",
    client: "",
    neighbour: "",
    otherPracticeClient: "",
    rusty: "",
    newPuppy: "",
    neighbourCat: "",
  };

  const staff = (userId: string, role: "veterinarian" | "front_desk", practiceId = ids.practice) =>
    telehealthRouter.createCaller({
      db,
      session: {
        user: { id: userId, email: `${role}@example.invalid`, name: "Dr. Synthetic", role, practiceId },
      },
    } as never);
  const vet = () => staff(ids.vet, "veterinarian");
  const portal = (clientId: string, practiceId = ids.practice) =>
    portalTelehealthRouter.createCaller({
      db,
      portalClient: { id: clientId, practiceId },
      portalSessionId: randomUUID(),
    } as never);

  async function asOwner<T>(work: () => Promise<T>): Promise<T> {
    await ownerSql!`reset role`;
    try {
      return await work();
    } finally {
      await ownerSql!`set role openpims_app`;
    }
  }

  async function visitRow(visitId: string) {
    return asOwner(async () => {
      const [row] = await db
        .select()
        .from(schema.telehealthVisits)
        .where(eq(schema.telehealthVisits.id, visitId));
      return row!;
    });
  }

  /** Close and hide earlier visits so each test starts from an empty waiting room. */
  async function clearVisits() {
    await asOwner(() =>
      db
        .update(schema.telehealthVisits)
        .set({ status: "cancelled", endedAt: new Date(), deletedAt: new Date() })
        .where(inArray(schema.telehealthVisits.status, ["waiting", "in_call"])),
    );
    await asOwner(() => db.update(schema.telehealthVisits).set({ deletedAt: new Date() }));
  }

  beforeAll(async () => {
    const adminUrl = process.env.DATABASE_URL;
    if (!adminUrl) throw new Error("DATABASE_URL is required");
    if (!/^openpims_telehealth_[a-f0-9]+$/.test(databaseName)) {
      throw new Error("unsafe disposable database name");
    }
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    databaseUrl.search = "";
    databaseUrl.hash = "";

    adminSql = postgres(adminUrl, { max: 1 });
    await adminSql.unsafe(`create database "${databaseName}"`);
    for (const script of ["db:migrate", "db:rls"]) {
      execFileSync("pnpm", ["--filter", "@openpims/db", script], {
        cwd: repoRoot,
        env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
        encoding: "utf8",
      });
    }
    ownerSql = postgres(databaseUrl.toString(), { max: 1 });
    db = drizzle(ownerSql, { schema });

    const [practice, otherPractice] = await db
      .insert(schema.practices)
      .values([{ name: "Synthetic Video Clinic" }, { name: "Synthetic Other Clinic" }])
      .returning({ id: schema.practices.id });
    ids.practice = practice!.id;
    ids.otherPractice = otherPractice!.id;
    // Appointments are scheduled at a location; a single primary one is used.
    await db.insert(schema.locations).values([
      { practiceId: ids.practice, name: "Main Clinic", isPrimary: true },
      { practiceId: ids.otherPractice, name: "Other Clinic", isPrimary: true },
    ]);

    const [vetUser, frontDeskUser] = await db
      .insert(schema.users)
      .values([
        { practiceId: ids.practice, email: `vet-${randomUUID()}@example.invalid`, passwordHash: "x", name: "Dr. Synthetic", role: "veterinarian", isVeterinarian: true },
        { practiceId: ids.practice, email: `desk-${randomUUID()}@example.invalid`, passwordHash: "x", name: "Front Desk", role: "front_desk" },
      ])
      .returning({ id: schema.users.id });
    ids.vet = vetUser!.id;
    ids.frontDesk = frontDeskUser!.id;

    const [client, neighbour, otherPracticeClient] = await db
      .insert(schema.clients)
      .values([
        { practiceId: ids.practice, firstName: "Margaret", lastName: "Synthetic" },
        { practiceId: ids.practice, firstName: "Neighbour", lastName: "Synthetic" },
        { practiceId: ids.otherPractice, firstName: "Elsewhere", lastName: "Synthetic" },
      ])
      .returning({ id: schema.clients.id });
    ids.client = client!.id;
    ids.neighbour = neighbour!.id;
    ids.otherPracticeClient = otherPracticeClient!.id;

    const [rusty, newPuppy, neighbourCat] = await db
      .insert(schema.patients)
      .values([
        { practiceId: ids.practice, clientId: ids.client, name: "Rusty", species: "canine" },
        { practiceId: ids.practice, clientId: ids.client, name: "New Puppy", species: "canine" },
        { practiceId: ids.practice, clientId: ids.neighbour, name: "Neighbour Cat", species: "feline" },
      ])
      .returning({ id: schema.patients.id });
    ids.rusty = rusty!.id;
    ids.newPuppy = newPuppy!.id;
    ids.neighbourCat = neighbourCat!.id;

    // Video visits are for pets seen in person before: Rusty and the
    // neighbour's cat have a finished visit, the new puppy does not.
    const earlier = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db.insert(schema.appointments).values(
      [
        { patientId: ids.rusty, clientId: ids.client },
        { patientId: ids.neighbourCat, clientId: ids.neighbour },
      ].map((visit) => ({
        practiceId: ids.practice,
        ...visit,
        doctorId: ids.vet,
        startTime: earlier,
        endTime: new Date(earlier.getTime() + 30 * 60 * 1000),
        status: "checked_out" as const,
      })),
    );

    // Everything below runs as the least-privilege application role.
    await ownerSql`set role openpims_app`;
    await vet().setAccepting({ accepting: true });
  }, 120_000);

  afterAll(async () => {
    if (ownerSql) await ownerSql.end();
    if (adminSql) {
      await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminSql.end();
    }
  });

  beforeEach(async () => {
    video.created.length = 0;
    video.connections.length = 0;
    video.deleted.length = 0;
    await clearVisits();
  });

  it("runs a whole visit: waiting room, call, consented transcript, and close", async () => {
    const client = portal(ids.client);
    const { id: visitId } = await client.request({ patientId: ids.rusty, reason: "Acupuncture follow-up" });

    const waiting = await client.status();
    expect(waiting.visit).toMatchObject({ id: visitId, status: "waiting", ahead: 0 });
    const queue = await vet().queue();
    expect(queue.open.map((visit) => visit.id)).toEqual([visitId]);

    // The client can't join before the veterinarian starts the call.
    await expect(client.join({ visitId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const started = await vet().start({ visitId });
    expect(video.created).toEqual([visitId]);
    expect(started.connection).toMatchObject({ role: "MASTER" });
    const afterStart = await visitRow(visitId);
    expect(afterStart.status).toBe("in_call");
    expect(afterStart.clinicianId).toBe(ids.vet);
    expect(afterStart.videoRoomName).toMatch(/^arn:aws:kinesisvideo:.*openvpm-visit-/);
    // Starting opens the visit on the schedule, in the exam room.
    expect(started.appointmentId).toBe(afterStart.appointmentId);
    const [appointment] = await asOwner(() =>
      db.select().from(schema.appointments).where(eq(schema.appointments.id, started.appointmentId!)),
    );
    expect(appointment).toMatchObject({ status: "in_exam", doctorId: ids.vet, patientId: ids.rusty });

    // The client joins as a viewer with a fresh id each time.
    const first = await client.join({ visitId });
    const second = await client.join({ visitId });
    expect(first.connection.role).toBe("VIEWER");
    expect(first.connection.clientId).toMatch(/^client-[0-9a-f]+$/);
    expect(second.connection.clientId).not.toBe(first.connection.clientId);
    // The clinician can get back in with a fresh connection.
    expect((await vet().rejoin({ visitId })).connection.role).toBe("MASTER");

    // Transcript: asked for, shown to the client, agreed, then stopped.
    expect(await vet().requestTranscript({ visitId })).toEqual({ transcriptStatus: "requested" });
    const asked = await client.status();
    expect(asked.visit?.transcriptDisclosure).toContain("records the call audio (not video)");
    expect(asked.visit?.transcriptDisclosure).toContain("Rusty");
    expect(await client.answerTranscript({ visitId, allow: true })).toEqual({ transcriptStatus: "active" });
    // A second answer has nothing left to answer.
    await expect(client.answerTranscript({ visitId, allow: true })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(await client.stopTranscript({ visitId })).toEqual({ transcriptStatus: "stopped" });

    const consent = await vet().transcript({ visitId });
    expect(consent.consent).toMatchObject({ signerName: "Margaret Synthetic" });

    // Ending closes the call, keeps the recorded transcript for upload, and
    // deletes the video channel.
    expect(await vet().end({ visitId })).toEqual({ status: "completed", transcriptStatus: "stopped" });
    expect(video.deleted).toEqual([afterStart.videoRoomName]);
    await expect(client.join({ visitId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const after = await client.status();
    expect(after.visit).toBeNull();
    expect(after.lastClosed).toMatchObject({ id: visitId, status: "completed" });
  });

  it("only lets clients start visits for their own pets seen before, one at a time", async () => {
    const client = portal(ids.client);
    await expect(client.request({ patientId: ids.newPuppy, reason: "Acupuncture follow-up" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(client.request({ patientId: ids.neighbourCat, reason: "Acupuncture follow-up" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await client.request({ patientId: ids.rusty, reason: "Acupuncture follow-up" });
    await expect(client.request({ patientId: ids.rusty, reason: "Acupuncture follow-up" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("refuses requests while the clinic isn't taking video visits", async () => {
    await vet().setAccepting({ accepting: false });
    try {
      await expect(
        portal(ids.client).request({ patientId: ids.rusty, reason: "Acupuncture follow-up" }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    } finally {
      await vet().setAccepting({ accepting: true });
    }
  });

  it("keeps each visit to its own client and practice", async () => {
    const { id: visitId } = await portal(ids.client).request({ patientId: ids.rusty, reason: "Acupuncture follow-up" });
    await vet().start({ visitId });
    await vet().requestTranscript({ visitId });

    // Another client of the same clinic can't join, see, or answer for it.
    const neighbour = portal(ids.neighbour);
    await expect(neighbour.join({ visitId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(neighbour.answerTranscript({ visitId, allow: true })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect((await neighbour.status()).visit).toBeNull();
    expect(await neighbour.cancel({ visitId })).toEqual({ cancelled: false });

    // Nor can a client of a different clinic, or that clinic's staff.
    const elsewhere = portal(ids.otherPracticeClient, ids.otherPractice);
    await expect(elsewhere.join({ visitId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const otherStaff = staff(ids.vet, "veterinarian", ids.otherPractice);
    await expect(otherStaff.end({ visitId })).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect((await visitRow(visitId)).transcriptStatus).toBe("requested");
    expect(video.connections.filter((c) => c.role === "VIEWER")).toEqual([]);
  });

  it("leaves running the call to clinicians", async () => {
    const { id: visitId } = await portal(ids.client).request({ patientId: ids.rusty, reason: "Acupuncture follow-up" });
    const desk = staff(ids.frontDesk, "front_desk");
    // Front desk sees the waiting room but can't start, transcribe or end.
    expect((await desk.queue()).open.map((visit) => visit.id)).toEqual([visitId]);
    await expect(desk.start({ visitId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await vet().start({ visitId });
    await expect(desk.requestTranscript({ visitId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(desk.end({ visitId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // A visit can only be started once.
    await expect(vet().start({ visitId })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(video.created).toEqual([visitId]);
  });

  it("records a declined transcript and lets the clinician ask again later", async () => {
    const client = portal(ids.client);
    const { id: visitId } = await client.request({ patientId: ids.rusty, reason: "Acupuncture follow-up" });
    await vet().start({ visitId });
    await vet().requestTranscript({ visitId });
    expect(await client.answerTranscript({ visitId, allow: false })).toEqual({ transcriptStatus: "declined" });
    // Only a granted consent is shown with the transcript.
    expect((await vet().transcript({ visitId })).consent).toBeNull();

    // Asking again is allowed; withdrawing the request turns it back off.
    expect(await vet().requestTranscript({ visitId })).toEqual({ transcriptStatus: "requested" });
    expect(await vet().stopTranscript({ visitId })).toEqual({ transcriptStatus: "off" });

    // Ending with an unanswered request leaves no transcript pending.
    await vet().requestTranscript({ visitId });
    expect(await vet().end({ visitId })).toEqual({ status: "completed", transcriptStatus: "off" });

    // The consent trail is append-only: one row per answer.
    const consents = await asOwner(() =>
      db
        .select({ action: schema.telehealthTranscriptConsents.action })
        .from(schema.telehealthTranscriptConsents)
        .where(eq(schema.telehealthTranscriptConsents.visitId, visitId)),
    );
    expect(consents.map((row) => row.action)).toEqual(["declined"]);
  });

  it("lets the clinic turn a client away and the client leave the waiting room", async () => {
    const client = portal(ids.client);
    const { id: declinedId } = await client.request({ patientId: ids.rusty, reason: "Acupuncture follow-up" });
    expect(await vet().decline({ visitId: declinedId, reason: "Please book an in-home visit." })).toEqual({
      status: "declined",
    });
    expect((await client.status()).lastClosed).toMatchObject({
      id: declinedId,
      status: "declined",
      declineReason: "Please book an in-home visit.",
    });

    const { id: cancelledId } = await client.request({ patientId: ids.rusty, reason: "Acupuncture follow-up" });
    expect(await client.cancel({ visitId: cancelledId })).toEqual({ cancelled: true });
    expect((await visitRow(cancelledId)).status).toBe("cancelled");
    // A cancelled visit can't be started.
    await expect(vet().start({ visitId: cancelledId })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(video.created).toEqual([]);
  });

  it("starts no video call while the clinic is under a recovery hold", async () => {
    const { id: visitId } = await portal(ids.client).request({ patientId: ids.rusty, reason: "Acupuncture follow-up" });
    await asOwner(() =>
      db
        .update(schema.practices)
        .set({ recoveryHold: true, recoveryHoldReason: "Synthetic data review", recoveryHoldSetAt: new Date() })
        .where(eq(schema.practices.id, ids.practice)),
    );
    try {
      await expect(vet().start({ visitId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect(video.created).toEqual([]);
    } finally {
      await asOwner(() =>
        db.update(schema.practices).set({ recoveryHold: false }).where(eq(schema.practices.id, ids.practice)),
      );
    }
  });
});
