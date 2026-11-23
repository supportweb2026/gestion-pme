# Reprise d'historique VosFactures

Écran : bouton **Importer** des listes Factures et Devis, ou **Réglages › Reprise d'historique** (administrateur ou direction).

## Marche à suivre

1. Dans VosFactures, exporter les documents en CSV (liste des documents › Exporter › CSV, avec les lignes de produits). Un fichier par année convient.
2. Dans Gestia, **Réglages › Sauvegarde des données › Exporter toutes les données** (copie avant reprise).
3. **Réglages › Reprise d'historique › Choisir les fichiers VosFactures** : plusieurs fichiers à la fois.
4. Lire l'aperçu : nombre de documents, tableau de contrôle par année (à comparer avec VosFactures), année sans document signalée, vendeurs trouvés (décocher ceux d'une autre société).
5. **Reprendre** : les données sont écrites sur l'appareil puis envoyées au serveur. Garder la page ouverte jusqu'à « Reprise terminée ».

Relancer la reprise avec les mêmes fichiers, ou avec un fichier de plus, n'ajoute que ce qui manque : l'identifiant de chaque élément est calculé à partir de son contenu (`src/shared/vosfactures.ts`).

## Ce qui est repris

| VosFactures | Gestia |
|---|---|
| Facture, facture d'acompte, facture de solde | Facture validée, numéro d'origine |
| Facture d'avoir | Avoir validé, rattaché à la facture corrigée si elle est dans les fichiers |
| Devis | Devis : envoyé, accepté, refusé, ou facturé s'il est lié à une facture |
| Bon de commande, bon de livraison, bon d'intervention | Document du même type, marqué livré ou exécuté |
| Client (nom, NIF, adresse, e-mail, téléphone) | Un client par nom ; un client déjà présent est réutilisé |
| Montant payé, date et mode de règlement | Encaissement sur la facture |
| Document annulé | Gardé pour mémoire (« Annulée »), hors chiffres |

## Règles

- **Numérotation** : le document garde son numéro d'origine et porte `imported: "vosfactures"`. Il ne consomme aucun numéro des séries de Gestia (FA, AV, DV…) ; la règle « un document validé reçoit un numéro de sa série » ne s'applique pas à lui (`isHistoryImport`, `src/shared/sync.ts`). Réservé aux rôles administrateur et direction.
- **Montants** : ceux du document d'origine, arrondis au franc. Chaque ligne porte son HT et sa TVA figés (`net`, `vat`), qui remplacent le calcul quantité × prix. Une ligne modifiée dans un brouillon (duplication, avoir) perd ses montants figés et se recalcule.
- **Retenue à la source** : VosFactures la représente par un taux de TVA négatif. Elle devient la retenue du document (`withholding_amount`), la TVA reste à zéro sur ces lignes.
- **Facture de solde** : les lignes reprennent la prestation entière ; une ligne « Acompte déjà facturé » ramène le total à celui du document d'origine.
- **Avoir** : VosFactures donne chaque ligne avant et après correction ; Gestia garde la différence, en montants positifs.
- **Devises** : seuls les documents en francs CFA sont repris ; les autres sont listés dans les points à connaître.
- **Clôture** : la reprise est refusée si la comptabilité est clôturée au-delà de la date du plus ancien document.

## Retour arrière

Les éléments repris se reconnaissent à `imported = "vosfactures"` (documents, clients, encaissements). La base D1 se restaure à un instant antérieur avec Time Travel (`wrangler d1 time-travel restore gestion-pme --timestamp=…`), voir `docs/exploitation.md`.
