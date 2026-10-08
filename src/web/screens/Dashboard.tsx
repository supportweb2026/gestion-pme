import { useTable, useSyncStatus } from "../context.ts";
import { computeTotals, formatXaf, type InvoiceLine } from "../../shared/invoice.ts";

/** Indicateurs calculés sur l'appareil, donc disponibles hors ligne. */
export function Dashboard() {
  const invoices = useTable("invoices");
  const clients = useTable("clients");
  const sync = useSyncStatus();

  const month = new Date().toISOString().slice(0, 7);
  let revenueMonth = 0;
  let collected = 0;
  let outstanding = 0;
  let drafts = 0;
  for (const inv of invoices) {
    const gross = computeTotals((inv.data.lines as InvoiceLine[]) ?? []).gross;
    if (inv.data.status !== "validated") {
      drafts++;
      continue;
    }
    const paid = Number(inv.data.paid_amount ?? 0);
    if (String(inv.data.date ?? "").startsWith(month)) revenueMonth += gross;
    collected += paid;
    outstanding += Math.max(0, gross - paid);
  }

  const kpis = [
    { label: "Chiffre d'affaires du mois (TTC)", value: formatXaf(revenueMonth) },
    { label: "Encaissé", value: formatXaf(collected) },
    { label: "Reste à encaisser", value: formatXaf(outstanding) },
    { label: "Brouillons", value: String(drafts) },
    { label: "Clients", value: String(clients.length) },
  ];

  return (
    <section>
      <div className="section-head">
        <h2>Tableau de bord</h2>
        <span className="muted small">
          {sync.lastSync ? `Dernière synchronisation : ${new Date(sync.lastSync).toLocaleTimeString("fr-FR")}` : "Pas encore synchronisé"}
        </span>
      </div>
      <div className="kpis">
        {kpis.map((k) => (
          <div className="card kpi" key={k.label}>
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value mono">{k.value}</div>
          </div>
        ))}
      </div>
      <p className="muted small">
        Prototype du lot 0 : factures, clients et synchronisation hors ligne. Dépenses, comptabilité SYSCOHADA,
        projets et multi-devises arrivent aux lots suivants.
      </p>
    </section>
  );
}
