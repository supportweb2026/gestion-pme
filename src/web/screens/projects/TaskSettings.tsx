/**
 * Projets, lot 5 : réglages du module, catégories de tâche.
 *
 * Liste propre à l'entreprise, modifiable par la direction : renommer, retirer, remettre,
 * changer l'ordre, ajouter. Par défaut : Client, Infra, Sécurité, Coûts, Interne. Une catégorie
 * est toujours écrite en toutes lettres sur les cartes. Retirer une catégorie ne touche pas
 * aux tâches déjà classées : elles gardent son nom.
 */
import { useState, type FormEvent } from "react";
import { can, useApp, useTable } from "../../context.ts";
import { categoryIdFor } from "../../../shared/projectBoard.ts";
import { useGuardedWrite } from "../team.ts";
import { PIcon } from "../ProjectIcons.tsx";
import { useCategories } from "./TaskForms.tsx";

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

export function TaskSettings() {
  const { session } = useApp();
  const categories = useCategories();
  const tasks = useTable("tasks");
  const write = useGuardedWrite();
  const editable = can.manageTeam(session.user.role);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const used = (id: string) => tasks.filter((t) => !t.data._deleted && t.data.category_id === id).length;
  const active = categories.filter((c) => c.active);
  const removed = categories.filter((c) => !c.active);

  async function run(fn: () => Promise<void>, ok: string, ko: string) {
    setError(null);
    try {
      await fn();
      setFlash(ok);
    } catch (e) {
      setError(e instanceof Error ? e.message : ko);
    }
  }
  function add(e: FormEvent) {
    e.preventDefault();
    const value = name.trim();
    if (!value) return;
    if (categories.some((c) => c.active && c.name.toLocaleLowerCase("fr") === value.toLocaleLowerCase("fr"))) return setError(`La catégorie « ${value} » existe déjà.`);
    const back = categories.find((c) => !c.active && c.name.toLocaleLowerCase("fr") === value.toLocaleLowerCase("fr"));
    const id = back?.id ?? categoryIdFor(value, categories.map((c) => c.id));
    const rank = Math.max(0, ...categories.map((c) => c.rank)) + 10;
    setName("");
    return run(() => write("task_categories", id, { name: value, rank, _deleted: false }), `Catégorie « ${value} » ajoutée.`, "La catégorie n'a pas pu être ajoutée.");
  }
  function rename(e: FormEvent) {
    e.preventDefault();
    if (!renaming) return;
    const value = renaming.name.trim();
    if (!value) return setError("Donnez un nom à la catégorie.");
    const c = categories.find((x) => x.id === renaming.id);
    setRenaming(null);
    if (!c || c.name === value) return;
    return run(() => write("task_categories", c.id, { name: value, rank: c.rank }), `Catégorie renommée en « ${value} ».`, "La catégorie n'a pas pu être renommée.");
  }
  function remove(id: string) {
    const c = categories.find((x) => x.id === id)!;
    const n = used(id);
    if (!confirm(`Retirer la catégorie « ${c.name} » ? ${n ? `${plural(n, "tâche la garde", "tâches la gardent")}, mais elle ne sera plus proposée.` : "Elle ne sera plus proposée."}`)) return;
    return run(() => write("task_categories", id, { name: c.name, rank: c.rank, _deleted: true }), `Catégorie « ${c.name} » retirée.`, "La catégorie n'a pas pu être retirée.");
  }
  function restore(id: string) {
    const c = categories.find((x) => x.id === id)!;
    return run(() => write("task_categories", id, { name: c.name, rank: c.rank, _deleted: false }), `Catégorie « ${c.name} » remise dans la liste.`, "La catégorie n'a pas pu être remise.");
  }
  function shift(i: number, by: -1 | 1) {
    const a = active[i];
    const b = active[i + by];
    if (!a || !b) return;
    return run(async () => {
      await write("task_categories", a.id, { name: a.name, rank: b.rank });
      await write("task_categories", b.id, { name: b.name, rank: a.rank });
    }, "Ordre des catégories enregistré.", "L'ordre n'a pas pu être enregistré.");
  }

  return (
    <div className="card section-card task-settings" data-testid="task-settings">
      <div className="card-head">
        <div>
          <h3>Catégories de tâche</h3>
          <p className="muted small">Elles classent les tâches sur le tableau de toutes les tâches, comme des étiquettes. Le nom est toujours écrit en toutes lettres sur la carte.</p>
        </div>
      </div>
      <ul className="cat-list">
        {active.map((c, i) => (
          <li key={c.id} className="cat-row">
            {renaming?.id === c.id ? (
              <form className="cat-rename" onSubmit={rename}>
                <input value={renaming.name} maxLength={40} onChange={(e) => setRenaming({ id: c.id, name: e.target.value })} aria-label={`Nouveau nom de la catégorie ${c.name}`} autoFocus />
                <button type="button" className="ghost small" onClick={() => setRenaming(null)}>Annuler</button>
                <button className="primary small">Enregistrer</button>
              </form>
            ) : (
              <>
                <span className="tag cat-tag">{c.name}</span>
                <span className="muted small grow">{used(c.id) ? plural(used(c.id), "tâche", "tâches") : "aucune tâche"}</span>
                {editable && (
                  <span className="cat-tools">
                    <button className="ghost small icon" onClick={() => shift(i, -1)} disabled={i === 0} aria-label={`Monter ${c.name}`} title="Monter"><PIcon name="arrowUp" /></button>
                    <button className="ghost small icon" onClick={() => shift(i, 1)} disabled={i === active.length - 1} aria-label={`Descendre ${c.name}`} title="Descendre"><PIcon name="arrowDown" /></button>
                    <button className="ghost small" onClick={() => setRenaming({ id: c.id, name: c.name })}>Renommer</button>
                    <button className="ghost small" onClick={() => remove(c.id)}>Retirer</button>
                  </span>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      {editable ? (
        <form className="cat-add" onSubmit={add}>
          <input value={name} maxLength={40} placeholder="Nom de la nouvelle catégorie" onChange={(e) => setName(e.target.value)} aria-label="Nouvelle catégorie" />
          <button className="primary" disabled={!name.trim()}>Ajouter la catégorie</button>
        </form>
      ) : null}
      {removed.length > 0 && (
        <details className="cat-removed">
          <summary className="small">{plural(removed.length, "catégorie retirée", "catégories retirées")}</summary>
          <ul className="cat-list">
            {removed.map((c) => (
              <li key={c.id} className="cat-row">
                <span className="muted">{c.name}</span>
                <span className="muted small grow">{used(c.id) ? plural(used(c.id), "tâche la garde", "tâches la gardent") : ""}</span>
                {editable && <button className="ghost small" onClick={() => restore(c.id)}>Remettre</button>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {flash && <p className="notice success-note" role="status">{flash}<button className="link small" onClick={() => setFlash(null)}>Fermer</button></p>}
      <p className="muted small">Les catégories sont propres à votre entreprise et se synchronisent sur tous les appareils, hors ligne compris.</p>
    </div>
  );
}
