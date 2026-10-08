# Gestion PME

Logiciel de gestion pour PME (zone OHADA) : facturation, dépenses, comptabilité SYSCOHADA,
projets et tableau de bord, **utilisable sans connexion** et synchronisé entre appareils.
Hébergement entièrement dans l'offre gratuite de Cloudflare.

État : **lot 0** — prototype de synchronisation (clients, factures, tableau de bord simple).

## Architecture

```
Appareil (navigateur / appli installée)          Cloudflare (gratuit)
┌────────────────────────────────────┐           ┌──────────────────────────────┐
│ Interface React                    │           │ Worker  /api/*               │
│ Base locale IndexedDB              │  HTTPS    │  - connexion, rôles          │
│  - toutes les données utiles       │ ───────▶  │  - /api/sync (envoi+réception)│
│  - file d'envoi (outbox)           │ ◀───────  │  - blocs de n° de facture    │
│ Service worker (ouverture hors     │           │ D1 (SQLite) : journal +      │
│ ligne)                             │           │ état fusionné des lignes     │
└────────────────────────────────────┘           │ Fichiers statiques : l'appli │
                                                 └──────────────────────────────┘
```

- **Hors ligne d'abord** : l'application lit et écrit uniquement dans la base locale.
  Chaque écriture est enregistrée avec sa modification en file d'envoi, dans la même transaction.
- **Synchronisation** (`src/web/local/sync.ts`, `src/worker/index.ts`) : un seul appel
  `/api/sync` envoie la file et reçoit les modifications des autres appareils depuis un curseur.
  Renvoi après coupure sans doublon (identifiant unique par modification).
- **Conflits** (`src/shared/sync.ts`) : fusion champ par champ, la dernière écriture gagne,
  ordonnée par horloge logique hybride (`src/shared/hlc.ts`) qui tolère les horloges décalées.
  Une facture validée est figée côté serveur ; seule la partie paiement reste modifiable.
- **Numérotation des factures** : chaque appareil réserve des blocs de 50 numéros
  (ex. FA-2026-00051 à 00100) et valide hors ligne sans risque de doublon.
- **Économie de quotas** : les calculs se font sur l'appareil ; le serveur ne fait que
  stocker et redistribuer. Quota D1 du jour atteint → les appareils continuent hors ligne
  et la synchronisation reprend après minuit UTC (1 h à Libreville).

## Commandes

```bash
npm install
npm test                 # tests unitaires + API (Node 22.6+)
npm run local            # application complète en local : http://localhost:8787
node test/e2e/two-devices.mjs   # deux navigateurs, coupure réseau (Playwright requis)
```

Sans accès au registre npm, `bun dev/build-bun.ts` construit `dist/` avec Bun.

## Déploiement (gratuit)

La base D1 `gestion-pme` est déjà créée (identifiant dans `wrangler.jsonc`).

1. Cloudflare → **Workers & Pages** → **Create** → **Import a repository** → `supportweb2026/gestion-pme`.
2. Commande de build : `npm run build`
3. Commande de déploiement : `npx wrangler d1 migrations apply gestion-pme --remote && npx wrangler deploy`
4. **Settings → Variables and Secrets** : ajouter le secret `JWT_SECRET` (une longue chaîne aléatoire).
5. Chaque `git push` sur `main` redéploie automatiquement. Adresse : `https://gestion-pme.<compte>.workers.dev`.

Ouvrez l'adresse : le premier écran crée l'entreprise et le compte administrateur.

## Limites connues du lot 0 (traitées au lot 1)

- Base locale non chiffrée ; à chiffrer avec la session de l'utilisateur.
- Tous les utilisateurs d'une entreprise reçoivent toutes ses données ; le filtrage par rôle
  (le commercial ne voit que ses ventes) viendra avec les règles de partage.
- Les encaissements sont un champ cumulé de la facture : deux encaissements simultanés
  sur deux appareils hors ligne peuvent s'écraser. Ils deviendront des lignes `payments` distinctes.
- Un numéro pris par une validation refusée (facture validée ailleurs entre-temps)
  n'est pas encore tracé comme annulé dans le journal.
- PBKDF2 à 50 000 itérations pour rester sous la limite de calcul du plan gratuit.

## Structure

```
src/shared/   logique commune appareil + serveur (HLC, fusion, règles, calculs de facture)
src/worker/   API Cloudflare Worker
src/web/      application React (base locale, moteur de synchronisation, écrans)
migrations/   schéma D1
dev/          serveur local et imitation de D1 sur SQLite
test/         tests unitaires, API et bout en bout
```
