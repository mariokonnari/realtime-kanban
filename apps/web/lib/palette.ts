// Column accent colors cycle through this fixed sequence by column order
// index, so the mapping still makes sense if column-management UI ever
// lets someone add a 4th+ column beyond the three seeded today.
export const COLUMN_ACCENTS = ["sky", "sunflower", "lavender", "pink"] as const;
export type ColumnAccent = (typeof COLUMN_ACCENTS)[number];

export function accentForIndex(index: number): ColumnAccent {
  return COLUMN_ACCENTS[index % COLUMN_ACCENTS.length];
}

// Written as full literal class names (not built with template strings at
// the call site) so Tailwind's content scanner can find them statically.
export const ACCENT_BG: Record<ColumnAccent, string> = {
  sky: "bg-accent-sky",
  sunflower: "bg-accent-sunflower",
  lavender: "bg-accent-lavender",
  pink: "bg-accent-pink",
};

export const ACCENT_BG_SOFT: Record<ColumnAccent, string> = {
  sky: "bg-accent-sky/10",
  sunflower: "bg-accent-sunflower/10",
  lavender: "bg-accent-lavender/10",
  pink: "bg-accent-pink/10",
};

export const ACCENT_BORDER: Record<ColumnAccent, string> = {
  sky: "border-accent-sky",
  sunflower: "border-accent-sunflower",
  lavender: "border-accent-lavender",
  pink: "border-accent-pink",
};

export const ACCENT_BORDER_SOFT: Record<ColumnAccent, string> = {
  sky: "border-accent-sky/40",
  sunflower: "border-accent-sunflower/40",
  lavender: "border-accent-lavender/40",
  pink: "border-accent-pink/40",
};

// Deterministic per-card tilt so cards don't shift on re-render — hashed
// from the card id, clamped to a subtle ±1.2deg range.
export function tiltForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  const degrees = Math.round(((hash % 240) / 100 - 1.2) * 10) / 10;
  return `${degrees}deg`;
}
