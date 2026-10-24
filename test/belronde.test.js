import { test } from "node:test";
import assert from "node:assert/strict";
import { createBelronde, rittenPerChauffeur } from "../src/belronde.js";
import { createBotHandler } from "../src/telegram.js";
import { emptyState } from "../src/store.js";

// Zaterdag 24-10-2026 (zomertijd, UTC+2). Morgen = zondag 25-10 (wintertijd vanaf 03:00).
const om = (hm, dag = "2026-10-24") => Date.parse(`${dag}T${hm}:00+02:00`);
const morgen = (hm) => Date.parse(`2026-10-25T${hm}:00+01:00`);

const RONALD = "aaaaaaaaaaaaaaaaaaaa0001";
const PIET = "aaaaaaaaaaaaaaaaaaaa0002";
const KEES = "aaaaaaaaaaaaaaaaaaaa0003";

function rit(ref, t, driverId, over = {}) {
  return {
    reference: ref, requestedDate: new Date(t).toISOString(), status: "assigned", driverId,
    departure: { city: "Nuenen", address: "Geheimstraat 1" }, destination: { city: "Schiphol" },
    customer: { name: "Mevrouw Geheim", phone: "0612345678" }, ...over,
  };
}

function setup({ rides, chats = {}, env = {} } = {}) {
  const state = emptyState();
  Object.assign(state.chats, chats);
  const store = { state, save() {}, kind: "test" };
  let lijst = rides ?? [
    rit("WNT-1", morgen("07:15"), RONALD, { flightNumber: "kl 1234" }),
    rit("WNT-2", morgen("10:00"), RONALD),
    rit("WNT-3", morgen("09:00"), PIET),
    rit("WNT-4", morgen("11:00"), KEES),
    rit("WNT-5", morgen("12:00"), null),
    rit("WNT-6", morgen("13:00"), PIET, { status: "canceled" }),
    rit("WNT-7", om("18:00"), PIET), // vandaag: telt niet
  ];
  let fetches = 0;
  const taxiId = {
    async getUpcomingRides() {
      fetches++;
      return { rides: lijst, fetchedAt: now, stale: false };
    },
    async getDriver(id) {
      return { id, naam: { [RONALD]: "Ronald de Vries", [PIET]: "Piet Jansen", [KEES]: "Kees Bakker" }[id] };
    },
    async listDrivers() {
      return null; // zoals wanneer taxiID geen lijst geeft
    },
  };
  const sent = [];
  const edits = [];
  const removed = [];
  let msgId = 100;
  let now = om("16:00");
  const allEnv = { BOT_BEHEER_CHAT_IDS: "1", BOT_TOEGANGSCODE: "wnt2026", ...env };
  const bel = createBelronde({
    store, taxiId, env: allEnv, now: () => now, log: { warn() {}, info() {} },
    send: async (chatId, text, extra) => {
      sent.push({ chatId: String(chatId), text, extra });
      return { message_id: ++msgId };
    },
    editText: async (chatId, messageId, text) => edits.push({ chatId, messageId, text }),
    removeButtons: async (chatId, messageId) => removed.push({ chatId, messageId }),
  });
  const handle = createBotHandler({ store, tracker: {}, belronde: bel, env: allEnv, now: () => now });
  return {
    state, sent, edits, removed, bel, handle,
    fetches: () => fetches,
    at: async (t) => {
      now = t;
      await bel.tick();
    },
    setRides: (r) => (lijst = r),
    aan: (chatId) => sent.filter((s) => s.chatId === String(chatId)),
  };
}

const gekoppeld = {
  "10": { toegelaten: true, naam: "Ronald", driverId: RONALD, driverNaam: "Ronald de Vries" },
  "20": { toegelaten: true, naam: "Piet", driverId: PIET, driverNaam: "Piet Jansen" },
  "1": { toegelaten: true, naam: "Hans", driverId: null },
};

