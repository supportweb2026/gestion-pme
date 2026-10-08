# Gestia

Gestia : logiciel de gestion pour PME (zone OHADA) : facturation, dépenses, comptabilité SYSCOHADA,
projets et tableau de bord, **utilisable sans connexion** et synchronisé entre appareils.
Hébergement entièrement dans l'offre gratuite de Cloudflare.

Adresse : **https://gestia.ido.ga** — éditeur : IDO (Libreville).

État : **v5** — plateforme multi-entreprises (SaaS) :

- inscription libre « Créer mon entreprise » : 30 jours d'essai, données de chaque entreprise
  isolées par le serveur (aucune requête ne lit hors de l'entreprise du jeton) ;
- formules Essentiel (3 utilisateurs), Pro (15), Entreprise (illimité) ; quota d'utilisateurs appliqué ;
- échéance dépassée : 7 jours de grâce, puis **consultation seule** (les saisies restent sur
  l'appareil et partent au renouvellement) ; suspension possible par l'éditeur ;
- console **Plateforme** (administrateurs de l'entreprise éditrice, `PLATFORM_COMPANY` dans
  `wrangler.jsonc`) : entreprises, échéances, paiements reçus (virement, mobile money…),
  prolongation d'essai, suspension, mot de passe provisoire, erreurs remontées par les appareils ;
- comptes : changement de mot de passe, mot de passe provisoire imposé à la première connexion,
  réinitialisation par l'administrateur, blocage 15 min après 8 échecs, 5 inscriptions par jour et par IP ;
- export complet des données (JSON) par la direction ; stockage persistant demandé sur téléphone,
  bouton « Installer », coordonnées du support affichées (celles des réglages de l'éditeur).

Lot 4 — finition et sécurité :

- chaque appareil ne reçoit que les données de son rôle (filtrage par le serveur) ;
  si le rôle change, la copie locale est rechargée ;
- code PIN facultatif : copie locale chiffrée (AES-GCM, clé protégée par le PIN),
  verrouillage après inactivité, déverrouillage hors ligne, « code oublié » = effacement local ;
- justificatifs de dépenses (photo compressée ou PDF) : pris hors ligne, envoyés ensuite,
  stockés dans une seconde base D1 gratuite (`gestion-pme-fichiers`), consultables partout ;
- import CSV des clients et articles (export Excel), modèles téléchargeables, doublons ignorés.

Lot 3 — projets et multi-devises :

- projets liés aux clients : budget, taux de facturation et coût horaire interne ;
- tâches en Kanban (glisser-déposer ou flèches sur mobile), planning de type Gantt ;
- temps passés par personne et par tâche, facturation du temps non facturé ou d'un jalon ;
- rentabilité en direct : heures, coûts (temps + dépenses), facturé, marge, budget consommé ;
- devis, factures et avoirs en EUR, USD, XOF, CNY, GBP : taux mémorisé sur le document,
  parité fixe de l'euro (655,957), contre-valeur en FCFA, montant en lettres dans la devise ;
- comptabilité toujours en FCFA, avec écarts de change à l'encaissement (676 / 776) ;
- taux de change modifiables dans les réglages, ou récupérés en ligne en un clic.

Lot 2 — comptabilité SYSCOHADA :

- écritures générées automatiquement depuis factures, avoirs, encaissements et dépenses
  (journaux VE, CA, BQ, MM), plus écritures diverses (OD) saisies et contrôlées ;
- journal, grand livre, balance générale et balance clients, compte de résultat avec soldes
  intermédiaires (marge, valeur ajoutée, EBE), bilan ;
- déclaration de TVA (collectée, déductible, nette ou crédit, bases par taux) ;
- clôture des périodes, appliquée par le serveur ;
- export CSV des écritures (colonnes de type FEC) et de la balance pour le cabinet ;
- droits par rôle vérifiés par le serveur (écritures, réglages, validation des dépenses).

Lot 1 — ventes complètes hors ligne :

- devis → facture, avoirs, encaissements multiples (espèces, virement, chèque, Airtel / Moov Money, carte) ;
- catalogue d'articles et services, clients avec solde dû ;
- impression A4 / PDF avec logo, mentions légales, TVA ventilée et montant en lettres ;
- envoi par WhatsApp et e-mail ;
- dépenses par catégorie (comptes SYSCOHADA), validation par la direction ;
- tableau de bord : CA, encaissements, impayés, retards, graphique sur 12 mois, meilleurs clients ;
- utilisateurs et rôles gérés depuis l'application, désactivation avec effacement des appareils.

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
4. **Settings → Variables and Secrets** : ajouter le secret `JWT_SECRET` (chaîne aléatoire d'au moins 32 caractères, obligatoire : sans lui, le serveur refuse les connexions).
5. Chaque `git push` sur `main` redéploie automatiquement. Adresse : `https://gestion-pme.<compte>.workers.dev`.

Ouvrez l'adresse : « Créer mon entreprise » ouvre un espace en essai de 30 jours.
Les entreprises existantes avant la v5 passent en formule Pro jusqu'au 31/12/2027 (migration `0002`).
Les abonnements sont encaissés hors ligne (virement, mobile money) puis enregistrés dans la console Plateforme.

## Limites connues

- Justificatifs : 1,4 Mo maximum par fichier ; la base de fichiers gratuite fait 500 Mo
  (environ 2 000 à 3 000 photos). Au-delà : ouvrir une autre base, ou activer R2 (10 Go gratuits,
  carte bancaire demandée par Cloudflare à l'activation).

- TVA calculée au régime des débits ; régime, taxes annexes et formulaire officiel à
  faire valider par le comptable. Pas encore d'amortissements ni de paie automatisés.
- Un changement de rôle prend effet à la synchronisation suivante de la personne.
- Pas d'envoi d'e-mail (offre gratuite) : un mot de passe oublié passe par l'administrateur
  de l'entreprise, ou par l'équipe Gestia pour un administrateur.
- Paiement des abonnements non automatisé (pas de passerelle de paiement en ligne).
- Offre gratuite Cloudflare : 5 millions de lectures et 100 000 écritures D1 par jour, 5 Go
  au total, pour toutes les entreprises réunies ; à surveiller dans le tableau de bord Cloudflare
  quand le nombre de clients grandit (passage au plan payant à 5 $/mois si besoin).
- Un numéro pris par une validation refusée (document validé ailleurs entre-temps)
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
