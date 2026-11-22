/** Pictogrammes du module Projets (trait 1,8 px, comme le menu). */
const PATHS = {
  play: ["M8 5.5v13l10.5-6.5z"],
  stop: ["M7 7h10v10H7z"],
  pin: ["M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z", "M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"],
  alert: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7.5v5.5", "M12 16.5h.01"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"],
  hand: ["M8 13V5.5a1.5 1.5 0 0 1 3 0V11", "M11 10.5V4a1.5 1.5 0 0 1 3 0v6.5", "M14 10.5V5.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.7-2.3L3.5 16a1.5 1.5 0 0 1 2.3-1.9L8 16"],
  receipt: ["M6 3h12v18l-3-2-3 2-3-2-3 2z", "M9 8h6", "M9 12h6"],
  close: ["M6 6l12 12", "M18 6 6 18"],
  sync: ["M20 11a8 8 0 0 0-14.3-4.5L4 8", "M4 4v4h4", "M4 13a8 8 0 0 0 14.3 4.5L20 16", "M20 20v-4h-4"],
  users: ["M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M2 21a7 7 0 0 1 14 0", "M16 3.5a4 4 0 0 1 0 7", "M19 14.5a7 7 0 0 1 3 6.5"],
  plus: ["M12 5v14", "M5 12h14"],
  flag: ["M5 21V4", "M5 4h11l-2 4 2 4H5"],
  folder: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
  list: ["M9 6h11", "M9 12h11", "M9 18h11", "M4 6h.01", "M4 12h.01", "M4 18h.01"],
} as const;

export type ProjectIconName = keyof typeof PATHS;

export function PIcon({ name, className = "" }: { name: ProjectIconName; className?: string }) {
  const filled = name === "play" || name === "stop";
  return (
    <svg className={`pico ${className}`} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={filled ? 0 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

/** Pastille d'initiales d'une personne. */
export function Initials({ name, title }: { name: string; title?: string }) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const ini = ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
  return <span className="ini" title={title ?? name} aria-hidden="true">{ini}</span>;
}
