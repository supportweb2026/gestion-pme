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
  doc: ["M7 3h7l5 5v13H7z", "M14 3v5h5", "M10 13h6", "M10 17h6"],
  chevron: ["M9 6l6 6-6 6"],
  diamond: ["M12 3.5l8.5 8.5-8.5 8.5L3.5 12z"],
  building: ["M4 21V5l8-2v18", "M12 9h8v12", "M8 8h.01", "M8 12h.01", "M8 16h.01", "M16 13h.01", "M16 17h.01", "M2 21h20"],
  image: ["M4 5h16v14H4z", "M4 16l5-5 4 4 3-3 4 4", "M15.5 9.5h.01"],
  layers: ["M12 3l9 5-9 5-9-5z", "M3 13l9 5 9-5"],
  coins: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M14.8 9.2A3 3 0 0 0 12 8c-1.7 0-3 .9-3 2s1.3 2 3 2 3 .9 3 2-1.3 2-3 2a3 3 0 0 1-2.8-1.2", "M12 6.5V8", "M12 16v1.5"],
  copy: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  pushpin: ["M9 3h6l-1 6 4 4H6l4-4z", "M12 13v8"],
  calendar: ["M4 6h16v15H4z", "M4 10h16", "M8 3v5", "M16 3v5"],
  arrowUp: ["M12 19V5", "M6 11l6-6 6 6"],
  arrowDown: ["M12 5v14", "M6 13l6 6 6-6"],
  // Lot 4 : météo, budget, décisions.
  sun: ["M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M12 2.5v2", "M12 19.5v2", "M5.3 5.3l1.4 1.4", "M17.3 17.3l1.4 1.4", "M2.5 12h2", "M19.5 12h2", "M5.3 18.7l1.4-1.4", "M17.3 6.7l1.4-1.4"],
  cloud: ["M7 18.5h10a4 4 0 0 0 .6-8 6 6 0 0 0-11.4 1.6A3.4 3.4 0 0 0 7 18.5z"],
  storm: ["M7.5 15.5H7a3.4 3.4 0 0 1-.8-6.7 6 6 0 0 1 11.4-1.6 4 4 0 0 1-.1 8.3h-.5", "M13 12l-2.5 4.5h3L11 21"],
  dash: ["M7 12h10"],
  edit: ["M4 20h4L19 9l-4-4L4 16z", "M13.5 6.5l4 4"],
  pause: ["M9 5.5v13", "M15 5.5v13"],
  trend: ["M3 17l6-6 4 4 7-7", "M14 8h6v6"],
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
