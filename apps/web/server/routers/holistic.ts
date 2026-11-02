import { z } from "zod";
import { and, desc, eq, inArray, isNotNull, isNull, like, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  createRouter,
  protectedProcedure,
  requireFeature,
  requireRole,
} from "../trpc";
import {
  clinicalRecordCorrections,
  files,
  patientAllergies,
  patients,
  practices,
  prescriptions,
  problemList,
  soapNotes,
  vitalSigns,
} from "@openpims/db";
import { AgentNotConfiguredError } from "@/lib/agent";
import { rateLimit } from "@/lib/rate-limit";
import { recordUsage } from "@/lib/billing/usage";
import { readHostedAiAccess } from "@/lib/billing/ai-access";
import {
  lockPracticeForExternalSideEffects,
  RECOVERY_HOLD_BLOCK_MESSAGE,
} from "@/lib/recovery-hold";
import { PATIENT_PHOTO_CATEGORY } from "@/lib/records/file-kinds";
import { isAllowedImageUploadMimeType } from "@/lib/upload-security";
import { getObject } from "@/lib/s3";
import { latestPatientCheckIn } from "@/lib/check-in/store";
import { formatCheckInForClinicalContext } from "@/lib/check-in/form";
import { MODALITIES, type Modality } from "@/lib/holistic/tcm-reference";
import {
  draftTcmWorkup,
  TCM_WORKUP_MAX_PHOTOS,
  TCM_WORKUP_PHOTO_MAX_BYTES,
  TCM_WORKUP_SHORT_TEXT_MAX_LENGTH,
  TCM_WORKUP_TEXT_MAX_LENGTH,
  TcmWorkupUnavailableError,
} from "@/lib/holistic/tcm-workup";

const modalityIds = MODALITIES.map((m) => m.id) as [Modality, ...Modality[]];

function activePracticePredicate(practiceId: string) {
  return sql`exists (
    select 1
    from ${practices}
    where ${practices.id} = ${practiceId}
      and ${practices.deletedAt} is null
  )`;
}

function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));
}

