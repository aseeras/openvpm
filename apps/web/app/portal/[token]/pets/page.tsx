"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { calculatePortalAge } from "@/lib/portal/date";
import { ZP } from "@/lib/portal/zenpaws-theme";
import { PetAvatar } from "@/components/portal/pet-avatar";

/** Every pet on file, each opening its health record. */
export default function PortalPetsPage() {
  const { data, isLoading } = trpc.portal.getClient.useQuery({});

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[26px] font-black">My pets</h1>
        <p className="text-sm font-semibold" style={{ color: ZP.muted }}>
          Vaccines, visit history and records for each pet.
        </p>
      </div>
      {isLoading ? (
        <p className="text-sm" style={{ color: ZP.muted }}>Loading…</p>
      ) : (data?.patients ?? []).length === 0 ? (
        <p className="rounded-[18px] border bg-white p-4 text-sm" style={{ borderColor: ZP.border, color: ZP.muted }}>
          No pets on file yet.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {data!.patients.map((pet) => (
            <li key={pet.id}>
              <Link
                href={`/portal/pets/${pet.id}`}
                className="flex items-center gap-3 rounded-[18px] border bg-white p-3"
                style={{ borderColor: ZP.border }}
              >
                <PetAvatar name={pet.name} photoUrl={pet.photoUrl} size={56} />
                <span className="min-w-0 flex-1">
                  <span className="block text-lg font-extrabold">{pet.name}</span>
                  <span className="block text-sm font-semibold" style={{ color: ZP.muted }}>
                    {[pet.breed, pet.dob ? calculatePortalAge(pet.dob) : null].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <ChevronRight className="h-5 w-5" style={{ color: ZP.muted }} aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link
        href="/portal/messages?topic=new-pet"
        className="flex min-h-12 items-center justify-center rounded-full border text-sm font-extrabold"
        style={{ borderColor: ZP.accent, color: ZP.accent }}
      >
        Add a pet
      </Link>
    </div>
  );
}
