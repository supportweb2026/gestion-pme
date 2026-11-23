/** Numéros à proposer : la première, la dernière, et les voisines de la page courante. */
export function pageNumbers(page: number, pages: number): (number | "gap")[] {
  const keep = new Set([0, 1, pages - 2, pages - 1, page - 1, page, page + 1].filter((p) => p >= 0 && p < pages));
  const out: (number | "gap")[] = [];
  let last = -1;
  for (const p of [...keep].sort((a, b) => a - b)) {
    if (p - last === 2) out.push(last + 1);
    else if (p - last > 2) out.push("gap");
    out.push(p);
    last = p;
  }
  return out;
}

