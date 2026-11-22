# API Gestia (v1)

Jetons créés dans **Réglages › Accès par API** (administrateurs). Chaque jeton est limité aux tables choisies, en lecture ou en lecture et écriture. Le jeton n'est affiché qu'une fois ; le serveur n'en garde que l'empreinte. Les écritures se font avec les droits de l'administrateur qui l'a créé (et s'arrêtent s'il est désactivé ou change de rôle). `cost_rates`, `project_finance` et `settings` ne sont jamais accessibles.

En-tête : `Authorization: Bearer gst_…`

| Appel | Effet |
|---|---|
| `GET /api/v1/{table}?since={curseur}` | Liste (500 au plus, `more: true` s'il en reste). Réponse `{ items, cursor, more }` ; repasser `cursor` en `since` pour n'avoir que les changements. `?deleted=1` inclut les suppressions (`_deleted: true`). |
| `GET /api/v1/{table}/{id}` | Un élément, ou 404. |
| `PATCH /api/v1/{table}/{id}` | Fusionne les champs envoyés (objet JSON). Crée l'élément si l'identifiant est nouveau (201), en notant `created_by_name = "API : {nom du jeton}"`. |
| `DELETE /api/v1/{table}/{id}` | Suppression logique. |

Les écritures passent par les mêmes règles que les appareils (droits, clôture comptable, règles des projets) : un refus renvoie 422 avec la raison. Elles sont redistribuées aux appareils à la synchronisation suivante.

Codes : 401 jeton absent, inconnu ou révoqué ; 403 table hors portée ou abonnement en consultation seule ; 400 corps invalide.

Exemple :

```sh
curl -X PATCH https://gestia.ido.ga/api/v1/tasks/tsk-0001 \
  -H "Authorization: Bearer $GESTIA_TOKEN" -H "content-type: application/json" \
  -d '{"project_id":"prj-0001","title":"Importer les cartes","status":"todo"}'
```

## Connecteur MCP (Claude)

Adresse : `https://gestia.ido.ga/mcp` (MCP « Streamable HTTP », sans état, réponses JSON ; `GET` → 405). Ajout dans claude.ai : Réglages › Connecteurs › Ajouter un connecteur personnalisé, avec cette adresse.

- OAuth 2.1 : `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, enregistrement dynamique `POST /oauth/register`, `GET /oauth/authorize` (PKCE S256 obligatoire, connexion Gestia avec double authentification, puis consentement), `POST /oauth/token` (`authorization_code`, `refresh_token` à rotation), `POST /oauth/revoke`.
- Jeton d'accès 1 h, de rafraîchissement 30 jours ; codes et jetons stockés en empreinte SHA-256 (migration `0005_connecteur_mcp`). Un code ou un jeton de rafraîchissement rejoué coupe la connexion.
- Le jeton agit au nom de l'utilisateur, avec son rôle lu à chaque appel ; chaque connexion a son pseudo-appareil `mcp-…` et écrit par `applyIncoming`. Aucune table de montants n'est lue.
- Portée (`MCP_SCOPES`, `src/worker/mcp.ts`) : `projects`, `project_stages`, `project_members`, `project_decisions`, `team_members`, `clients`, `task_categories`, `attachments`, `task_events` en lecture ; `tasks`, `time_entries`, `task_comments` en écriture. L'historique (`task_events`) n'est pas écrit par les outils : le serveur l'ajoute lui-même quand le connecteur modifie une tâche.
- Outils en lecture (`readOnlyHint: true`) : `list_projects`, `get_project`, `list_tasks` (filtres personne, projet, statut, bloquée, en retard, échéance, `category`, `include_archived` ; chaque tâche donne `category` et `comments`, le nombre de commentaires), `get_task` (fiche : tâche, catégorie, commentaires, historique, pièces jointes et liens avec leur nom et leur adresse ; un fichier se consulte dans Gestia), `list_categories`, `list_people`, `my_day`.
- Outils en écriture (`readOnlyHint: false`, `destructiveHint: false`) : `create_task` et `update_task` (catégorie par nom ou identifiant `cat-…` ; `archived` dans `update_task`, seulement pour une tâche terminée), `add_comment` (au nom de l'utilisateur connecté ; modifiable 15 minutes dans Gestia puis figé, jamais modifié ni supprimé par le connecteur), `log_time`. Pas de suppression.
- Réglages › Connexions (`GET /api/connections`, `POST /api/connections/revoke`) : chacun ses connexions, l'administrateur toutes celles de l'entreprise.
