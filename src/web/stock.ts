/** Niveaux de stock calculés sur l'appareil (saisies + ventes). */
import { useMemo } from "react";
import { useTable } from "./context.ts";
import { manualMoves, salesMoves, stockLevels, type StockLevel, type StockMove } from "../shared/stock.ts";

export function useStock(): { levels: Map<string, StockLevel>; moves: StockMove[] } {
  const articles = useTable("articles");
  const invoices = useTable("invoices");
  const quotes = useTable("quotes");
  const entries = useTable("stock_moves");
  return useMemo(() => {
    const moves = [...manualMoves(entries), ...salesMoves(invoices, quotes)]
      .sort((a, b) => b.date.localeCompare(a.date) || (b.at ?? "").localeCompare(a.at ?? ""));
    return { levels: stockLevels(articles, moves), moves };
  }, [articles, invoices, quotes, entries]);
}
