import test from "node:test";
import assert from "node:assert/strict";
import { contactsOf, contactsSearchText, removeContact, saveContact, type Contact } from "../src/shared/contacts.ts";

const c = (id: string, name: string, extra: Partial<Contact> = {}): Contact => ({ id, name, role: "", phone: "", email: "", ...extra });

test("contacts : lecture tolérante, principal en premier", () => {
  assert.deepEqual(contactsOf(undefined), []);
  assert.deepEqual(contactsOf({ contacts: "x" }), []);
  const list = contactsOf({ contacts: [c("a", "Zoé"), c("b", "Anna", { main: true }), { id: "", name: "sans id" }, null] });
  assert.deepEqual(list.map((x) => [x.name, x.main]), [["Anna", true], ["Zoé", false]]);
  // Sans principal désigné : le premier de la liste.
  assert.equal(contactsOf({ contacts: [c("a", "Zoé"), c("b", "Anna")] }).find((x) => x.main)?.name, "Zoé");
  // Deux principaux (deux appareils) : un seul est gardé.
  assert.equal(contactsOf({ contacts: [c("a", "Zoé", { main: true }), c("b", "Anna", { main: true })] }).filter((x) => x.main).length, 1);
});

test("contacts : ajout, modification, principal unique, suppression", () => {
  let list = saveContact([], c("a", " Paul ", { role: "Achats" }));
  assert.equal(list[0].name, "Paul");
  assert.equal(list[0].main, true, "le premier contact est le principal");
  list = saveContact(list, c("b", "Rose", { main: true }));
  assert.deepEqual(list.map((x) => [x.id, x.main]), [["a", false], ["b", true]]);
  list = saveContact(list, c("a", "Paul", { phone: "+241 77 00 00 00" }));
  assert.equal(list.length, 2);
  assert.equal(list.find((x) => x.id === "a")?.phone, "+241 77 00 00 00");
  list = removeContact(list, "b");
  assert.deepEqual(list.map((x) => [x.id, x.main]), [["a", true]], "le principal supprimé est remplacé");
  assert.deepEqual(removeContact(list, "a"), []);
  assert.match(contactsSearchText({ contacts: list }), /Paul.*\+241/);
});
