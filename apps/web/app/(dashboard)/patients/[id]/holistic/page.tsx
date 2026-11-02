"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  Check,
  Copy,
  Loader2,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { CapturePhotos } from "@/components/records/capture-photos";
import { MODALITIES, type Modality } from "@/lib/holistic/tcm-reference";
import {
  formatTcmWorkupAsText,
  TCM_WORKUP_MAX_PHOTOS,
  type TcmPointPlan,
  type TcmWorkup,
} from "@/lib/holistic/tcm-workup-shared";
import {
  CLIENT_UPLOAD_TIMEOUT_MS,
  fetchWithClientTimeout,
} from "@/lib/client-fetch";

const MODALITY_STORAGE_KEY = "openvpm.holistic.modalities";
const PHOTO_MAX_EDGE_PX = 1600;

function readSavedModalities(): Modality[] {
  try {
    const raw = window.localStorage.getItem(MODALITY_STORAGE_KEY);
    if (!raw) return MODALITIES.map((m) => m.id);
    const ids = new Set(MODALITIES.map((m) => m.id));
    const saved = (JSON.parse(raw) as unknown[]).filter(
      (id): id is Modality => typeof id === "string" && ids.has(id as Modality),
    );
    return saved.length > 0 ? saved : MODALITIES.map((m) => m.id);
  } catch {
    return MODALITIES.map((m) => m.id);
  }
}