export const holisticRouter = createRouter({
  /**
   * Draft a TCVM pattern diagnosis and integrative treatment plan from the
   * clinician's diagnosis, TCVM exam findings, chart context, and patient
   * photos. Returns a draft only; nothing is written to the record.
   */
  draftWorkup: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .use(requireFeature("agent"))
    .input(
      z.object({
        patientId: z.string().guid(),
        /** Optional: without it the AI gives its own diagnostic read. */
        conventionalDiagnosis: optionalText(TCM_WORKUP_TEXT_MAX_LENGTH),
        /** Use the owner's latest pre-visit check-in answers. */
        includeOwnerCheckIn: z.boolean().default(true),
        presentingComplaint: optionalText(TCM_WORKUP_TEXT_MAX_LENGTH),
        tongue: optionalText(TCM_WORKUP_SHORT_TEXT_MAX_LENGTH),
        pulse: optionalText(TCM_WORKUP_SHORT_TEXT_MAX_LENGTH),
        otherFindings: optionalText(TCM_WORKUP_TEXT_MAX_LENGTH),
        modalities: z
          .array(z.enum(modalityIds))
          .min(1, "Pick at least one treatment option.")
          .max(modalityIds.length),
        photoIds: z
          .array(z.string().guid())
          .max(TCM_WORKUP_MAX_PHOTOS)
          .default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const practiceId = ctx.practiceId;
      const [patient] = await ctx.db
        .select({
          name: patients.name,
          species: patients.species,
          breed: patients.breed,
          sex: patients.sex,
          dob: patients.dob,
        })
        .from(patients)
        .where(
          and(
            eq(patients.id, input.patientId),
            eq(patients.practiceId, practiceId),
            activePracticePredicate(practiceId),
            isNull(patients.deletedAt),
          ),
        )
        .limit(1);
      if (!patient) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found" });
      }

      const limit = await rateLimit({
        key: `tcm-workup:${practiceId}:actor:${ctx.user.id}`,
        limit: 6,
        windowMs: 60_000,
      });
      if (!limit.success) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many workups at once. Wait a minute and try again.",
        });
      }

      const photoIds = [...new Set(input.photoIds)];
      const checkIn = input.includeOwnerCheckIn
        ? await latestPatientCheckIn(ctx.db, practiceId, input.patientId)
        : null;
      const checkInSummary = checkIn
        ? formatCheckInForClinicalContext(checkIn.answers)
        : "";
      const hasEvidence =
        Boolean(input.conventionalDiagnosis) ||
        Boolean(input.presentingComplaint) ||
        Boolean(input.tongue) ||
        Boolean(input.pulse) ||
        Boolean(input.otherFindings) ||
        photoIds.length > 0 ||
        checkInSummary.length > 0;
      if (!hasEvidence) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Add a diagnosis, findings, or a photo first. There is no owner check-in to work from.",
        });
      }
      const [allergies, problems, meds, assessments, [latestVitals], photoRows] =
        await Promise.all([
          ctx.db
            .select({
              allergen: patientAllergies.allergen,
              severity: patientAllergies.severity,
            })
            .from(patientAllergies)
            .where(
              and(
                eq(patientAllergies.patientId, input.patientId),
                activePracticePredicate(practiceId),
                sql`exists (
                  select 1 from ${patients}
                  where ${patients.id} = ${patientAllergies.patientId}
                    and ${patients.practiceId} = ${practiceId}
                    and ${patients.deletedAt} is null
                )`,
                sql`not exists (
                  select 1 from ${clinicalRecordCorrections} as allergy_correction
                  where allergy_correction.practice_id = ${practiceId}
                    and allergy_correction.patient_allergy_id = ${patientAllergies.id}
                )`,
                isNull(patientAllergies.deletedAt),
              ),
            ),
          ctx.db
            .select({
              description: problemList.description,
              status: problemList.status,
            })
            .from(problemList)
            .where(
              and(
                eq(problemList.patientId, input.patientId),
                eq(problemList.practiceId, practiceId),
                isNull(problemList.deletedAt),
              ),
            ),
          ctx.db
            .select({
              name: prescriptions.medicationName,
              dosage: prescriptions.dosage,
              frequency: prescriptions.frequency,
            })
            .from(prescriptions)
            .where(
              and(
                eq(prescriptions.patientId, input.patientId),
                eq(prescriptions.practiceId, practiceId),
                eq(prescriptions.status, "active"),
                isNull(prescriptions.deletedAt),
              ),
            )
            .limit(30),
          ctx.db
            .select({ assessment: soapNotes.assessment })
            .from(soapNotes)
            .where(
              and(
                eq(soapNotes.patientId, input.patientId),
                eq(soapNotes.practiceId, practiceId),
                eq(soapNotes.status, "finalized"),
                isNotNull(soapNotes.assessment),
                isNull(soapNotes.deletedAt),
              ),
            )
            .orderBy(desc(soapNotes.createdAt))
            .limit(3),
          ctx.db
            .select({ weightKg: vitalSigns.weightKg })
            .from(vitalSigns)
            .where(
              and(
                eq(vitalSigns.patientId, input.patientId),
                eq(vitalSigns.practiceId, practiceId),
                isNotNull(vitalSigns.weightKg),
                isNull(vitalSigns.deletedAt),
              ),
            )
            .orderBy(desc(vitalSigns.recordedAt))
            .limit(1),
          photoIds.length === 0
            ? Promise.resolve([])
            : ctx.db
                .select({
                  id: files.id,
                  fileName: files.fileName,
                  fileKey: files.fileKey,
                  mimeType: files.mimeType,
                })
                .from(files)
                .where(
                  and(
                    inArray(files.id, photoIds),
                    eq(files.practiceId, practiceId),
                    eq(files.entityType, "patient"),
                    eq(files.entityId, input.patientId),
                    eq(files.category, PATIENT_PHOTO_CATEGORY),
                    like(files.mimeType, "image/%"),
                    eq(files.storageStatus, "available"),
                    isNull(files.deletedAt),
                  ),
                ),
        ]);

      if (photoRows.length !== photoIds.length) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "One of the photos is no longer on this patient's record.",
        });
      }

      // Keep the clinician's chosen order so "Photo 1" matches the screen.
      const orderedPhotos = photoIds.map(
        (id) => photoRows.find((row) => row.id === id)!,
      );
      const photos = await Promise.all(
        orderedPhotos.map(async (row, index) => {
          const mediaType = row.mimeType ?? "";
          if (!isAllowedImageUploadMimeType(mediaType)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `${row.fileName} is not a JPEG, PNG, or WebP photo.`,
            });
          }
          const object = await getObject(row.fileKey, {
            maxBytes: TCM_WORKUP_PHOTO_MAX_BYTES,
          });
          if (!object) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: `${row.fileName} could not be read (it may be too large; retake it on this page).`,
            });
          }
          return {
            label: `Photo ${index + 1}`,
            data: object.body,
            mediaType,
          };
        }),
      );

      if (!(await lockPracticeForExternalSideEffects(ctx.db, practiceId))) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: RECOVERY_HOLD_BLOCK_MESSAGE,
        });
      }
      const aiAccess = await readHostedAiAccess(ctx.db, practiceId);
      if (!aiAccess) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
      }
      if (!aiAccess.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: aiAccess.message ?? "OpenVPM AI is not available.",
        });
      }

      try {
        const workup = await draftTcmWorkup({
          patient: { ...patient, weightKg: latestVitals?.weightKg ?? null },
          allergies,
          activeProblems: problems,
          medications: meds,
          recentAssessments: assessments
            .map((a) => (a.assessment ?? "").trim().slice(0, 600))
            .filter(Boolean),
          conventionalDiagnosis: input.conventionalDiagnosis,
          ownerCheckIn: checkInSummary
            ? {
                submittedAt: checkIn!.submittedAt.toISOString().slice(0, 10),
                summary: checkInSummary,
              }
            : undefined,
          presentingComplaint: input.presentingComplaint,
          tongue: input.tongue,
          pulse: input.pulse,
          otherFindings: input.otherFindings,
          modalities: input.modalities,
          photos,
        });
        await recordUsage({ practiceId, kind: "ai_run" });
        return workup;
      } catch (e) {
        if (e instanceof AgentNotConfiguredError) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: e.message });
        }
        if (e instanceof TcmWorkupUnavailableError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not prepare the workup. Try again.",
        });
      }
    }),
});
