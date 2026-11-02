import { z } from "zod";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";
import {
  appointments,
  appointmentTypes,
  clients,
  clinicalRecordCorrections,
  communications,
  labResults,
  patientAllergies,
  patients,
  prescriptions,
  problemList,
  soapNotes,
  users,
  vaccinationRecords,
  visitCloseouts,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  dateInputDayUtcRange,
  formatDateInputForTimeZone,
} from "@/lib/date-input";
import {
  PATIENT_HISTORY_RECORD_TYPES,
  PATIENT_HISTORY_QUERY_MAX_LENGTH,
  type PatientHistoryRecordType,
} from "@/lib/records/patient-history";
import { buildPatientHistoryQuery, type PatientHistoryRawRow } from "@/server/patient-history";
import {
  SOAP_SECTION_MAX_LENGTH,
  hasSoapContent,
} from "@/lib/records/soap-content";
import {
  SoapLifecycleError,
  getAppointmentSoapDraft,
  saveAppointmentSoapDraft,
} from "@/lib/records/soap-lifecycle";
import {
  clientName,
  practiceTimeZone,
  type AgentTool,
  type AgentToolContext,
} from "./tool-kit";

/**
 * Tools for a veterinarian's day: a daily briefing, chart reading, a personal
 * to-do list, and SOAP drafting. Drafting never finalizes: the clinician
 * reviews and signs in the visit screen. Personal tools require a signed-in
 * staff member, so API-key and automated runs never see them.
 */

const DATE_INPUT = /^\d{4}-\d{2}-\d{2}$/;
const SUMMARY_MAX_CHARS = 1500;
const TODO_LIST_LIMIT = 10;

const uuidInput = z.string().guid();

function truncate(value: string | null | undefined, max: number): string | null {
  const text = value?.trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatTime(value: Date, timeZone: string | null): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timeZone ?? undefined,
  }).format(value);
}

function ageFromDob(dob: string | null, today: string): string | null {
  if (!dob || !DATE_INPUT.test(dob)) return null;
  const [y, m, d] = dob.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
  let months = (ty - y) * 12 + (tm - m);
  if (td < d) months -= 1;
  if (months < 0) return null;
  if (months < 24) return `${months} mo`;
  return `${Math.floor(months / 12)} yr`;
}

/** One-line street address, or null when the client has none on file. */
export function formatClientAddress(parts: {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}): string | null {
  const street = parts.address?.trim();
  const cityLine = [parts.city?.trim(), [parts.state?.trim(), parts.zip?.trim()].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  const full = [street, cityLine].filter(Boolean).join(", ");
  return full || null;
}

export function directionsUrl(address: string): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
}

function notCorrected(correctionColumn: AnyPgColumn, idColumn: AnyPgColumn, practiceId: string) {
  return sql`not exists (
    select 1 from ${clinicalRecordCorrections}
    where ${clinicalRecordCorrections.practiceId} = ${practiceId}
      and ${correctionColumn} = ${idColumn}
  )`;
}

async function assertPatientInPractice(ctx: AgentToolContext, patientId: string) {
  const [patient] = await ctx.db
    .select({ id: patients.id, name: patients.name, clientId: patients.clientId })
    .from(patients)
    .where(
      and(
        eq(patients.id, patientId),
        eq(patients.practiceId, ctx.practiceId),
        isNull(patients.deletedAt),
      ),
    )
    .limit(1);
  return patient ?? null;
}

async function allergiesFor(ctx: AgentToolContext, patientIds: string[]) {
  if (patientIds.length === 0) return [];
  return ctx.db
    .select({
      patientId: patientAllergies.patientId,
      allergen: patientAllergies.allergen,
      severity: patientAllergies.severity,
      reaction: patientAllergies.reaction,
    })
    .from(patientAllergies)
    .innerJoin(
      patients,
      and(
        eq(patients.id, patientAllergies.patientId),
        eq(patients.practiceId, ctx.practiceId),
        isNull(patients.deletedAt),
      ),
    )
    .where(
      and(
        inArray(patientAllergies.patientId, patientIds),
        isNull(patientAllergies.deletedAt),
        notCorrected(clinicalRecordCorrections.patientAllergyId, patientAllergies.id, ctx.practiceId),
      ),
    );
}