test("ritten per chauffeur: alleen morgen, zonder geannuleerde, op tijd gesorteerd", () => {
  const s = setup();
  const { per, zonder } = rittenPerChauffeur(
    [rit("B", morgen("10:00"), RONALD), rit("A", morgen("07:15"), RONALD), rit("C", morgen("09:00"), PIET, { status: "Canceled" }), rit("D", om("20:00"), PIET), rit("E", morgen("23:30"), null)],
    "2026-10-25",
  );
  assert.deepEqual(per.get(RONALD).map((i) => i.ref), ["A", "B"]);
  assert.equal(per.has(PIET), false);
  assert.deepEqual(zonder.map((i) => i.ref), ["E"]);
  assert.ok(s);
});

test("om 17:00 krijgt elke gekoppelde chauffeur zijn ritten, zonder klantgegevens", async () => {
  const s = setup({ chats: structuredClone(gekoppeld) });
  await s.at(om("16:59"));
  assert.equal(s.sent.length, 0);
  await s.at(om("17:00"));
  const ronald = s.aan(10);
  assert.equal(ronald.length, 1);
  assert.match(ronald[0].text, /Morgen \(zondag 25 oktober\) heb je 2 ritten/);
  assert.match(ronald[0].text, /07:15  WNT-1  Nuenen → Schiphol  ✈ KL1234/);
  assert.match(ronald[0].text, /10:00  WNT-2/);
  assert.equal(ronald[0].extra.reply_markup.inline_keyboard[0][0].callback_data, `bel:2026-10-25:${RONALD}`);
  const piet = s.aan(20);
  assert.equal(piet.length, 1);
  assert.match(piet[0].text, /1 rit\./);
  assert.ok(!piet[0].text.includes("WNT-6")); // geannuleerd
  assert.ok(!piet[0].text.includes("WNT-7")); // vandaag
  for (const m of s.sent) assert.ok(!/Geheim|0612345678/.test(m.text));
  assert.ok(!JSON.stringify(s.state).match(/Geheim|0612345678/));
  // geen dubbel bericht in de volgende minuut
  await s.at(om("17:01"));
  assert.equal(s.sent.length, 2);
});

test("op Gebeld tikken: genoteerd, bericht bijgewerkt en niet meer herinnerd", async () => {
  const s = setup({ chats: structuredClone(gekoppeld) });
  await s.at(om("17:00"));
  const m = s.aan(10)[0];
  const antwoord = await s.bel.knopGedrukt({ id: "x", data: `bel:2026-10-25:${RONALD}`, message: { chat: { id: 10 }, message_id: 101, text: m.text } });
  assert.equal(antwoord, "Bedankt!");
  assert.match(s.edits.at(-1).text, /✅ Gebeld \(17:00\)/);
  // iemand anders mag niet op Ronalds knop tikken
  assert.equal(await s.bel.knopGedrukt({ id: "y", data: `bel:2026-10-25:${RONALD}`, message: { chat: { id: 20 }, message_id: 102, text: "" } }), "Dit is niet jouw herinnering.");

  await s.at(om("19:30"));
  assert.equal(s.aan(10).length, 1); // Ronald: geen herinnering
  assert.equal(s.aan(20).length, 2); // Piet wel
  assert.match(s.aan(20)[1].text, /Herinnering.*09:00 WNT-3/);

  await s.at(om("20:00"));
  const overzicht = s.aan(1).at(-1).text;
  assert.match(overzicht, /Belronde voor morgen \(zondag 25 oktober\)/);
  assert.match(overzicht, /✅ Ronald de Vries: 2 ritten, gebeld \(17:00\)/);
  assert.match(overzicht, /⏳ Piet Jansen: 1 rit, nog niet afgevinkt/);
  assert.match(overzicht, /❓ Kees Bakker: 1 rit, niet gekoppeld aan de bot/);
  assert.match(overzicht, /⚠️ Zonder chauffeur: 12:00 WNT-5/);
  // overzicht maar één keer
  await s.at(om("20:30"));
  assert.equal(s.aan(1).filter((x) => /Belronde/.test(x.text)).length, 1);
});

