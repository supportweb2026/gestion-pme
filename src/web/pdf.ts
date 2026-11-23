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
import { computeTotals, docTaxes, lineDiscount, lineNet, lineVat, type InvoiceLine } from "../shared/invoice.ts";
import { amountInWordsWithCurrency, decimalsOf, formatMoney } from "../shared/currency.ts";
import type { DocTable } from "../shared/sync.ts";
import { docArrete, docRefs, docTitle, isSection, isSlip, quoteTypeOf, sectionSubtotals, sellerOf, SLIP_TEXTS } from "../shared/documents.ts";
import { fiscalMentions, pct } from "../shared/taxes.ts";
import { docColor, rgb01, softOf, stampFor, termsFor, tooLight } from "../shared/branding.ts";

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
  const delivery = kind === "quotes" && isSlip(doc);
  const slip = SLIP_TEXTS[quoteTypeOf(doc)];
  // Couleur d'accent choisie dans Réglages (titre, en-tête du tableau, total).
  const accent = docColor(s);
  const BLUE = rgb(...rgb01(accent));
  const SOFT = rgb(...rgb01(softOf(accent)));
  pdf.setTitle(`${title} ${number}`);
  pdf.setAuthor(str(s.name));
  pdf.setCreator("Gestia");
  pdf.setProducer("Gestia");
  pdf.setLanguage("fr-FR");

  const lines = (doc.lines as InvoiceLine[]) ?? [];
  const currency = str(doc.currency) || "XAF";
  const decimals = decimalsOf(currency);
  const totals = computeTotals(lines, decimals, docTaxes(doc));
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

  let stamp: PDFImage | null = null;
  const stampData = stampFor(s, kind, delivery);
  if (stampData) {
    try {
      const bytes = Uint8Array.from(atob(stampData.split(",")[1] ?? ""), (c) => c.charCodeAt(0));
      stamp = /^data:image\/jpe?g/.test(stampData) ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
    } catch {
      stamp = null;
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
  for (const l of [str(s.address), str(s.city), str(s.phone) && `Tél. ${str(s.phone)}`, str(s.email), str(s.website), str(s.nif) && `NIF : ${str(s.nif)}`].filter(Boolean)) {
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
    sellerOf(doc, s) ? `Votre interlocuteur : ${sellerOf(doc, s)}` : "",
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
  text((delivery ? slip!.to : kind === "quotes" ? "Destinataire" : "Facturé à").toUpperCase(), boxX + 12, y - 14, 7.5, regular, GREY);
  let cy = y - 28;
  for (const l of nameLines) {
    text(l, boxX + 12, cy, 11, bold);
    cy -= 14;
  }
  for (const l of clientLines) {
    text(l, boxX + 12, cy, 9.5);
    cy -= 12;
  }
  // Références, à gauche de l'encadré du client : objet, référence de commande.
  const refs = docRefs(doc);
  const refW = boxX - M - 24;
  let ry = y - 2;
  const refBlock = (label: string, value: string, strong: boolean) => {
    if (!value) return;
    text(label.toUpperCase(), M, ry - 8, 7.5, regular, GREY);
    ry -= 21;
    for (const w of wrap(value, strong ? 10.5 : 9.5, refW, strong ? bold : regular).slice(0, 8)) {
      text(w, M, ry, strong ? 10.5 : 9.5, strong ? bold : regular);
      ry -= strong ? 13 : 12;
    }
    ry -= 6;
  };
  refBlock("Objet", refs.subject, true);
  refBlock("Référence de commande", refs.clientRef, false);
  y = Math.min(y - boxH, ry + 6) - 18;

  // ── Lignes ───────────────────────────────────────────────────────────────
  // Colonnes numériques alignées à droite (bord droit de chaque colonne).
  const cols = hasDiscount
    ? { qty: 284, pu: 370, disc: 440, vat: 470, net: xr - 6 }
    : { qty: 312, pu: 410, disc: 0, vat: 456, net: xr - 6 };
  // La désignation s'arrête avant la colonne des quantités (l'unité s'écrit sous la quantité).
  const labelW = hasDiscount ? 200 : 228;
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
      // Un titre ne reste jamais seul en bas de page : il lui faut la place de la ligne qui suit.
      if (y - 70 < M + FOOT) {
        newPage();
        header();
      }
      text(l.label, M + 6, y - 15, 9.5, bold, BLUE);
      if (!delivery) right(`Sous-total ${money(subtotals.get(idx) ?? 0)}`, xr - 6, y - 15, 9, regular, GREY);
      y -= 22;
      page.drawLine({ start: { x: M, y }, end: { x: xr, y }, thickness: 0.6, color: LINE });
      return;
    }
    const label = wrap(l.label || "", 9.5, delivery ? xr - M - 100 : labelW, bold);
    // Détail sous la désignation (documents repris) : plus petit, en gris.
    const detail = l.description ? wrap(l.description, 8, delivery ? xr - M - 100 : labelW) : [];
    const discounted = !delivery && lineDiscount(l) > 0;
    // Hauteur : le texte, ou les deux lignes d'une cellule chiffrée (quantité et unité, remise et montant).
    const h = Math.max(Math.max(1, label.length) * 12 + detail.length * 10, l.unit || discounted ? 23 : 0) + 8;
    if (y - h < M + FOOT) {
      newPage();
      header();
    }
    let ly = y - 13;
    for (const w of label) {
      text(w, M + 6, ly, 9.5, bold);
      ly -= 12;
    }
    for (const w of detail) {
      text(w, M + 6, ly + 1, 8, regular, GREY);
      ly -= 10;
    }
    if (delivery) {
      right(String(l.qty).replace(".", ","), xr - 6, y - 13, 9.5);
      if (l.unit) right(l.unit, xr - 6, y - 23, 8, regular, GREY);
      y -= h;
      page.drawLine({ start: { x: M, y }, end: { x: xr, y }, thickness: 0.6, color: LINE });
      return;
    }
    right(String(l.qty).replace(".", ","), cols.qty, y - 13, 9.5);
    if (l.unit) right(l.unit, cols.qty, y - 23, 8, regular, GREY);
    right(money(l.unitPrice), cols.pu, y - 13, 9.5);
    if (discounted) {
      right(`${String(lineDiscount(l)).replace(".", ",")} %`, cols.disc, y - 13, 9.5);
      // Ce que la remise représente, pour que le client voie ce qu'il gagne.
      right(`-${money(Math.round((l.qty * l.unitPrice - lineNet(l, decimals)) * 10 ** decimals) / 10 ** decimals)}`, cols.disc, y - 23, 8, regular, GREY);
    }
    right(`${l.vatRate} %`, cols.vat, y - 13, 9.5);
    right(money(lineNet(l, decimals)), cols.net, y - 13, 9.5);
    y -= h;
    page.drawLine({ start: { x: M, y }, end: { x: xr, y }, thickness: 0.6, color: LINE });
  });
  y -= 14;

  if (delivery) {
    // ── Bon de livraison : notes puis signatures ───────────────────────────
    const notes = refs.notes ? wrap(refs.notes, 9, xr - M) : [];
    if (y - (notes.length * 11 + 110) < M + FOOT) newPage();
    for (const n of notes) {
      text(n, M, y, 9, regular, GREY);
      y -= 11;
    }
    y -= 14;
    const w = (xr - M - 20) / 2;
    for (const [i, label] of [slip!.by.toUpperCase(), slip!.received.toUpperCase()].entries()) {
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
  if (totals.css) rows.push([`CSS ${pct(Number(doc.css_rate))}`, money(totals.css), false]);
  rows.push(["Total TTC", money(totals.gross), true]);
  if (totals.withholding) {
    rows.push([`Retenue à la source ${pct(Number(doc.withholding_rate))}`, `-${money(totals.withholding)}`, false]);
    rows.push(["Net à payer", money(totals.payable), true]);
  }
  if (situation && situation.status !== "draft" && situation.paid + situation.credited > 0) {
    rows.push(["Déjà réglé", money(situation.paid + situation.credited), false]);
    rows.push(["Reste à payer", money(situation.due), true]);
  }
  const rate = Number(doc.rate) || 1;
  if (currency !== "XAF" && currency !== "XOF") rows.push([`Contre-valeur (taux ${String(rate).replace(".", ",")})`, formatMoney(Math.round(totals.gross * rate), "XAF"), false]);

  const totW = 250;
  const totX = xr - totW;
  const words = wrap(`${docArrete(kind, doc)} à la somme de ${amountInWordsWithCurrency(totals.gross, currency)} toutes taxes comprises.`, 9.5, totX - M - 20);
  const mentions = fiscalMentions({
    kind, settings: s, data: doc, delivery,
    hasZeroVat: lines.some((l) => !isSection(l) && !l.deposit && !l.depositInvoiceId && l.vatRate === 0 && lineNet(l, decimals) !== 0),
    payableXaf: Math.round(totals.payable * (currency === "XAF" ? 1 : Number(doc.rate) || 1)),
  });
  const notes = [refs.notes, ...mentions].filter(Boolean).flatMap((n) => wrap(n, 9, totX - M - 20));
  const blockH = Math.max(rows.length * 18 + 4, words.length * 12 + (notes.length ? notes.length * 11 + 10 : 0));
  if (y - blockH < M + FOOT) newPage();
  let ty = y;
  // Le montant que le client doit retenir (dernier total) ressort en couleur pleine.
  const finalRow = rows.map((r) => r[2]).lastIndexOf(true);
  const onAccent = tooLight(accent) ? INK : rgb(1, 1, 1);
  for (const [i, [label, value, strong]] of rows.entries()) {
    const final = i === finalRow;
    const rh = final ? 22 : 18;
    if (strong) page.drawRectangle({ x: totX, y: ty - rh, width: totW, height: rh, color: final ? BLUE : SOFT });
    const f = strong ? bold : regular;
    text(label, totX + 8, ty - (final ? 15 : 12.5), final ? 10.5 : 9.5, f, final ? onAccent : INK);
    right(value, xr - 8, ty - (final ? 15 : 12.5), final ? 10.5 : 9.5, f, final ? onAccent : INK);
    ty -= rh;
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
  // Des cases, pour que le client trouve d'un coup d'œil quand et comment payer.
  const pay: [string, string][] = kind !== "credit_notes"
    ? ([
      ["Échéance", kind === "invoices" ? frDate(doc.due_date) : ""],
      ["Conditions de règlement", refs.paymentTerms],
      ["Virement bancaire", str(s.bank)],
      ["Mobile money", str(s.mobile_money)],
    ] as [string, string][]).filter(([, v]) => v)
    : [];
  if (pay.length) {
    const gap = 8;
    const per = pay.length === 1 ? 1 : 2;
    const cellW = (xr - M - gap * (per - 1)) / per;
    const cells = pay.map(([label, value]) => ({ label, lines: wrap(value, 9.5, cellW - 20, bold).slice(0, 6) }));
    for (let i = 0; i < cells.length; i += per) {
      const row = cells.slice(i, i + per);
      const ch = 24 + Math.max(...row.map((c) => c.lines.length)) * 12;
      if (y - ch < M + FOOT) newPage();
      row.forEach((c, k) => {
        const x = M + k * (cellW + gap);
        // Dernière case seule sur sa rangée : elle prend toute la largeur.
        const w = row.length < per ? xr - M : cellW;
        page.drawRectangle({ x, y: y - ch, width: w, height: ch, borderColor: LINE, borderWidth: 1 });
        text(c.label.toUpperCase(), x + 10, y - 13, 7.5, regular, GREY);
        c.lines.forEach((l, n) => text(l, x + 10, y - 27 - n * 12, 9.5, bold));
      });
      y -= ch + gap;
    }
    y -= 6;
  }
  // Cachet et signature de l'entreprise (à gauche), bon pour accord du client (à droite, devis).
  if (stamp || kind === "quotes") {
    if (y - 90 < M + FOOT) newPage();
    if (stamp) {
      text((str(s.name) ? `Pour ${str(s.name)}` : "Cachet et signature").toUpperCase().slice(0, 60), M, y - 14, 7.5, regular, GREY);
      const sc = Math.min(170 / stamp.width, 66 / stamp.height, 1);
      page.drawImage(stamp, { x: M, y: y - 20 - stamp.height * sc, width: stamp.width * sc, height: stamp.height * sc });
    }
    if (kind === "quotes") {
      page.drawRectangle({ x: boxX, y: y - 85, width: boxW, height: 85, borderColor: GREY, borderWidth: 0.8, borderDashArray: [3, 3] });
      text("BON POUR ACCORD", boxX + 10, y - 14, 7.5, regular, GREY);
      text("Date, signature et cachet du client", boxX + 10, y - 27, 9, regular, GREY);
    }
    y -= 95;
  }
  // Conditions générales : petit texte après le document.
  const terms = termsFor(s, kind, delivery);
  if (terms) {
    const tl = wrap(terms, 7.5, xr - M);
    if (y - (16 + tl.length * 9.5) < M + FOOT) newPage();
    text("CONDITIONS GÉNÉRALES", M, y - 8, 7, regular, GREY);
    y -= 20;
    for (const l of tl) {
      text(l, M, y, 7.5, regular, GREY);
      y -= 9.5;
    }
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
