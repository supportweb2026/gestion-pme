/**
 * Sur un devis accepté (ou déjà facturé) : « Lancer le projet », ou « Ouvrir le projet »
 * s'il en a déjà lancé un (CA2.2). Inséré en une ligne dans l'éditeur de devis,
 * pour ne pas mêler le module Projets au cycle de vente.
 */
import { can, TABS_BY_ROLE, text, useApp, useTable } from "../../context.ts";
import { projectOfQuote } from "../../../shared/projectControl.ts";
import { quoteTypeOf } from "../../../shared/documents.ts";
import type { SyncRecord } from "../../../shared/sync.ts";
import { PIcon } from "../ProjectIcons.tsx";

/** Préfixe passé à l'écran Projets pour ouvrir « Nouveau projet » sur un devis. */
export const NEW_FROM_QUOTE = "nouveau-depuis:";

export function QuoteProjectBanner({ quote }: { quote: SyncRecord }) {
  const { session, go } = useApp();
  const projects = useTable("projects");
  const role = session.user.role;
  if (quoteTypeOf(quote.data) !== "quote" || !["accepted", "invoiced"].includes(text(quote.data.status))) return null;
  if (!can.manageProjects(role) || !(TABS_BY_ROLE[role] ?? []).includes("projects")) return null;
  const project = projectOfQuote(quote, projects);
  if (project) {
    return (
      <div className="quote-project" data-testid="quote-project">
        <PIcon name="folder" />
        <p><strong>Projet lancé : {text(project.data.name)}</strong><span className="muted small">Les étapes et l'avancement se suivent dans le projet.</span></p>
        <button onClick={() => go("projects", project.id)}>Ouvrir le projet</button>
      </div>
    );
  }
  return (
    <div className="quote-project" data-testid="quote-project">
      <PIcon name="diamond" />
      <p><strong>Devis {quote.data.status === "invoiced" ? "facturé" : "accepté"} : lancez le projet</strong><span className="muted small">Le client, le montant vendu et les étapes sont repris du devis. Rien à ressaisir.</span></p>
      <button className="primary" onClick={() => go("projects", `${NEW_FROM_QUOTE}${quote.id}`)}>Lancer le projet</button>
    </div>
  );
}
