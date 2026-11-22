/**
 * PDF des devis, factures et avoirs, fabriqué sur l'appareil (hors ligne,
 * sans service externe). Même contenu que l'aperçu imprimable : en-tête de
 * l'entreprise, client, lignes avec remise, TVA ventilée par taux, montant en
 * lettres, règlement, mentions légales et numéro de page.
 *
 * Ce module est chargé à la demande (pdf-lib pèse lourd) ; App le précharge
 * une fois l'application ouverte pour qu'il soit disponible sans réseau.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { computeTotals, lineDiscount, lineNet, lineVat, type InvoiceLine } from "../shared/invoice.ts";
import { amountInWordsWithCurrency, decimalsOf, formatMoney } from "../shared/currency.ts";
import type { DocTable } from "../shared/sync.ts";
import { docArrete, docTitle, isSection, quoteTypeOf, sectionSubtotals } from "../shared/documents.ts";

export interface PdfInput {
  kind: DocTable;
  /** Champs du document (number, date, lines, currency…). */
  doc: Record<string, unknown>;
  client: Record<string, unknown> | null;
  /** Réglages de l'entreprise (nom, adresse, NIF, RCCM, logo…). */
  company: Record<string, unknown>;
  /** Pour une facture validée : déjà réglé et reste dû. */
  situation?: { paid: number; credited: number; due: number; status: string };
}


const A4 = { w: 595.28, h: 841.89 };
const M = 42; // marge, en points (≈ 15 mm)
const BLUE = rgb(0x02 / 255, 0x55 / 255, 0xc6 / 255);
const SOFT = rgb(0xea / 255, 0xf1 / 255, 0xfc / 255);
const INK = rgb(0x10 / 255, 0x1d / 255, 0x36 / 255);
const GREY = rgb(0x6b / 255, 0x70 / 255, 0x68 / 255);
const LINE = rgb(0xe1 / 255, 0xe6 / 255, 0xef / 255);

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