function groupBy<T, K extends keyof T>(rows: T[], key: K): Map<T[K], T[]> {
  const map = new Map<T[K], T[]>();
  for (const row of rows) {
    const list = map.get(row[key]) ?? [];
    list.push(row);
    map.set(row[key], list);
  }
  return map;
}

/**
 * Keep only the most recent dose of each vaccine per patient, so a booster
 * given since makes the older record's due date irrelevant.
 */
export function latestDosePerVaccine<
  T extends {
    id: string;
    patientId: string;
    vaccineName: string;
    administeredAt: Date;
    createdAt: Date;
  },
>(rows: T[]): T[] {
  const latest = new Map<string, T>();
  const newer = (a: T, b: T) =>
    a.administeredAt.getTime() !== b.administeredAt.getTime()
      ? a.administeredAt > b.administeredAt
      : a.createdAt.getTime() !== b.createdAt.getTime()
        ? a.createdAt > b.createdAt
        : a.id > b.id;
  for (const row of rows) {
    const key = `${row.patientId}:${row.vaccineName.trim().toLowerCase()}`;
    const current = latest.get(key);
    if (!current || newer(row, current)) latest.set(key, row);
  }
  return [...latest.values()];
}

// ---------------------------------------------------------------------------
// get_my_day
// ---------------------------------------------------------------------------

