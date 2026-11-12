"use client";

import { useId, useState } from "react";
import { trpc } from "@/lib/trpc";
import {
  PATIENT_SPECIES_OPTIONS,
  type PatientSpecies,
} from "@/lib/patients/species";

/** The species most clients pick, in plain words, ahead of the full list. */
const COMMON_SPECIES: ReadonlyArray<{ value: PatientSpecies; label: string }> = [
  { value: "canine", label: "Dog" },
  { value: "feline", label: "Cat" },
  { value: "rabbit", label: "Rabbit" },
  { value: "avian", label: "Bird" },
];
const COMMON_VALUES = new Set(COMMON_SPECIES.map((option) => option.value));
const OTHER_SPECIES = PATIENT_SPECIES_OPTIONS.filter(
  (option) => !COMMON_VALUES.has(option.value),
);

/**
 * Lets a signed-in client put a pet on file from the booking form, so a new
 * client can request a first visit right away. The clinic reviews the chart.
 */
export function AddPetForm({
  onAdded,
  onCancel,
}: {
  onAdded: (patientId: string) => void;
  onCancel?: () => void;
}) {
  const formId = useId();
  const nameId = `${formId}-name`;
  const speciesId = `${formId}-species`;
  const breedId = `${formId}-breed`;
  const [name, setName] = useState("");
  const [species, setSpecies] = useState<PatientSpecies | "">("");
  const [breed, setBreed] = useState("");
  const utils = trpc.useUtils();
  const addPet = trpc.portal.addPet.useMutation({
    onSuccess: async (result) => {
      await utils.portal.getClient.invalidate();
      onAdded(result.patientId);
    },
  });

  const canSubmit =
    name.trim().length > 0 && species !== "" && !addPet.isPending;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!species || !canSubmit) return;
    addPet.mutate({
      name: name.trim(),
      species,
      breed: breed.trim() || undefined,
    });
  }

  const inputClass =
    "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

  return (
    <form
      onSubmit={submit}
      aria-label="Add your pet"
      className="space-y-4 rounded-xl border border-gray-200 bg-white p-4"
    >
      <div>
        <p className="text-base font-semibold text-gray-900">Add your pet</p>
        <p className="mt-0.5 text-sm text-gray-500">
          Tell us who the visit is for. The clinic will fill in
          the rest of the chart with you.
        </p>
      </div>
      <div>
        <label
          htmlFor={nameId}
          className="mb-1.5 block text-sm font-medium text-gray-700"
        >
          Pet&apos;s name
        </label>
        <input
          id={nameId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={128}
          autoComplete="off"
          required
          className={inputClass}
        />
      </div>
      <div>
        <label
          htmlFor={speciesId}
          className="mb-1.5 block text-sm font-medium text-gray-700"
        >
          Species
        </label>
        <select
          id={speciesId}
          value={species}
          onChange={(event) =>
            setSpecies(event.target.value as PatientSpecies | "")
          }
          required
          className={inputClass}
        >
          <option value="" disabled>
            Choose…
          </option>
          {COMMON_SPECIES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          <optgroup label="Other animals">
            {OTHER_SPECIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </optgroup>
        </select>
      </div>
      <div>
        <label
          htmlFor={breedId}
          className="mb-1.5 block text-sm font-medium text-gray-700"
        >
          Breed <span className="font-normal text-gray-400">(optional)</span>
        </label>
        <input
          id={breedId}
          value={breed}
          onChange={(event) => setBreed(event.target.value)}
          maxLength={128}
          autoComplete="off"
          className={inputClass}
        />
      </div>
      {addPet.error ? (
        <p role="alert" className="text-sm text-red-600">
          {addPet.error.message}
        </p>
      ) : null}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={!canSubmit}
          className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {addPet.isPending ? "Adding…" : "Add pet"}
        </button>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
