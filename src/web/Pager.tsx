/**
 * Affichage par pages des longues listes : 50 lignes à la fois, pour que
 * l'écran reste rapide même avec des milliers de lignes.
 */
import { useState, type ReactNode } from "react";

export const PAGE_SIZE = 50;
const fr = (n: number) => n.toLocaleString("fr-FR");

export function Pager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) return null;
  const turn = (p: number) => { onPage(p); window.scrollTo(0, 0); };
  return (
    <nav className="pager" aria-label="Pages">
      <span className="muted small" data-testid="pager-range">{fr(page * PAGE_SIZE + 1)} à {fr(Math.min(total, (page + 1) * PAGE_SIZE))} sur {fr(total)}</span>
      <button className="small" disabled={page === 0} onClick={() => turn(page - 1)}>Précédents</button>
      <button className="small" disabled={page >= pages - 1} onClick={() => turn(page + 1)}>Suivants</button>
    </nav>
  );
}

/** Découpe une liste en pages ; revient à la première page quand `resetKey` (recherche, filtres) change. */
export function usePaged<T>(rows: T[], resetKey: string): { shown: T[]; pager: ReactNode } {
  const [state, setState] = useState({ page: 0, key: resetKey });
  const wanted = state.key === resetKey ? state.page : 0;
  const page = Math.min(wanted, Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1));
  return {
    shown: rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    pager: <Pager page={page} total={rows.length} onPage={(p) => setState({ page: p, key: resetKey })} />,
  };
}