const getMyDay: AgentTool = {
  name: "get_my_day",
  description:
    "Daily briefing: the day's visits in time order with client address, directions link, phone, visit type and notes, and for each pet its age, allergies, active problems and vaccines due soon. Use this for 'my day', 'today's schedule', 'where am I going next', or prep before visits.",
  inputSchema: {
    type: "object",
    properties: {
      date: { type: "string", description: "YYYY-MM-DD. Defaults to today in the practice time zone." },
      onlyMine: {
        type: "boolean",
        description: "Only visits assigned to the signed-in veterinarian (plus unassigned ones). Default false.",
      },
    },
  },
  zod: z.object({
    date: z.string().regex(DATE_INPUT, "Use YYYY-MM-DD.").optional(),
    onlyMine: z.boolean().optional(),
  }),
  readOnly: true,
  async execute(args, ctx) {
    const input = this.zod.parse(args) as { date?: string; onlyMine?: boolean };
    const timeZone = await practiceTimeZone(ctx);
    const today = formatDateInputForTimeZone(new Date(), timeZone);
    const { date, start, end } = dateInputDayUtcRange(input.date ?? today, timeZone);

    const conditions = [
      eq(appointments.practiceId, ctx.practiceId),
      isNull(appointments.deletedAt),
      not(inArray(appointments.status, ["cancelled", "no_show"])),
      gte(appointments.startTime, start),
      lt(appointments.startTime, end),
    ];
    if (input.onlyMine && ctx.staffUser) {
      conditions.push(
        or(eq(appointments.doctorId, ctx.staffUser.id), isNull(appointments.doctorId))!,
      );
    }

    const rows = await ctx.db
      .select({
        id: appointments.id,
        startTime: appointments.startTime,
        endTime: appointments.endTime,
        status: appointments.status,
        notes: appointments.notes,
        typeName: appointmentTypes.name,
        doctorName: users.name,
        patientId: patients.id,
        patientName: patients.name,
        species: patients.species,
        breed: patients.breed,
        sex: patients.sex,
        dob: patients.dob,
        clientId: clients.id,
        clientFirst: clients.firstName,
        clientLast: clients.lastName,
        phone: clients.phone,
        address: clients.address,
        city: clients.city,
        state: clients.state,
        zip: clients.zip,
        clientNotes: clients.notes,
      })
      .from(appointments)
      .leftJoin(
        appointmentTypes,
        and(
          eq(appointmentTypes.id, appointments.typeId),
          eq(appointmentTypes.practiceId, ctx.practiceId),
        ),
      )
      .leftJoin(
        users,
        and(eq(users.id, appointments.doctorId), eq(users.practiceId, ctx.practiceId)),
      )
      .leftJoin(
        patients,
        and(
          eq(patients.id, appointments.patientId),
          eq(patients.practiceId, ctx.practiceId),
          isNull(patients.deletedAt),
        ),
      )
      .leftJoin(
        clients,
        and(
          eq(clients.id, appointments.clientId),
          eq(clients.practiceId, ctx.practiceId),
          isNull(clients.deletedAt),
        ),
      )
      .where(and(...conditions))
      .orderBy(asc(appointments.startTime));

    const patientIds = [
      ...new Set(rows.map((r) => r.patientId).filter((id): id is string => Boolean(id))),
    ];
    const dueBy = new Date(`${date}T00:00:00Z`);
    dueBy.setUTCDate(dueBy.getUTCDate() + 30);
    const dueByInput = dueBy.toISOString().slice(0, 10);

    const [allergies, problems, vaccinations] =
      patientIds.length === 0
        ? [[], [], []]
        : await Promise.all([
            allergiesFor(ctx, patientIds),
            ctx.db
              .select({ patientId: problemList.patientId, description: problemList.description })
              .from(problemList)
              .where(
                and(
                  inArray(problemList.patientId, patientIds),
                  eq(problemList.practiceId, ctx.practiceId),
                  isNull(problemList.deletedAt),
                  eq(problemList.status, "active"),
                ),
              ),
            ctx.db
              .select({
                id: vaccinationRecords.id,
                patientId: vaccinationRecords.patientId,
                vaccineName: vaccinationRecords.vaccineName,
                nextDueDate: vaccinationRecords.nextDueDate,
                administeredAt: vaccinationRecords.administeredAt,
                createdAt: vaccinationRecords.createdAt,
              })
              .from(vaccinationRecords)
              .where(
                and(
                  inArray(vaccinationRecords.patientId, patientIds),
                  eq(vaccinationRecords.practiceId, ctx.practiceId),
                  isNull(vaccinationRecords.deletedAt),
                  notCorrected(clinicalRecordCorrections.vaccinationRecordId, vaccinationRecords.id, ctx.practiceId),
                ),
              ),
          ]);

    const allergiesBy = groupBy(allergies, "patientId");
    const problemsBy = groupBy(problems, "patientId");
    const vaccinesBy = groupBy(
      latestDosePerVaccine(vaccinations).filter(
        (v) => v.nextDueDate !== null && v.nextDueDate <= dueByInput,
      ),
      "patientId",
    );

    return {
      date,
      timeZone,
      visitCount: rows.length,
      visits: rows.map((r) => {
        const address = formatClientAddress(r);
        return {
          appointmentId: r.id,
          time: `${formatTime(r.startTime, timeZone)}–${formatTime(r.endTime, timeZone)}`,
          status: r.status,
          visitType: r.typeName,
          veterinarian: r.doctorName,
          reasonOrNotes: truncate(r.notes, 500),
          client: r.clientId
            ? {
                id: r.clientId,
                name: clientName(r.clientFirst, r.clientLast),
                phone: r.phone,
                address,
                directions: address ? directionsUrl(address) : null,
                notes: truncate(r.clientNotes, 300),
              }
            : null,
          patient: r.patientId
            ? {
                id: r.patientId,
                name: r.patientName,
                species: r.species,
                breed: r.breed,
                sex: r.sex,
                age: ageFromDob(r.dob, date),
                allergies: (allergiesBy.get(r.patientId) ?? []).map(
                  (a) => `${a.allergen} (${a.severity}${a.reaction ? `: ${a.reaction}` : ""})`,
                ),
                activeProblems: (problemsBy.get(r.patientId) ?? []).map((p) => p.description),
                vaccinesDueWithin30Days: (vaccinesBy.get(r.patientId) ?? []).map(
                  (v) => `${v.vaccineName} (due ${v.nextDueDate})`,
                ),
                chartLink: `/patients/${r.patientId}`,
              }
            : null,
          visitLink: `/encounters/${r.id}`,
        };
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// search_patient_history
// ---------------------------------------------------------------------------

const searchPatientHistory: AgentTool = {
  name: "search_patient_history",
  description:
    "Read a patient's chart history, newest first: SOAP notes (full text), prescriptions, vaccinations, lab results, procedures, problems, vitals and allergies. Optionally filter by record type or a search phrase (e.g. 'vomiting', 'carprofen'). Use for questions like 'what did we give last time' or 'when was the last bloodwork'.",
  inputSchema: {
    type: "object",
    properties: {
      patientId: { type: "string", description: "Patient UUID" },
      query: { type: "string", description: "Optional words to search for in the chart" },
      recordTypes: {
        type: "array",
        items: { type: "string", enum: [...PATIENT_HISTORY_RECORD_TYPES] },
        description: "Optional record types to include. Default: all.",
      },
      limit: { type: "number", description: "Max records, 1-25. Default 10." },
    },
    required: ["patientId"],
  },
  zod: z.object({
    patientId: uuidInput,
    query: z.string().trim().min(1).max(PATIENT_HISTORY_QUERY_MAX_LENGTH).optional(),
    recordTypes: z
      .array(z.enum(PATIENT_HISTORY_RECORD_TYPES))
      .min(1)
      .max(PATIENT_HISTORY_RECORD_TYPES.length)
      .optional(),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  readOnly: true,
  async execute(args, ctx) {
    const input = this.zod.parse(args) as {
      patientId: string;
      query?: string;
      recordTypes?: PatientHistoryRecordType[];
      limit?: number;
    };
    const patient = await assertPatientInPractice(ctx, input.patientId);
    if (!patient) return { error: "Patient not found" };
    const limit = input.limit ?? 10;
    const rows = await ctx.db.execute<PatientHistoryRawRow>(
      buildPatientHistoryQuery({
        practiceId: ctx.practiceId,
        input: {
          patientId: input.patientId,
          query: input.query,
          recordTypes: input.recordTypes ?? [...PATIENT_HISTORY_RECORD_TYPES],
          state: "current",
          limit,
        },
      }),
    );
    const items = [...rows]
      .filter((row) => row.id && row.recordType && row.title)
      .slice(0, limit)
      .map((row) => ({
        type: row.recordType,
        date: row.displayDate,
        title: row.title,
        status: row.status,
        detail: truncate(row.summary, SUMMARY_MAX_CHARS),
        author: row.authorName,
      }));
    return {
      patient: { id: patient.id, name: patient.name },
      totalMatching: Number(rows[0]?.totalCount ?? 0),
      items,
      chartLink: `/patients/${patient.id}`,
    };
  },
};

// ---------------------------------------------------------------------------
// list_medications
// ---------------------------------------------------------------------------

const listMedications: AgentTool = {
  name: "list_medications",
  description:
    "List a patient's prescriptions (active by default) with dose, frequency, refills remaining and prescriber, plus recorded allergies. Use this to prepare a refill: report whether refills remain and any allergy concerns, then point the clinician to the chart to record the refill. You cannot record or approve refills yourself.",
  inputSchema: {
    type: "object",
    properties: {
      patientId: { type: "string", description: "Patient UUID" },
      includeInactive: { type: "boolean", description: "Also include completed, cancelled and expired prescriptions." },
    },
    required: ["patientId"],
  },
  zod: z.object({ patientId: uuidInput, includeInactive: z.boolean().optional() }),
  readOnly: true,
  async execute(args, ctx) {
    const input = this.zod.parse(args) as { patientId: string; includeInactive?: boolean };
    const patient = await assertPatientInPractice(ctx, input.patientId);
    if (!patient) return { error: "Patient not found" };
    const conditions = [
      eq(prescriptions.patientId, input.patientId),
      eq(prescriptions.practiceId, ctx.practiceId),
      isNull(prescriptions.deletedAt),
    ];
    if (!input.includeInactive) conditions.push(eq(prescriptions.status, "active"));
    const [meds, allergies] = await Promise.all([
      ctx.db
        .select({
          id: prescriptions.id,
          medicationName: prescriptions.medicationName,
          dosage: prescriptions.dosage,
          frequency: prescriptions.frequency,
          quantity: prescriptions.quantity,
          refillsRemaining: prescriptions.refillsRemaining,
          startDate: prescriptions.startDate,
          endDate: prescriptions.endDate,
          status: prescriptions.status,
          instructions: prescriptions.instructions,
          prescriber: users.name,
        })
        .from(prescriptions)
        .leftJoin(
          users,
          and(eq(users.id, prescriptions.prescribedBy), eq(users.practiceId, ctx.practiceId)),
        )
        .where(and(...conditions))
        .orderBy(desc(prescriptions.startDate))
        .limit(25),
      allergiesFor(ctx, [input.patientId]),
    ]);
    return {
      patient: { id: patient.id, name: patient.name },
      prescriptions: meds.map((m) => ({
        ...m,
        instructions: truncate(m.instructions, 300),
        canRefill: m.status === "active" && m.refillsRemaining > 0,
      })),
      allergies: allergies.map((a) => ({
        allergen: a.allergen,
        severity: a.severity,
        reaction: a.reaction,
      })),
      chartLink: `/patients/${patient.id}`,
    };
  },
};

// ---------------------------------------------------------------------------
// get_my_todo
// ---------------------------------------------------------------------------

const getMyTodo: AgentTool = {
  name: "get_my_todo",
  description:
    "The signed-in clinician's to-do list: unread client messages, texting-assistant reply drafts waiting for approval, lab results to review or follow up, unfinished SOAP drafts, and visit follow-ups that are due. Use for 'what needs my attention' or 'what's left today'.",
  inputSchema: { type: "object", properties: {} },
  zod: z.object({}),
  readOnly: true,
  requiresStaffUser: true,
  async execute(_args, ctx) {
    const staffUserId = ctx.staffUser?.id;
    if (!staffUserId) return { error: "Only available to signed-in staff." };

    const commClient = and(
      eq(clients.id, communications.clientId),
      eq(clients.practiceId, ctx.practiceId),
      isNull(clients.deletedAt),
    );
    const unreadWhere = and(
      eq(communications.practiceId, ctx.practiceId),
      isNull(communications.deletedAt),
      eq(communications.direction, "inbound"),
      isNull(communications.readAt),
      ne(communications.status, "read"),
    );
    const draftWhere = and(
      eq(communications.practiceId, ctx.practiceId),
      isNull(communications.deletedAt),
      eq(communications.direction, "outbound"),
      eq(communications.status, "draft"),
    );
    const labWhere = and(
      eq(labResults.practiceId, ctx.practiceId),
      isNull(labResults.deletedAt),
      notCorrected(clinicalRecordCorrections.labResultId, labResults.id, ctx.practiceId),
      or(eq(labResults.status, "completed"), eq(labResults.followUpStatus, "open"))!,
    );

    const commSelect = {
      id: communications.id,
      channel: communications.channel,
      content: communications.content,
      createdAt: communications.createdAt,
      clientFirst: clients.firstName,
      clientLast: clients.lastName,
    };

    const [unread, unreadCount, drafts, draftCount, labs, soapDrafts, followUps] =
      await Promise.all([
        ctx.db
          .select(commSelect)
          .from(communications)
          .leftJoin(clients, commClient)
          .where(unreadWhere)
          .orderBy(desc(communications.createdAt))
          .limit(TODO_LIST_LIMIT),
        ctx.db
          .select({ n: sql<number>`count(*)::int` })
          .from(communications)
          .where(unreadWhere),
        ctx.db
          .select(commSelect)
          .from(communications)
          .leftJoin(clients, commClient)
          .where(draftWhere)
          .orderBy(desc(communications.createdAt))
          .limit(TODO_LIST_LIMIT),
        ctx.db
          .select({ n: sql<number>`count(*)::int` })
          .from(communications)
          .where(draftWhere),
        ctx.db
          .select({
            id: labResults.id,
            testName: labResults.testName,
            status: labResults.status,
            resultFlag: labResults.resultFlag,
            followUpStatus: labResults.followUpStatus,
            followUpDueAt: labResults.followUpDueAt,
            followUpAssignedTo: labResults.followUpAssignedTo,
            patientId: patients.id,
            patientName: patients.name,
          })
          .from(labResults)
          .innerJoin(
            patients,
            and(
              eq(patients.id, labResults.patientId),
              eq(patients.practiceId, ctx.practiceId),
              isNull(patients.deletedAt),
            ),
          )
          .where(labWhere)
          .orderBy(desc(labResults.createdAt))
          .limit(20),
        ctx.db
          .select({
            id: soapNotes.id,
            appointmentId: soapNotes.appointmentId,
            createdAt: soapNotes.createdAt,
            patientId: patients.id,
            patientName: patients.name,
          })
          .from(soapNotes)
          .innerJoin(
            patients,
            and(
              eq(patients.id, soapNotes.patientId),
              eq(patients.practiceId, ctx.practiceId),
              isNull(patients.deletedAt),
            ),
          )
          .where(
            and(
              eq(soapNotes.practiceId, ctx.practiceId),
              eq(soapNotes.status, "draft"),
              eq(soapNotes.authorId, staffUserId),
              isNull(soapNotes.deletedAt),
            ),
          )
          .orderBy(asc(soapNotes.createdAt))
          .limit(20),
        ctx.db
          .select({
            appointmentId: visitCloseouts.appointmentId,
            dueDate: visitCloseouts.followUpDueDate,
            notes: visitCloseouts.followUpNotes,
            assignedTo: visitCloseouts.followUpAssignedTo,
            patientId: patients.id,
            patientName: patients.name,
          })
          .from(visitCloseouts)
          .innerJoin(
            appointments,
            and(
              eq(appointments.id, visitCloseouts.appointmentId),
              eq(appointments.practiceId, ctx.practiceId),
              isNull(appointments.deletedAt),
            ),
          )
          .innerJoin(
            patients,
            and(
              eq(patients.id, appointments.patientId),
              eq(patients.practiceId, ctx.practiceId),
              isNull(patients.deletedAt),
            ),
          )
          .where(
            and(
              eq(visitCloseouts.practiceId, ctx.practiceId),
              eq(visitCloseouts.followUpDisposition, "needed"),
              inArray(visitCloseouts.status, ["clinical_finalized", "completed"]),
              isNull(visitCloseouts.followUpResolvedAt),
              isNull(visitCloseouts.deletedAt),
            ),
          )
          .orderBy(asc(visitCloseouts.followUpDueDate))
          .limit(20),
      ]);

    const mapComm = (row: (typeof unread)[number]) => ({
      client: clientName(row.clientFirst, row.clientLast) || "Unknown sender",
      channel: row.channel,
      preview: truncate(row.content, 200),
      receivedAt: row.createdAt,
    });

    return {
      unreadMessages: { count: unreadCount[0]?.n ?? 0, latest: unread.map(mapComm), link: "/inbox" },
      textingDraftsToApprove: { count: draftCount[0]?.n ?? 0, latest: drafts.map(mapComm), link: "/inbox" },
      labResults: {
        count: labs.length,
        items: labs.map((l) => ({
          patient: l.patientName,
          test: l.testName,
          flag: l.resultFlag,
          needs: l.status === "completed" ? "review" : "follow-up",
          followUpDue: l.followUpDueAt,
          assignedToMe: l.followUpAssignedTo === staffUserId,
          chartLink: `/patients/${l.patientId}`,
        })),
        link: "/lab-results",
      },
      unfinishedSoapDrafts: soapDrafts.map((d) => ({
        patient: d.patientName,
        startedAt: d.createdAt,
        visitLink: d.appointmentId ? `/encounters/${d.appointmentId}` : `/patients/${d.patientId}`,
      })),
      followUpsDue: followUps.map((f) => ({
        patient: f.patientName,
        dueDate: f.dueDate,
        notes: truncate(f.notes, 200),
        assignedToMe: f.assignedTo === staffUserId,
        visitLink: `/encounters/${f.appointmentId}`,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// save_soap_draft
// ---------------------------------------------------------------------------

const soapSection = z.string().trim().max(SOAP_SECTION_MAX_LENGTH).optional();

const saveSoapDraft: AgentTool = {
  name: "save_soap_draft",
  description:
    "Save a SOAP note DRAFT for a visit from the clinician's dictated or typed notes. Organize what they said into Subjective, Objective, Assessment and Plan using only facts they gave; never invent findings, doses or diagnoses. The draft is not finalized: the clinician reviews, edits and signs it in the visit screen. If a draft with content already exists, this returns it instead of overwriting; only pass replaceExisting=true after the clinician agrees to replace it.",
  inputSchema: {
    type: "object",
    properties: {
      patientId: { type: "string", description: "Patient UUID" },
      appointmentId: { type: "string", description: "Appointment (visit) UUID, e.g. from get_my_day" },
      subjective: { type: "string" },
      objective: { type: "string" },
      assessment: { type: "string" },
      plan: { type: "string" },
      replaceExisting: { type: "boolean", description: "Overwrite an existing draft's content. Default false." },
    },
    required: ["patientId", "appointmentId"],
  },
  zod: z
    .object({
      patientId: uuidInput,
      appointmentId: uuidInput,
      subjective: soapSection,
      objective: soapSection,
      assessment: soapSection,
      plan: soapSection,
      replaceExisting: z.boolean().optional(),
    })
    .refine((v) => hasSoapContent(v), "Provide at least one SOAP section."),
  readOnly: false,
  requiredApiScopes: ["records:write"],
  requiresStaffUser: true,
  async execute(args, ctx) {
    const input = this.zod.parse(args) as {
      patientId: string;
      appointmentId: string;
      subjective?: string;
      objective?: string;
      assessment?: string;
      plan?: string;
      replaceExisting?: boolean;
    };
    const actor = ctx.staffUser;
    if (!actor) return { error: "Only a signed-in clinician can save a SOAP draft." };
    if (actor.role !== "admin" && actor.role !== "veterinarian") {
      return { error: "Only veterinarians and administrators can write SOAP notes." };
    }
    const visitLink = `/encounters/${input.appointmentId}`;
    try {
      return await ctx.db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const scope = {
          practiceId: ctx.practiceId,
          patientId: input.patientId,
          appointmentId: input.appointmentId,
        };
        const existing = await getAppointmentSoapDraft(tx, scope);
        if (existing && hasSoapContent(existing) && !input.replaceExisting) {
          return {
            saved: false,
            reason:
              "This visit already has a SOAP draft. Ask the clinician whether to replace it, or merge the new notes into it and call again with replaceExisting=true.",
            existingDraft: {
              subjective: existing.subjective,
              objective: existing.objective,
              assessment: existing.assessment,
              plan: existing.plan,
            },
            visitLink,
          };
        }
        const result = await saveAppointmentSoapDraft(tx, {
          ...scope,
          noteId: existing?.id,
          expectedRevision: existing?.revision ?? 0,
          actor: { id: actor.id, name: actor.name },
          sections: {
            subjective: input.subjective ?? null,
            objective: input.objective ?? null,
            assessment: input.assessment ?? null,
            plan: input.plan ?? null,
          },
        });
        if (result.outcome === "already_finalized") {
          return {
            saved: false,
            reason: "This visit's SOAP note is already finalized. Add an addendum from the visit screen instead.",
            visitLink,
          };
        }
        if (result.outcome === "conflict") {
          return {
            saved: false,
            reason: "Someone else changed this draft at the same moment. Open the visit to review it.",
            visitLink,
          };
        }
        return {
          saved: true,
          status: "draft",
          revision: result.draft.revision,
          visitLink,
          nextStep: "Open the visit to review, edit and finalize the note.",
        };
      });
    } catch (error) {
      if (error instanceof SoapLifecycleError) return { error: error.message };
      throw error;
    }
  },
};

export const VET_ASSISTANT_TOOLS: AgentTool[] = [
  getMyDay,
  searchPatientHistory,
  listMedications,
  getMyTodo,
  saveSoapDraft,
];