test("wijzigingen na 17:00: nieuwe, verplaatste en vervallen ritten", async () => {
  const s = setup({ chats: structuredClone(gekoppeld) });
  await s.at(om("17:00"));
  await s.bel.knopGedrukt({ id: "x", data: `bel:2026-10-25:${RONALD}`, message: { chat: { id: 10 }, message_id: 101, text: "" } });
  s.setRides([
    rit("WNT-1", morgen("07:45"), RONALD), // andere tijd
    rit("WNT-3", morgen("09:00"), PIET),
    rit("WNT-2", morgen("10:00"), PIET), // van Ronald naar Piet
    rit("WNT-8", morgen("14:00"), RONALD), // nieuw
  ]);
  await s.at(om("17:20"));
  assert.equal(s.aan(10).length, 1); // nog geen half uur: nog niet gecontroleerd
  await s.at(om("17:30"));
  const r = s.aan(10).at(-1).text;
  assert.match(r, /Nieuw:\n14:00  WNT-8/);
  assert.match(r, /Andere tijd:\n07:45  WNT-1 .*\(was 07:15\)/);
  assert.match(r, /Vervallen of niet meer bij jou:\n10:00  WNT-2/);
  assert.ok(s.aan(10).at(-1).extra.reply_markup);
  assert.match(s.aan(20).at(-1).text, /Nieuw:\n10:00  WNT-2/);
  // Ronald moet opnieuw bellen: in het overzicht staat hij weer open
  await s.at(om("20:00"));
  assert.match(s.aan(1).at(-1).text, /⏳ Ronald de Vries: 2 ritten, 2 nog niet afgevinkt|⏳ Ronald de Vries: 2 ritten, nog niet afgevinkt/);
});

test("na 21:30 en vóór 17:00 gebeurt er niets", async () => {
  const s = setup({ chats: structuredClone(gekoppeld) });
  await s.at(om("21:45"));
  await s.at(om("12:00"));
  assert.equal(s.sent.length, 0);
});

test("koppelen: na de toegangscode 'wie ben je?' met namen uit de ritten", async () => {
  const s = setup();
  const r = await s.handle({ chat: { id: 30 }, from: { first_name: "Piet" }, text: "wnt2026" });
  assert.match(r, /Welkom Piet/);
  const vraag = await s.bel.naBericht(30);
  const namen = vraag.reply_markup.inline_keyboard.map((rij) => rij[0].text);
  assert.deepEqual(namen, ["Kees Bakker", "Piet Jansen", "Ronald de Vries", "Ik rijd zelf geen ritten"]);
  assert.equal(await s.bel.naBericht(30), null); // niet nog een keer vragen
  const antwoord = await s.bel.knopGedrukt({ id: "k", data: `ikben:${PIET}`, message: { chat: { id: 30 }, message_id: 5, text: "" } });
  assert.equal(antwoord, "Gekoppeld als Piet Jansen");
  assert.equal(s.state.chats["30"].driverId, PIET);
  assert.match(s.aan(1).at(-1).text, /chat 30\) is gekoppeld als Piet Jansen/);
  // daarna krijgt hij om 17:00 zijn rit
  await s.at(om("17:00"));
  assert.match(s.aan(30).at(-1).text, /09:00  WNT-3/);
});

test("chauffeurs van vóór de belherinnering krijgen overdag één keer de koppelvraag", async () => {
  const s = setup({ chats: { "40": { toegelaten: true, naam: "Kees" } } });
  await s.at(om("07:00"));
  assert.equal(s.aan(40).length, 0); // te vroeg
  await s.at(om("09:00"));
  assert.equal(s.aan(40).length, 1);
  assert.match(s.aan(40)[0].text, /Tik op je naam/);
  await s.at(om("09:01"));
  assert.equal(s.aan(40).length, 1);
});

