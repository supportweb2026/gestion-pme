import test from "node:test";
import assert from "node:assert/strict";
import { manualMoves, salesMoves, stockLevels, weightedCost } from "../src/shared/stock.ts";

const article = { id: "art-1", data: { kind: "product", track_stock: true, cost: 1000, stock_alert: 5 } };
const service = { id: "art-2", data: { kind: "service", track_stock: true } };
const line = (qty: number, extra = {}) => ({ articleId: "art-1", qty, unitPrice: 2000, vatRate: 18, label: "Ciment", ...extra });

test("stock : la facture fait sortir le stock, pas le brouillon ni l'acompte", () => {
  const invoices = [
    { id: "fa-1", data: { status: "validated", number: "FA-1", date: "2026-11-02", lines: [line(3), { label: "Titre", qty: 0, unitPrice: 0, vatRate: 0, section: true }] } },
    { id: "fa-2", data: { status: "draft", date: "2026-11-03", lines: [line(50)] } },
    { id: "fa-3", data: { status: "validated", deposit: true, number: "FA-3", date: "2026-11-03", lines: [line(1, { deposit: true })] } },
  ];
  const moves = salesMoves(invoices, []);
  assert.deepEqual(moves.map((m) => [m.qty, m.label]), [[-3, "Facture FA-1"]]);
});

test("stock : un bon de livraison couvre la facture (même devis ou établi d'après elle)", () => {
  const quotes = [
    { id: "bl-1", data: { doc_type: "delivery", number: "BL-1", date: "2026-11-04", source_id: "dv-1", lines: [line(4)] } },
    { id: "bl-2", data: { doc_type: "delivery", number: "BL-2", date: "2026-11-05", source_id: "fa-2", lines: [line(2)] } },
    { id: "bl-3", data: { doc_type: "delivery", date: "2026-11-05", lines: [line(9)] } },
  ];
  const invoices = [
    { id: "fa-1", data: { status: "validated", number: "FA-1", quote_id: "dv-1", date: "2026-11-06", lines: [line(4)] } },
    { id: "fa-2", data: { status: "validated", number: "FA-2", date: "2026-11-05", lines: [line(2)] } },
  ];
  const moves = salesMoves(invoices, quotes);
  assert.deepEqual(moves.map((m) => m.label).sort(), ["Livraison BL-1", "Livraison BL-2"], "bon non finalisé ignoré, factures couvertes");
  assert.equal(moves.reduce((n, m) => n + m.qty, 0), -6);
});

test("stock : niveaux, alerte, valeur et coût moyen pondéré", () => {
  const entries = [
    { id: "s1", data: { article_id: "art-1", kind: "initial", qty: 10, date: "2026-11-01" } },
    { id: "s2", data: { article_id: "art-1", kind: "loss", qty: -1, date: "2026-11-02" } },
  ];
  const sale = salesMoves([{ id: "fa-1", data: { status: "validated", number: "FA-1", date: "2026-11-02", lines: [line(4)] } }], []);
  const levels = stockLevels([article, service], [...manualMoves(entries), ...sale]);
  assert.equal(levels.has("art-2"), false, "un service n'a pas de stock");
  assert.deepEqual(levels.get("art-1"), { qty: 5, unitCost: 1000, value: 5000, alert: 5, low: true });
  assert.equal(weightedCost(5, 1000, 5, 2000), 1500);
  assert.equal(weightedCost(0, 1000, 5, 2000), 2000, "stock vide : le nouveau coût s'applique");
  assert.equal(weightedCost(-2, null, 5, 1200), 1200);
});

test("stock : mouvements synchronisés, saisis par la vente mais pas par un employé", async () => {
  const { checkChange, checkPermission } = await import("../src/shared/sync.ts");
  const change = { id: "c1", tbl: "stock_moves" as const, row: "stk-1", patch: { article_id: "art-1", kind: "purchase", qty: 5, date: "2026-11-22" }, hlc: "000001700000000-00000-dev", device: "dev" };
  assert.equal(checkChange(null, change), null);
  assert.equal(checkPermission({ userId: "u1", role: "sales" }, null, change), null);
  assert.match(String(checkPermission({ userId: "u1", role: "employee" }, null, change)), /rôle/);
  assert.match(String(checkPermission({ userId: "u1", role: "admin" }, null, change, "2026-11-30")), /clôturée/);
});

test("commandes fournisseurs : quantité proposée, en commande, message", async () => {
  const { suggestedQty, onOrder, orderMessage, orderTotal } = await import("../src/shared/stock.ts");
  assert.equal(suggestedQty({ qty: 2, alert: 5 }), 8, "remonter au double du seuil");
  assert.equal(suggestedQty({ qty: -3, alert: 0 }), 4);
  assert.equal(suggestedQty({ qty: 50, alert: 5 }), 1);
  const lines = [{ articleId: "art-1", label: "Ciment", qty: 8, unitCost: 4500 }];
  const orders = [
    { id: "cf-1", data: { status: "ordered", lines } },
    { id: "cf-2", data: { status: "received", lines } },
    { id: "cf-3", data: { status: "ordered", lines: [{ ...lines[0], qty: 2 }] } },
  ];
  assert.equal(onOrder(orders).get("art-1"), 10);
  assert.equal(orderTotal(lines), 36000);
  const msg = orderMessage({ company: "IDO", supplier: "CIMGABON", reference: "CF-221126-1", lines, units: new Map([["art-1", "sac"]]) });
  assert.match(msg, /commande CF-221126-1/);
  assert.match(msg, /- 8 sac × Ciment/);
});

test("stock : une facture tirée d'un bon livré, ou de son devis d'origine, ne sort pas le stock deux fois", () => {
  const l = [{ label: "Câble", qty: 3, unitPrice: 1000, vatRate: 18, articleId: "art-1" }];
  const quotes = [
    { id: "dv-1", data: { doc_type: "quote", number: "DV-1", lines: l } },
    { id: "bc-1", data: { doc_type: "order", number: "BC-1", source_id: "dv-1", lines: l } },
    { id: "bl-1", data: { doc_type: "delivery", number: "BL-1", date: "2026-11-02", source_id: "bc-1", lines: l } },
  ];
  for (const quote_id of ["bl-1", "bc-1", "dv-1"]) {
    const moves = salesMoves([{ id: "fa-1", data: { status: "validated", number: "FA-1", date: "2026-11-03", quote_id, lines: l } }], quotes);
    assert.deepEqual(moves.map((m) => [m.kind, m.qty]), [["delivery", -3]], quote_id);
  }
});