/** Date ISO → JJ/MM/AAAA. */
function frDate(v: unknown): string {
  const s = str(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

/** Nom de fichier proposé : « Facture FA-2026-00012 - Client.pdf ». */
export function pdfFileName(kind: DocTable, doc: Record<string, unknown>, client: Record<string, unknown> | null): string {
  const name = str(client?.name).replace(/[\\/:*?"<>|]+/g, " ").trim();
  return `${docTitle(kind, doc)} ${str(doc.number) || "brouillon"}${name ? ` - ${name}` : ""}.pdf`;
}

export async function buildPdf(input: PdfInput): Promise<Uint8Array> {
  const { kind, doc, client, company: s, situation } = input;
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const number = str(doc.number);
  const title = docTitle(kind, doc);
  // Bon de livraison : quantités seulement, sans prix ni totaux.
  const delivery = kind === "quotes" && quoteTypeOf(doc) === "delivery";
  pdf.setTitle(`${title} ${number}`);
  pdf.setAuthor(str(s.name));
  pdf.setCreator("Gestia");
  pdf.setProducer("Gestia");
  pdf.setLanguage("fr-FR");

  const lines = (doc.lines as InvoiceLine[]) ?? [];
  const currency = str(doc.currency) || "XAF";
  const decimals = decimalsOf(currency);
  const totals = computeTotals(lines, decimals);
  const money = (n: number) => formatMoney(n, currency);
  const hasDiscount = lines.some((l) => lineDiscount(l) > 0);

  // Les polices standard ne couvrent que le jeu Windows-1252 : on remplace le reste.
  const allowed = new Map<string, boolean>();
  const clean = (t: string) =>
    [...t.replace(/[   ]/g, " ").replace(/\t/g, " ")]
      .map((ch) => {
        if (!allowed.has(ch)) {
          try {
            regular.encodeText(ch);
            allowed.set(ch, true);
          } catch {
            allowed.set(ch, false);
          }
        }
        return allowed.get(ch) ? ch : "?";
      })
      .join("");
  const width = (t: string, size: number, font: PDFFont = regular) => font.widthOfTextAtSize(clean(t), size);

  /** Coupe un texte en lignes tenant dans la largeur donnée (retours à la ligne conservés). */
  function wrap(t: string, size: number, max: number, font: PDFFont = regular): string[] {
    const out: string[] = [];
    for (const para of t.split(/\r?\n/).map(clean)) {
      let cur = "";
      for (const word of para.split(/ +/)) {
        const next = cur ? `${cur} ${word}` : word;
        if (width(next, size, font) <= max) {
          cur = next;
          continue;
        }
        if (cur) out.push(cur);
        // Mot plus long que la colonne : coupé au caractère.
        let w = word;
        while (width(w, size, font) > max && w.length > 1) {
          let k = w.length - 1;
          while (k > 1 && width(w.slice(0, k), size, font) > max) k--;
          out.push(w.slice(0, k));
          w = w.slice(k);
        }
        cur = w;
      }
      out.push(cur);
    }
    return out;
  }

  let logo: PDFImage | null = null;
  const logoData = str(s.logo);
  if (logoData.startsWith("data:image/")) {
    try {
      const bytes = Uint8Array.from(atob(logoData.split(",")[1] ?? ""), (c) => c.charCodeAt(0));
      logo = /^data:image\/jpe?g/.test(logoData) ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
    } catch {
      logo = null; // logo illisible : le document sort quand même
    }
  }

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;
  const text = (t: string, x: number, yy: number, size = 9.5, font: PDFFont = regular, color = INK) =>
    page.drawText(clean(t), { x, y: yy, size, font, color });
  const right = (t: string, xr: number, yy: number, size = 9.5, font: PDFFont = regular, color = INK) =>
    text(t, xr - width(t, size, font), yy, size, font, color);
  const FOOT = 52; // hauteur réservée au pied de page
  const newPage = () => {
    page = pdf.addPage([A4.w, A4.h]);
    pages.push(page);
    y = A4.h - M;
  };

  // ── En-tête ──────────────────────────────────────────────────────────────
  newPage();
  let leftY = y;
  if (logo) {
    const scale = Math.min(150 / logo.width, 60 / logo.height, 1);
    const lw = logo.width * scale;
    const lh = logo.height * scale;
    page.drawImage(logo, { x: M, y: leftY - lh, width: lw, height: lh });
    leftY -= lh + 8;
  }
  text(str(s.name), M, leftY - 11, 12.5, bold);
  leftY -= 16;
  for (const l of [str(s.address), str(s.city), str(s.phone) && `Tél. ${str(s.phone)}`, str(s.email)].filter(Boolean)) {
    for (const w of wrap(l, 9, 250)) {
      text(w, M, leftY - 10, 9, regular, GREY);
      leftY -= 12;
    }
  }

  const xr = A4.w - M;
  let rightY = y;
  right(title.toUpperCase(), xr, rightY - 20, title.length > 14 ? 16 : 20, bold, BLUE);
  rightY -= 30;
  right(`N° ${number || "brouillon"}`, xr, rightY - 11, 11.5, bold);
  rightY -= 17;
  const meta = [
    `Date : ${frDate(doc.date)}`,
    kind === "invoices" && doc.due_date ? `Échéance : ${frDate(doc.due_date)}` : "",
    kind === "quotes" && doc.valid_until ? `Valable jusqu'au ${frDate(doc.valid_until)}` : "",
    kind === "credit_notes" && doc.invoice_number ? `Sur facture ${str(doc.invoice_number)}` : "",
    kind === "invoices" && doc.quote_number ? `Réf. ${str(doc.quote_number)}` : "",
    kind === "quotes" && doc.source_number ? `Réf. ${str(doc.source_number)}` : "",
  ].filter(Boolean);
  for (const l of meta) {
    right(l, xr, rightY - 10, 9.5);
    rightY -= 13;
  }

  // ── Client ───────────────────────────────────────────────────────────────
  y = Math.min(leftY, rightY) - 14;
  const c = client ?? {};
  const boxW = 240;
  const boxX = xr - boxW;
  const clientLines = [
    ...wrap(str(c.address), 9.5, boxW - 24), ...wrap(str(c.city), 9.5, boxW - 24),
    str(c.nif) && `NIF : ${str(c.nif)}`, str(c.rccm) && `RCCM : ${str(c.rccm)}`,
  ].filter(Boolean);
  const nameLines = wrap(str(c.name), 11, boxW - 24, bold);
  const boxH = 22 + nameLines.length * 14 + clientLines.length * 12 + 8;
  page.drawRectangle({ x: boxX, y: y - boxH, width: boxW, height: boxH, borderColor: LINE, borderWidth: 1 });
  text((delivery ? "Livré à" : kind === "quotes" ? "Destinataire" : "Facturé à").toUpperCase(), boxX + 12, y - 14, 7.5, regular, GREY);
  let cy = y - 28;
  for (const l of nameLines) {
    text(l, boxX + 12, cy, 11, bold);
    cy -= 14;
  }
  for (const l of clientLines) {
    text(l, boxX + 12, cy, 9.5);
    cy -= 12;
  }
  y -= boxH + 18;

  // ── Lignes ───────────────────────────────────────────────────────────────
  // Colonnes numériques alignées à droite (bord droit de chaque colonne).
  const cols = hasDiscount
    ? { qty: 300, pu: 378, disc: 418, vat: 452, net: xr - 6 }
    : { qty: 318, pu: 410, disc: 0, vat: 452, net: xr - 6 };
  const labelW = (hasDiscount ? 236 : 256) - 6;
  const subtotals = sectionSubtotals(lines, decimals);
  const header = () => {
    page.drawRectangle({ x: M, y: y - 20, width: xr - M, height: 20, color: SOFT });
    text("Désignation", M + 6, y - 13.5, 9, bold);
    if (delivery) {
      right("Quantité", xr - 6, y - 13.5, 9, bold);
      y -= 20;
      return;
    }
    right("Qté", cols.qty, y - 13.5, 9, bold);
    right("P.U. HT", cols.pu, y - 13.5, 9, bold);
    if (hasDiscount) right("Remise", cols.disc, y - 13.5, 9, bold);
    right("TVA", cols.vat, y - 13.5, 9, bold);
    right("Montant HT", cols.net, y - 13.5, 9, bold);
    y -= 20;
  };
  header();
  lines.forEach((l, idx) => {
    if (isSection(l)) {
      if (y - 26 < M + FOOT) {
        newPage();
        header();
      }
      text(l.label, M + 6, y - 15, 9.5, bold);
      if (!delivery) right(`Sous-total ${money(subtotals.get(idx) ?? 0)}`, xr - 6, y - 15, 9, regular, GREY);
      y -= 22;
      page.drawLine({ start: { x: M, y }, end: { x: xr, y }, thickness: 0.6, color: LINE });
      return;
    }
    const label = wrap(l.label || "", 9.5, delivery ? xr - M - 100 : labelW);
    const h = Math.max(1, label.length) * 12 + 8;
    if (y - h < M + FOOT) {
      newPage();
      header();
    }
    let ly = y - 13;
    for (const w of label) {
      text(w, M + 6, ly, 9.5);
      ly -= 12;
    }
    if (delivery) {
      right(`${l.qty}${l.unit ? ` ${l.unit}` : ""}`, xr - 6, y - 13, 9.5);
      y -= h;
      page.drawLine({ start: { x: M, y }, end: { x: xr, y }, thickness: 0.6, color: LINE });
      return;
    }
    right(`${l.qty}${l.unit ? ` ${l.unit}` : ""}`, cols.qty, y - 13, 9.5);
    right(money(l.unitPrice), cols.pu, y - 13, 9.5);
    if (hasDiscount) right(lineDiscount(l) ? `${lineDiscount(l)} %` : "", cols.disc, y - 13, 9.5);
    right(`${l.vatRate} %`, cols.vat, y - 13, 9.5);
    right(money(lineNet(l, decimals)), cols.net, y - 13, 9.5);
    y -= h;
    page.drawLine({ start: { x: M, y }, end: { x: xr, y }, thickness: 0.6, color: LINE });
  });
  y -= 14;

  if (delivery) {
    // ── Bon de livraison : notes puis signatures ───────────────────────────
    const notes = str(doc.notes) ? wrap(str(doc.notes), 9, xr - M) : [];
    if (y - (notes.length * 11 + 110) < M + FOOT) newPage();
    for (const n of notes) {
      text(n, M, y, 9, regular, GREY);
      y -= 11;
    }
    y -= 14;
    const w = (xr - M - 20) / 2;
    for (const [i, label] of ["LIVRÉ PAR", "REÇU PAR LE CLIENT"].entries()) {
      const x = M + i * (w + 20);
      page.drawRectangle({ x, y: y - 85, width: w, height: 85, borderColor: GREY, borderWidth: 0.8, borderDashArray: [3, 3] });
      text(label, x + 10, y - 14, 7.5, regular, GREY);
      text(i === 0 ? "Nom et signature" : "Nom, date, signature et cachet", x + 10, y - 27, 9, regular, GREY);
    }
    y -= 100;
  } else {
  // ── Totaux et montant en lettres ─────────────────────────────────────────
  const vatByRate = new Map<number, { base: number; vat: number }>();
  for (const l of lines) {
    if (isSection(l)) continue;
    const cur = vatByRate.get(l.vatRate) ?? { base: 0, vat: 0 };
    vatByRate.set(l.vatRate, { base: cur.base + lineNet(l, decimals), vat: cur.vat + lineVat(l, decimals) });
  }
  const rows: [string, string, boolean][] = [];
  if (totals.discount > 0) {
    rows.push(["Total brut HT", money(totals.net + totals.discount), false]);
    rows.push(["Remises", `-${money(totals.discount)}`, false]);
  }
  rows.push(["Total HT", money(totals.net), false]);
  for (const [rate, v] of vatByRate) rows.push([`TVA ${rate} % sur ${money(v.base)}`, money(v.vat), false]);
  rows.push(["Total TTC", money(totals.gross), true]);
  if (situation && situation.status !== "draft" && situation.paid + situation.credited > 0) {
    rows.push(["Déjà réglé", money(situation.paid + situation.credited), false]);
    rows.push(["Reste à payer", money(situation.due), true]);
  }
  const rate = Number(doc.rate) || 1;
  if (currency !== "XAF" && currency !== "XOF") rows.push([`Contre-valeur (taux ${String(rate).replace(".", ",")})`, formatMoney(Math.round(totals.gross * rate), "XAF"), false]);

  const totW = 250;
  const totX = xr - totW;
  const words = wrap(`${docArrete(kind, doc)} à la somme de ${amountInWordsWithCurrency(totals.gross, currency)} toutes taxes comprises.`, 9.5, totX - M - 20);
  const notes = str(doc.notes) ? wrap(str(doc.notes), 9, totX - M - 20) : [];
  const blockH = Math.max(rows.length * 18, words.length * 12 + (notes.length ? notes.length * 11 + 10 : 0));
  if (y - blockH < M + FOOT) newPage();
  let ty = y;
  for (const [label, value, strong] of rows) {
    if (strong) page.drawRectangle({ x: totX, y: ty - 18, width: totW, height: 18, color: SOFT });
    const f = strong ? bold : regular;
    text(label, totX + 8, ty - 12.5, 9.5, f);
    right(value, xr - 8, ty - 12.5, 9.5, f);
    ty -= 18;
    page.drawLine({ start: { x: totX, y: ty }, end: { x: xr, y: ty }, thickness: 0.6, color: LINE });
  }
  let wy = y - 10;
  for (const w of words) {
    text(w, M, wy, 9.5);
    wy -= 12;
  }
  if (notes.length) {
    wy -= 8;
    for (const n of notes) {
      text(n, M, wy, 9, regular, GREY);
      wy -= 11;
    }
  }
  y = Math.min(ty, wy) - 18;

  // ── Règlement, bon pour accord ───────────────────────────────────────────
  const pay = kind !== "credit_notes"
    ? [str(s.bank) && `Virement : ${str(s.bank)}`, str(s.mobile_money) && `Mobile money : ${str(s.mobile_money)}`].filter(Boolean)
    : [];
  if (pay.length) {
    const payLines = pay.flatMap((p) => wrap(p, 9.5, xr - M));
    if (y - (16 + payLines.length * 12) < M + FOOT) newPage();
    text("RÈGLEMENT", M, y - 8, 7.5, regular, GREY);
    y -= 22;
    for (const p of payLines) {
      text(p, M, y, 9.5);
      y -= 12;
    }
    y -= 10;
  }
  if (kind === "quotes") {
    if (y - 90 < M + FOOT) newPage();
    page.drawRectangle({ x: boxX, y: y - 85, width: boxW, height: 85, borderColor: GREY, borderWidth: 0.8, borderDashArray: [3, 3] });
    text("BON POUR ACCORD", boxX + 10, y - 14, 7.5, regular, GREY);
    text("Date, signature et cachet du client", boxX + 10, y - 27, 9, regular, GREY);
  }

  }

  // ── Pied de page sur chaque page ─────────────────────────────────────────
  const legal = [str(s.name), str(s.legal_form), str(s.capital) && `Capital ${str(s.capital)}`, str(s.nif) && `NIF ${str(s.nif)}`, str(s.rccm) && `RCCM ${str(s.rccm)}`]
    .filter(Boolean).join(" · ");
  const footLines = [...wrap(legal, 7.5, xr - M), ...(str(s.footer) ? wrap(str(s.footer), 7.5, xr - M) : [])].slice(0, 3);
  pages.forEach((p, i) => {
    page = p;
    page.drawLine({ start: { x: M, y: M + 38 }, end: { x: xr, y: M + 38 }, thickness: 0.6, color: LINE });
    let fy = M + 27;
    for (const l of footLines) {
      text(l, (A4.w - width(l, 7.5)) / 2, fy, 7.5, regular, GREY);
      fy -= 10;
    }
    if (pages.length > 1) right(`Page ${i + 1} / ${pages.length}`, xr, M - 14, 7.5, regular, GREY);
  });

  return pdf.save();
}