test("beheer: /belronde geeft vóór 17:00 een voorproef, /koppelingen de stand", async () => {
  const s = setup({ chats: structuredClone(gekoppeld) });
  const msg = (text, id = 1) => s.handle({ chat: { id }, from: { first_name: "Hans" }, text });
  const voorproef = await msg("/belronde");
  assert.match(voorproef, /Nog niet verstuurd \(dat gebeurt om 17:00\)/);
  assert.match(voorproef, /Ronald de Vries: 2 ritten/);
  assert.equal(s.sent.length, 0);
  assert.match(await msg("/koppelingen"), /Ronald \(10\): Ronald de Vries/);
  assert.match(await msg("/belronde", 10), /Zo werkt het/); // geen beheerder
});

test("BEL_HERINNERING=uit zet alles uit", async () => {
  const s = setup({ chats: structuredClone(gekoppeld), env: { BEL_HERINNERING: "uit" } });
  await s.at(om("17:00"));
  assert.equal(s.sent.length, 0);
  assert.equal(s.fetches(), 0);
});

test("chauffeursnaam herkennen in verschillende vormen", async () => {
  const { driverNaam } = await import("../src/taxiid.js");
  assert.equal(driverNaam({ firstName: "Piet", lastName: "Jansen" }), "Piet Jansen");
  assert.equal(driverNaam({ first_name: "Piet" }), "Piet");
  assert.equal(driverNaam({ fname: "Ronald", lname: "de Vries", phoneNumber: "06", companyId: "x" }), "Ronald de Vries"); // zo geeft taxiID het (24-10-2026)
  assert.equal(driverNaam({ id: "x", profile: { name: "Kees Bakker" } }), "Kees Bakker");
  assert.equal(driverNaam({ user: { givenName: "Ronald", familyName: "de Vries" } }), "Ronald de Vries");
  assert.equal(driverNaam({ company: { name: "Wilnu Taxi" }, person: { voornaam: "Han" } }), "Han");
  assert.equal(driverNaam({ activeVehicle: { name: "Mercedes" } }), null);
});

test("namen onbekend: overzicht noemt de eerste rit en niemand wordt 'gekoppeld-gevraagd'", async () => {
  const s = setup({ chats: { "1": { toegelaten: true, naam: "Hans" } } });
  s.bel; // namen weghalen
  const handleZonderNamen = s.handle;
  // taxiID geeft geen namen terug
  const { createBelronde } = await import("../src/belronde.js");
  const state = s.state;
  const bel = createBelronde({
    store: { state, save() {} },
    taxiId: {
      async getUpcomingRides() {
        return { rides: [rit("WNT-1", morgen("07:15"), RONALD), rit("WNT-2", morgen("10:00"), RONALD)], fetchedAt: Date.now(), stale: false };
      },
      async getDriver(id) {
        return { id, naam: null, velden: ["id", "activeVehicleId", "contact.label"] };
      },
      async listDrivers() {
        return null;
      },
    },
    send: async () => ({ message_id: 1 }),
    env: { BOT_BEHEER_CHAT_IDS: "1" },
    now: () => om("09:00"),
    log: { warn() {}, info() {} },
  });
  const stand = await bel.stand();
  assert.match(stand, /❓ Onbekende chauffeur \(eerste rit 07:15 WNT-1\): 2 ritten/);
  assert.match(stand, /Velden bij een chauffeur in taxiID .*activeVehicleId, contact\.label/);
  assert.equal(typeof (await bel.koppelVraag("1")), "string");
  assert.equal(state.chats["1"].koppelGevraagd, undefined); // later opnieuw proberen
  assert.ok(handleZonderNamen);
});

test("oude 'gevraagd'-markering zonder koppeling wordt eenmalig gewist", async () => {
  const s = setup({ chats: { "50": { toegelaten: true, naam: "Hans", koppelGevraagd: "2026-10-24T06:45:00Z" } } });
  delete s.state.bel.koppelVersie; // opslag van vóór deze versie
  await s.at(om("09:00"));
  assert.equal(s.aan(50).length, 1);
  assert.match(s.aan(50)[0].text, /Tik op je naam/);
  await s.at(om("09:01"));
  assert.equal(s.aan(50).length, 1);
});