/** Shrink a camera photo to a JPEG the AI can read quickly. */
async function shrinkPhoto(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(
      1,
      PHOTO_MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    if (!blob) return file;
    const base = file.name.replace(/\.[^.]+$/, "") || "photo";
    return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

export default function HolisticWorkupPage() {
  const params = useParams<{ id: string }>();
  const patientId = params.id;
  const { data: session, status } = useSession();
  const role = session?.user?.role;
  const allowed = role === "admin" || role === "veterinarian";

  const patient = trpc.patients.getById.useQuery(
    { id: patientId },
    { enabled: !!patientId && allowed },
  );
  const photos = trpc.records.listCaptureFiles.useQuery(
    { patientId },
    { enabled: !!patientId && allowed, refetchInterval: 10_000 },
  );

  const [diagnosis, setDiagnosis] = useState("");
  const [complaint, setComplaint] = useState("");
  const [tongue, setTongue] = useState("");
  const [pulse, setPulse] = useState("");
  const [otherFindings, setOtherFindings] = useState("");
  const [modalities, setModalities] = useState<Modality[]>(() =>
    MODALITIES.map((m) => m.id),
  );
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setModalities(readSavedModalities());
  }, []);

  const draft = trpc.holistic.draftWorkup.useMutation({
    onError: (err) => toast.error(err.message),
  });

  function toggleModality(id: Modality) {
    setModalities((current) => {
      const next = current.includes(id)
        ? current.filter((m) => m !== id)
        : MODALITIES.map((m) => m.id).filter((m) => m === id || current.includes(m));
      try {
        window.localStorage.setItem(MODALITY_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Remembering the choice is a convenience only.
      }
      return next;
    });
  }

  function togglePhoto(id: string) {
    setSelectedPhotoIds((current) => {
      if (current.includes(id)) return current.filter((p) => p !== id);
      if (current.length >= TCM_WORKUP_MAX_PHOTOS) {
        toast.error(`Pick up to ${TCM_WORKUP_MAX_PHOTOS} photos.`);
        return current;
      }
      return [...current, id];
    });
  }

  async function handleTakePhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(e.target.files ?? []);
    e.currentTarget.value = "";
    if (chosen.length === 0) return;
    setUploading(true);
    try {
      for (const original of chosen) {
        const file = await shrinkPhoto(original);
        const body = new FormData();
        body.append("file", file);
        body.append("category", "patient-photos");
        body.append("purpose", "clinical");
        body.append("patientId", patientId);
        const res = await fetchWithClientTimeout(
          "/api/upload",
          {
            method: "POST",
            body,
            headers: { "Idempotency-Key": crypto.randomUUID() },
          },
          CLIENT_UPLOAD_TIMEOUT_MS,
        );
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(json.error ?? "Upload failed");
      }
      const before = new Set((photos.data ?? []).map((p) => p.id));
      const refreshed = await photos.refetch();
      const added = (refreshed.data ?? [])
        .filter((p) => !before.has(p.id))
        .map((p) => p.id);
      setSelectedPhotoIds((current) =>
        [...current, ...added].slice(0, TCM_WORKUP_MAX_PHOTOS),
      );
      toast.success(chosen.length === 1 ? "Photo added" : "Photos added");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!diagnosis.trim()) {
      toast.error("Add the diagnosis first.");
      return;
    }
    if (modalities.length === 0) {
      toast.error("Pick at least one treatment option.");
      return;
    }
    setCopied(false);
    draft.mutate({
      patientId,
      conventionalDiagnosis: diagnosis,
      presentingComplaint: complaint,
      tongue,
      pulse,
      otherFindings,
      modalities,
      photoIds: selectedPhotoIds,
    });
  }

  async function handleCopy(workup: TcmWorkup) {
    try {
      await navigator.clipboard.writeText(formatTcmWorkupAsText(workup));
      setCopied(true);
      toast.success("Copied. Paste it into the visit note.");
    } catch {
      toast.error("Could not copy. Select the text and copy it instead.");
    }
  }

  if (status !== "loading" && !allowed) {
    return (
      <p className="text-sm text-muted-foreground">
        Only veterinarians and admins can run a holistic workup.
      </p>
    );
  }

  const photoList = photos.data ?? [];
  const workup = draft.data;

  return (
    <div className="mx-auto max-w-4xl">
      <Button variant="ghost" size="sm" asChild className="mb-4">
        <Link href={`/patients/${encodeURIComponent(patientId)}`}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to patient
        </Link>
      </Button>

      <h2 className="font-heading text-xl font-semibold">Holistic (TCVM) workup</h2>
      {patient.data && (
        <p className="text-sm text-muted-foreground">
          {patient.data.name}
          {patient.data.species ? ` · ${patient.data.species}` : ""}
          {patient.data.breed ? ` (${patient.data.breed})` : ""}
        </p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        An AI draft for the veterinarian to review. It does not change the
        record; copy what you keep into the visit note.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-6">
        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h3 className="font-heading text-base font-semibold">Findings</h3>
          <label className="block space-y-1">
            <span className="text-sm font-medium">Diagnosis *</span>
            <Textarea
              value={diagnosis}
              onChange={(e) => setDiagnosis(e.target.value)}
              placeholder="e.g. Bilateral hip osteoarthritis, grade 2 lameness right hind"
              rows={2}
              maxLength={4000}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">History and presenting signs</span>
            <Textarea
              value={complaint}
              onChange={(e) => setComplaint(e.target.value)}
              placeholder="e.g. Stiff in the mornings, worse in cold weather, seeks warm spots, pants at night"
              rows={3}
              maxLength={4000}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-sm font-medium">Tongue</span>
              <Input
                value={tongue}
                onChange={(e) => setTongue(e.target.value)}
                placeholder="e.g. Pale, wet, slightly swollen"
                maxLength={500}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">Pulse</span>
              <Input
                value={pulse}
                onChange={(e) => setPulse(e.target.value)}
                placeholder="e.g. Deep, weak, slow on the right"
                maxLength={500}
              />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="text-sm font-medium">Other TCVM findings</span>
            <Textarea
              value={otherFindings}
              onChange={(e) => setOtherFindings(e.target.value)}
              placeholder="e.g. Sensitive at BL-23 and Bai-hui, cool ears and paws, constitution Earth"
              rows={2}
              maxLength={4000}
            />
          </label>
        </section>

        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-heading text-base font-semibold">Photos</h3>
              <p className="text-xs text-muted-foreground">
                Tongue, gait, posture, coat, or skin. Pick up to {TCM_WORKUP_MAX_PHOTOS}.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="hidden"
                onChange={handleTakePhoto}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Camera className="mr-2 h-4 w-4" />
                )}
                Take or add photo
              </Button>
              <CapturePhotos patientId={patientId} />
            </div>
          </div>
          {photos.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading photos...</p>
          ) : photoList.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No photos on this patient yet. Photos are optional.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {photoList.map((photo) => {
                const index = selectedPhotoIds.indexOf(photo.id);
                const selected = index !== -1;
                return (
                  <button
                    key={photo.id}
                    type="button"
                    onClick={() => togglePhoto(photo.id)}
                    aria-pressed={selected}
                    aria-label={`${selected ? "Remove" : "Use"} ${photo.fileName}`}
                    className={`relative overflow-hidden rounded-lg border-2 ${
                      selected ? "border-primary" : "border-transparent opacity-80"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={photo.fileUrl}
                      alt={photo.fileName}
                      className="aspect-square w-full object-cover"
                    />
                    {selected && (
                      <span className="absolute left-1 top-1 rounded-full bg-primary px-2 text-xs font-semibold text-primary-foreground">
                        {index + 1}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h3 className="font-heading text-base font-semibold">Treatments we offer</h3>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {MODALITIES.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={modalities.includes(m.id)}
                  onChange={() => toggleModality(m.id)}
                />
                {m.label}
              </label>
            ))}
          </div>
        </section>

        <Button type="submit" disabled={draft.isPending || uploading}>
          {draft.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-2 h-4 w-4" />
          )}
          {draft.isPending ? "Preparing workup..." : "Prepare workup"}
        </Button>
      </form>

      {workup && (
        <WorkupResult
          workup={workup}
          copied={copied}
          onCopy={() => void handleCopy(workup)}
        />
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 rounded-xl border border-border bg-card p-4">
      <h3 className="font-heading text-base font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function PointList({ points }: { points: TcmPointPlan[] }) {
  if (points.length === 0) return null;
  return (
    <ul className="space-y-2">
      {points.map((p) => (
        <li key={p.code} className="text-sm">
          <span className="font-semibold">{p.code}</span> {p.name}
          {p.pregnancyCaution && (
            <Badge variant="warning" className="ml-2">
              Pregnancy caution
            </Badge>
          )}
          {p.rationale && <span className="text-foreground">: {p.rationale}</span>}
          <span className="block text-xs text-muted-foreground">{p.location}</span>
        </li>
      ))}
    </ul>
  );
}

function WorkupResult({
  workup,
  copied,
  onCopy,
}: {
  workup: TcmWorkup;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="mt-8 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-lg font-semibold">Draft workup</h2>
        <Button variant="outline" size="sm" onClick={onCopy}>
          {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
          {copied ? "Copied" : "Copy for visit note"}
        </Button>
      </div>

      <Section title="TCVM assessment">
        {workup.summary && <p className="text-sm">{workup.summary}</p>}
        {workup.patterns.map((p) => (
          <div key={p.name} className="text-sm">
            <span className="font-semibold">{p.name}</span>{" "}
            <Badge
              variant={p.confidence === "high" ? "success" : p.confidence === "moderate" ? "info" : "outline"}
            >
              {p.confidence} confidence
            </Badge>
            {p.evidence.length > 0 && (
              <ul className="ml-5 mt-1 list-disc text-muted-foreground">
                {p.evidence.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {workup.eightPrinciples && (
          <p className="text-sm text-muted-foreground">
            Eight principles:{" "}
            {[
              workup.eightPrinciples.yinYang,
              workup.eightPrinciples.interiorExterior,
              workup.eightPrinciples.hotCold,
              workup.eightPrinciples.excessDeficiency,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
        {workup.zangFu.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Zang-Fu: {workup.zangFu.join(", ")}
          </p>
        )}
        {workup.treatmentPrinciple && (
          <p className="text-sm">
            <span className="font-semibold">Treatment principle:</span>{" "}
            {workup.treatmentPrinciple}
          </p>
        )}
      </Section>

      {workup.photoFindings.length > 0 && (
        <Section title="What the photos show">
          <ul className="space-y-1 text-sm">
            {workup.photoFindings.map((f) => (
              <li key={`${f.photo}-${f.observation}`}>
                <span className="font-semibold">{f.photo}:</span> {f.observation}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {workup.acupuncture && (
        <Section title="Acupuncture">
          <PointList points={workup.acupuncture.points} />
          {workup.acupuncture.technique && (
            <p className="text-sm"><span className="font-semibold">Technique:</span> {workup.acupuncture.technique}</p>
          )}
          {workup.acupuncture.schedule && (
            <p className="text-sm"><span className="font-semibold">Schedule:</span> {workup.acupuncture.schedule}</p>
          )}
        </Section>
      )}

      {workup.laser && (
        <Section title="Laser therapy">
          <PointList points={workup.laser.points} />
          {workup.laser.areas.length > 0 && (
            <p className="text-sm"><span className="font-semibold">Areas:</span> {workup.laser.areas.join(", ")}</p>
          )}
          {workup.laser.dose && (
            <p className="text-sm"><span className="font-semibold">Dose:</span> {workup.laser.dose}</p>
          )}
          {workup.laser.schedule && (
            <p className="text-sm"><span className="font-semibold">Schedule:</span> {workup.laser.schedule}</p>
          )}
          {workup.laser.cautions && (
            <p className="text-sm text-amber-700"><span className="font-semibold">Cautions:</span> {workup.laser.cautions}</p>
          )}
        </Section>
      )}

      {workup.exercises.length > 0 && (
        <Section title="Therapeutic exercise">
          <ul className="space-y-2 text-sm">
            {workup.exercises.map((e) => (
              <li key={e.name}>
                <span className="font-semibold">{e.name}</span>
                {e.frequency && <span className="text-muted-foreground"> · {e.frequency}</span>}
                {e.instructions && <span className="block">{e.instructions}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {workup.herbs.length > 0 && (
        <Section title="Chinese herbal medicine">
          <ul className="space-y-3 text-sm">
            {workup.herbs.map((h) => (
              <li key={h.formula}>
                <span className="font-semibold">{h.formula}</span>
                {!h.inReference && (
                  <Badge variant="warning" className="ml-2">Not in reference list, verify</Badge>
                )}
                {h.rationale && <span className="block">{h.rationale}</span>}
                {h.dosing && <span className="block text-muted-foreground">Dosing: {h.dosing}</span>}
                {h.cautions && <span className="block text-amber-700">Cautions: {h.cautions}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {workup.food && (
        <Section title="Food therapy">
          {workup.food.energetics && <p className="text-sm">{workup.food.energetics}</p>}
          {workup.food.recommend.length > 0 && (
            <p className="text-sm"><span className="font-semibold">Recommend:</span> {workup.food.recommend.join(", ")}</p>
          )}
          {workup.food.avoid.length > 0 && (
            <p className="text-sm"><span className="font-semibold">Avoid:</span> {workup.food.avoid.join(", ")}</p>
          )}
          {workup.food.notes && <p className="text-sm text-muted-foreground">{workup.food.notes}</p>}
        </Section>
      )}

      {(workup.cautions.length > 0 || workup.droppedPoints.length > 0) && (
        <Section title="Cautions">
          <ul className="space-y-1 text-sm">
            {workup.cautions.map((c) => (
              <li key={c} className="flex gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                {c}
              </li>
            ))}
            {workup.droppedPoints.length > 0 && (
              <li className="text-muted-foreground">
                Left out points not in the reference list: {workup.droppedPoints.join(", ")}
              </li>
            )}
          </ul>
        </Section>
      )}

      {workup.followUp && (
        <Section title="Follow-up">
          <p className="text-sm">{workup.followUp}</p>
        </Section>
      )}
    </div>
  );
}
