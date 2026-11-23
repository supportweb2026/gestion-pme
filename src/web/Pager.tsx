/**
 * Affichage par pages des longues listes : l'écran reste rapide même avec des
 * milliers de lignes. On va à la première, à la dernière ou à n'importe quelle
 * page d'un clic, et on choisit 50, 100 ou 200 lignes par page.
 */
import { useState, type ReactNode } from "react";
import { pageNumbers } from "../shared/paging.ts";

export const PAGE_SIZES = [50, 100, 200];
const KEY = "gestia:lignes-par-page";
const fr = (n: number) => n.toLocaleString("fr-FR");

/** Nombre de lignes par page choisi sur cet appareil. */
export function readPageSize(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return PAGE_SIZES.includes(n) ? n : PAGE_SIZES[0];
  } catch {
    return PAGE_SIZES[0];
  }
}
function writePageSize(n: number) {
  try { localStorage.setItem(KEY, String(n)); } catch { /* stockage indisponible */ }
}

export function Pager({ page, total, size, onPage, onSize }: {
  page: number; total: number; size: number; onPage: (p: number) => void; onSize: (n: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  const [jump, setJump] = useState("");
  if (total <= PAGE_SIZES[0]) return null;
  const turn = (p: number) => { onPage(Math.min(pages - 1, Math.max(0, p))); window.scrollTo(0, 0); };
  return (
    <nav className="pager" aria-label="Pages">
      <span className="muted small" data-testid="pager-range">{fr(page * size + 1)} à {fr(Math.min(total, (page + 1) * size))} sur {fr(total)}</span>
      <label className="pager-size muted small">
        Par page
        <select value={size} aria-label="Lignes par page" onChange={(e) => { const n = Number(e.target.value); writePageSize(n); onSize(n); }}>
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      {pages > 1 && (
        <>
          <div className="pager-pages">
            <button className="small" disabled={page === 0} onClick={() => turn(page - 1)} aria-label="Page précédente" title="Page précédente">‹</button>
            {pageNumbers(page, pages).map((p, i) => p === "gap"
              ? <span key={`g${i}`} className="muted" aria-hidden="true">…</span>
              : <button key={p} className={`small${p === page ? " current" : ""}`} aria-current={p === page ? "page" : undefined} aria-label={`Page ${p + 1}`} onClick={() => turn(p)}>{fr(p + 1)}</button>)}
            <button className="small" disabled={page >= pages - 1} onClick={() => turn(page + 1)} aria-label="Page suivante" title="Page suivante">›</button>
          </div>
          {pages > 7 && (
            <form className="pager-jump" onSubmit={(e) => { e.preventDefault(); const n = Math.round(Number(jump)); if (n >= 1) turn(n - 1); setJump(""); }}>
              <label className="muted small">
                Aller à la page
                <input type="number" min={1} max={pages} inputMode="numeric" value={jump} onChange={(e) => setJump(e.target.value)} placeholder={`1 à ${pages}`} aria-label="Aller à la page" />
              </label>
              <button className="small" disabled={jump === ""}>Aller</button>
            </form>
          )}
        </>
      )}
    </nav>
  );
}

/** Découpe une liste en pages ; revient à la première page quand `resetKey` (recherche, filtres) change. */
export function usePaged<T>(rows: T[], resetKey: string): { shown: T[]; pager: ReactNode } {
  const [state, setState] = useState({ page: 0, key: resetKey });
  const [size, setSize] = useState(readPageSize);
  const wanted = state.key === resetKey ? state.page : 0;
  const page = Math.min(wanted, Math.max(0, Math.ceil(rows.length / size) - 1));
  return {
    shown: rows.slice(page * size, (page + 1) * size),
    pager: <Pager page={page} total={rows.length} size={size} onPage={(p) => setState({ page: p, key: resetKey })} onSize={(n) => { setSize(n); setState({ page: 0, key: resetKey }); }} />,
  };
}
