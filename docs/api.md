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
