/**
 * Module Projets, lot 2 : modèles de projet fournis (CDC §3.2, F2).
 *
 * Un modèle propose un mode de facturation, des étapes avec leur part du montant
 * vendu et des tâches types (dont les livrables « à remettre au client »).
 * Les modèles fournis sont des constantes : les modèles d'entreprise arriveront
 * au lot 6 (table `project_templates`). Le modèle d'un projet ne change plus
 * après sa création (RG2.4).
 */

export type TemplateId = "forfait" | "regie" | "conseil" | "creation" | "interne" | "blank";
export type StageKind = "start" | "normal" | "reserves";

export interface TemplateTask { title: string; deliverable?: boolean }
export interface TemplateStage {
  name: string;
  kind: StageKind;
  /** Part du montant vendu, en % (0 = l'étape ne facture pas). */
  billing_pct: number;
  /** Poids de la durée pour répartir les dates entre le début et la fin du projet. */
  span: number;
  tasks: TemplateTask[];
}
export interface TemplateDef {
  id: TemplateId;
  label: string;
  /** Une phrase, sous le nom du modèle. */
  hint: string;
  /** Mode de facturation proposé : par étapes, au temps passé, ou aucune. */
  billing: "stages" | "time" | "none";
  stages: TemplateStage[];
}

const start = (pct: number, tasks: TemplateTask[] = [{ title: "Signature et lancement avec le client" }]): TemplateStage =>
  ({ name: "Démarrage", kind: "start", billing_pct: pct, span: 0, tasks });

export const PROJECT_TEMPLATES: Record<TemplateId, TemplateDef> = {
  forfait: {
    id: "forfait",
    label: "Prestation au forfait",
    hint: "Facturé par étapes validées.",
    billing: "stages",
    stages: [
      start(30),
      { name: "Réalisation", kind: "normal", billing_pct: 50, span: 5, tasks: [{ title: "Préparation et commandes" }, { title: "Exécution des travaux" }] },
      {
        name: "Réception", kind: "normal", billing_pct: 20, span: 1, tasks: [
          { title: "Visite de réception avec le client" },
          { title: "Levée des réserves" },
          { title: "PV de réception signé", deliverable: true },
        ],
      },
    ],
  },
  regie: {
    id: "regie",
    label: "Régie, au temps passé",
    hint: "Le temps saisi est facturé chaque mois.",
    billing: "time",
    stages: [],
  },
  conseil: {
    id: "conseil",
    label: "Mission de conseil",
    hint: "Diagnostic, recommandations, restitution.",
    billing: "stages",
    stages: [
      start(30, [{ title: "Réunion de lancement" }]),
      { name: "Diagnostic", kind: "normal", billing_pct: 30, span: 2, tasks: [{ title: "Entretiens et collecte des données" }, { title: "Rapport de diagnostic", deliverable: true }] },
      { name: "Recommandations", kind: "normal", billing_pct: 30, span: 2, tasks: [{ title: "Plan d'action recommandé", deliverable: true }] },
      { name: "Restitution", kind: "normal", billing_pct: 10, span: 1, tasks: [{ title: "Présentation à la direction", deliverable: true }] },
    ],
  },
  creation: {
    id: "creation",
    label: "Création et communication",
    hint: "Avec une étape de validation par le client.",
    billing: "stages",
    stages: [
      start(50, [{ title: "Brief et réunion de lancement" }]),
      { name: "Création", kind: "normal", billing_pct: 0, span: 3, tasks: [{ title: "Pistes créatives", deliverable: true }] },
      { name: "Validation client", kind: "normal", billing_pct: 0, span: 1, tasks: [{ title: "Retours et corrections" }] },
      { name: "Livraison", kind: "normal", billing_pct: 50, span: 1, tasks: [{ title: "Fichiers définitifs livrés", deliverable: true }] },
    ],
  },
  interne: {
    id: "interne",
    label: "Projet interne",
    hint: "Sans facturation : on suit seulement le travail et les coûts.",
    billing: "none",
    stages: [],
  },
  blank: {
    id: "blank",
    label: "Projet vide",
    hint: "Un nom, des tâches, c'est tout.",
    billing: "time",
    stages: [],
  },
};

export const TEMPLATE_ORDER: TemplateId[] = ["forfait", "regie", "interne", "conseil", "creation", "blank"];

export const templateOf = (id: unknown): TemplateDef => PROJECT_TEMPLATES[(typeof id === "string" && id in PROJECT_TEMPLATES ? id : "blank") as TemplateId];

/**
 * Modèle proposé pour un devis : uniquement des heures ou des journées de service
 * → régie ; sinon (produits, forfaits, mélange) → prestation au forfait.
 */
export function suggestTemplate(lines: { unit?: string; articleId?: string; section?: boolean; deposit?: boolean; depositInvoiceId?: string }[], articles: { id: string; data: Record<string, unknown> }[] = []): TemplateId {
  const billable = lines.filter((l) => !l.section && !l.deposit && !l.depositInvoiceId);
  if (billable.length === 0) return "forfait";
  const timeUnit = (u: unknown) => /^(h|heure|heures|jour|jours|j)$/i.test(String(u ?? "").trim());
  const allTime = billable.every((l) => {
    const art = l.articleId ? articles.find((a) => a.id === l.articleId) : undefined;
    return timeUnit(l.unit) && (!art || art.data.kind !== "product");
  });
  return allTime ? "regie" : "forfait";
}
