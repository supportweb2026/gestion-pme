import test from "node:test";
import assert from "node:assert/strict";
import { reminderDue, reminderSettings, stepLabel } from "../src/shared/reminders.ts";

const settings = reminderSettings({});
const due = (today: string, sent = 0, lastSent?: string, amountDue = 100_000) =>
  reminderDue({ dueDate: "2026-11-20", amountDue, sent, lastSent, today, settings });

test("relances : calendrier par défaut J-3, J+1, J+7, J+15, J+30", () => {
  assert.deepEqual(settings.steps, [-3, 1, 7, 15, 30]);
  assert.equal(stepLabel(-3), "J-3");
  assert.deepEqual(reminderSettings({ reminder_steps: [10, 2, 2, "x"] }).steps, [2, 10]);
  assert.equal(reminderSettings({ reminders_enabled: false }).enabled, false);
});

test("relances : étape due selon la date et le nombre de relances envoyées", () => {
  assert.equal(due("2026-11-16"), null, "trop tôt");
  assert.deepEqual(due("2026-11-17"), { index: 0, offset: -3, label: "J-3", tone: "courtesy", days: -3 });
  assert.equal(due("2026-11-20", 1), null, "rappel J-3 envoyé, J+1 pas encore atteint");
  assert.equal(due("2026-11-21", 1)?.tone, "friendly");
  assert.equal(due("2026-11-27", 2)?.label, "J+7");
  assert.equal(due("2026-11-27", 2)?.tone, "firm");
  assert.equal(due("2026-12-20", 4)?.tone, "final");
  assert.equal(due("2027-01-20", 5), null, "calendrier épuisé");
});

test("relances : une facture très en retard saute aux étapes récentes", () => {
  assert.equal(due("2026-12-08", 0)?.label, "J+15");
  assert.equal(due("2026-12-08", 0)?.tone, "friendly", "jamais relancée : ton cordial d'abord");
});

test("relances : rien si soldée, désactivé ou déjà relancée aujourd'hui", () => {
  assert.equal(due("2026-11-21", 1, undefined, 0), null);
  assert.equal(due("2026-11-21", 1, "2026-11-21"), null);
  assert.equal(reminderDue({ dueDate: "2026-11-20", amountDue: 1, sent: 1, today: "2026-11-21", settings: { enabled: false, steps: [1] } }), null);
});
