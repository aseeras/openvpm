"use client";

import { petInitial, ZP } from "@/lib/portal/zenpaws-theme";

/** A pet's photo, or its initial on a soft yellow tile. */
export function PetAvatar({
  name,
  photoUrl,
  size = 48,
}: {
  name: string;
  photoUrl: string | null;
  size?: number;
}) {
  if (photoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={photoUrl}
        alt=""
        className="shrink-0 rounded-2xl object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-2xl text-lg font-black"
      style={{ width: size, height: size, backgroundColor: ZP.sunSoft, color: ZP.sunInk }}
    >
      {petInitial(name)}
    </span>
  );
}
