import { test } from "node:test";
import assert from "node:assert/strict";
import { createTracker } from "../src/flights/tracker.js";
import { createBotHandler } from "../src/telegram.js";
import { emptyState } from "../src/store.js";

function setup({ legsByCall } = {}) {
  const state = emptyState();
  const store = { state, save() {}, kind: "test" };
  const calls = [];
  let i = 0;
  const api = {
    async getFlight(flight, date) {
      calls.push(`${flight}|${date}`);
      const legs = legsByCall?.[Math.min(i++, legsByCall.length - 1)];
      return legs ? { kind: "found", legs } : { kind: "empty" };
    },
  };
  const taxiId = {
    async getUpcomingRides() {
      return {
        rides: [
          { reference: "WNT-77", requestedDate: "2026-10-12T10:00:00Z", status: "assigned", flightNumber: "kl 1234", departure: { city: "Eindhoven", name: "Eindhoven Airport" }, destination: { city: "Nuenen" }, customer: { name: "Geheim" } },
          { reference: "WNT-88", requestedDate: "2026-10-12T05:00:00Z", status: "assigned", flightNumber: "FR 1718", departure: { city: "Nuenen", address: "Dorpsstraat 1" }, destination: { city: "Eindhoven", name: "Eindhoven Airport" } },
        ],
      };
    },
  };
  const sent = [];
  const env = { BOT_TOEGANGSCODE: "wnt2026", FLIGHT_DAILY_UNITS: "10", AERODATABOX_UNITS_PER_CALL: "2", BOT_BEHEER_CHAT_IDS: "1" };
  const tracker = createTracker({ store, api, taxiId, send: async (c, t) => sent.push([c, t]), env, log: { warn() {}, info() {} } });
  let now = Date.parse("2026-10-11T19:00:00Z");
  const handle = createBotHandler({ store, tracker, env, now: () => now });
  const msg = (text, id = 42) => handle({ chat: { id }, from: { first_name: "Piet" }, text });
  return { state, calls, sent, tracker, msg, setNow: (t) => (now = t) };
}

const leg = (over = {}) => ({
  number: "KL 1234", airline: "KLM", status: "Expected",
  from: { iata: "BCN", city: "Barcelona" }, to: { iata: "EIN", city: "Eindhoven" },
  dep: { scheduled: "2026-10-12T07:10:00.000Z", estimated: null, actual: null },
  arr: { scheduled: "2026-10-12T09:25:00.000Z", estimated: null, actual: null, terminal: null, gate: null, belt: null },
  ...over,
});

test("zonder toegangscode geen toegang; met code wel", async () => {
  const s = setup();
  assert.match(await s.msg("KL1234"), /toegangscode/);
  assert.equal(s.calls.length, 0);
  assert.match(await s.msg("/start wnt2026"), /Welkom Piet/);
});

test("aanmelden koppelt aan taxiID-rit, zonder klantnaam, en meldt later de landing", async () => {
  const s = setup({ legsByCall: [[leg()], [leg({ status: "EnRoute", dep: { ...leg().dep, actual: "2026-10-12T07:20:00.000Z" } })], [leg({ status: "Arrived", arr: { ...leg().arr, actual: "2026-10-12T09:30:00.000Z" } })]] });
  await s.msg("wnt2026");
  const reply = await s.msg("kl1234");
  assert.match(reply, /KL1234 \(KLM\): Barcelona → Eindhoven, maandag 12 oktober/);
  assert.match(reply, /Gekoppeld aan rit WNT-77 om 12:00 \(Eindhoven → Nuenen\)/);
  assert.ok(!reply.includes("Geheim"));
  assert.deepEqual(s.calls, ["KL1234|2026-10-12"]);

  // tweede chauffeur op dezelfde vlucht: geen extra aanroep
  await s.msg("wnt2026", 43);
  await s.msg("KL 1234 morgen", 43);
  assert.equal(s.calls.length, 1);

  await s.tracker.tick(Date.parse("2026-10-12T07:30:00Z"));
  assert.equal(s.sent.length, 2); // beide chauffeurs
  assert.match(s.sent[0][1], /opgestegen om 09:20/);
  await s.tracker.tick(Date.parse("2026-10-12T09:40:00Z"));
  assert.match(s.sent.at(-1)[1], /geland om 11:30/);
  // daarna geen controles meer
  const n = s.calls.length;
  await s.tracker.tick(Date.parse("2026-10-12T10:40:00Z"));
  assert.equal(s.calls.length, n);
  assert.match(await s.msg("/mijn"), /geland/);
});

test("dagbudget wordt bewaakt", async () => {
  const s = setup({ legsByCall: [[leg()]] });
  await s.msg("wnt2026");
  for (const f of ["KL1", "KL2", "KL3", "KL4", "KL5"]) await s.msg(`${f} morgen`);
  const r = await s.msg("KL6 morgen");
  assert.match(r, /budget/);
  assert.equal(s.calls.length, 5);
});

test("onbekende vlucht en stoppen", async () => {
  const s = setup({ legsByCall: [null] });
  await s.msg("wnt2026");
  assert.match(await s.msg("XY999 13-10"), /vind vlucht XY999 niet/);
  assert.match(await s.msg("/stop"), /geen vluchten/);
});

test("rit die niet op een luchthaven begint: geen updates en geen aanroep", async () => {
  const s = setup({ legsByCall: [[leg()]] });
  await s.msg("wnt2026");
  assert.match(await s.msg("FR1718"), /WNT-88 om 07:00 .* begint niet op een luchthaven/);
  assert.equal(s.calls.length, 0);
});

test("vlucht die vertrekt vanaf onze luchthaven wordt niet gevolgd", async () => {
  const out = leg({ from: { iata: "EIN", city: "Eindhoven" }, to: { iata: "PMI", city: "Palma" } });
  const s = setup({ legsByCall: [[out]] });
  await s.msg("wnt2026");
  assert.match(await s.msg("HV5000 morgen"), /landt niet op een luchthaven waar wij ophalen \(EIN → PMI\)/);
  assert.equal(s.state.subscriptions.length, 0);
});

// Herhaling van 13-10-2026: aangemeld voor HV6216 op de 13e; om 06:00 stuurde
// AeroDataBox (ook) de vlucht van de 12e mee, die al geland was.
const hv = (day, over = {}) => ({
  number: "HV 6216", airline: "Transavia", status: "Expected",
  from: { iata: "TFS", city: "Tenerife Island" }, to: { iata: "EIN", city: "Eindhoven" },
  dep: { scheduled: `2026-10-${day}T10:25:00.000Z`, estimated: null, actual: null },
  arr: { scheduled: `2026-10-${day}T14:45:00.000Z`, estimated: null, actual: null, terminal: null, gate: null, belt: null },
  ...over,
});

test("vlucht van een andere dag in het antwoord wordt genegeerd", async () => {
  const gisteren = hv("12", { status: "Arrived", dep: { ...hv("12").dep, actual: "2026-10-12T10:30:00.000Z" }, arr: { ...hv("12").arr, actual: "2026-10-12T14:31:00.000Z" } });
  const s = setup({ legsByCall: [[hv("13")], [gisteren, hv("13")], [gisteren]] });
  s.setNow(Date.parse("2026-10-12T17:22:00Z"));
  await s.msg("wnt2026");
  assert.match(await s.msg("HV6216 13-10"), /volgens schema/);
  await s.tracker.tick(Date.parse("2026-10-13T04:00:00Z")); // 06:00: beide dagen in het antwoord
  assert.equal(s.sent.length, 0);
  await s.tracker.tick(Date.parse("2026-10-13T08:30:00Z")); // alleen gisteren in het antwoord
  assert.equal(s.sent.length, 0);
});

test("status 'Arrived' met tijden in de toekomst telt niet als geland", async () => {
  const nep = hv("13", { status: "Arrived", arr: { ...hv("13").arr, estimated: "2026-10-13T14:31:00.000Z" } });
  const s = setup({ legsByCall: [[hv("13")], [nep]] });
  s.setNow(Date.parse("2026-10-12T17:22:00Z"));
  await s.msg("wnt2026");
  await s.msg("HV6216 13-10");
  await s.tracker.tick(Date.parse("2026-10-13T04:00:00Z"));
  assert.ok(!s.sent.some(([, t]) => /geland|opgestegen/.test(t)));
});

test("eerder onterecht gemelde landing wordt hersteld en het volgen gaat door", async () => {
  const s = setup({ legsByCall: [[hv("13")]] });
  s.setNow(Date.parse("2026-10-12T17:22:00Z"));
  await s.msg("wnt2026");
  await s.msg("HV6216 13-10");
  // zoals de opgeslagen stand na de foute melding van 06:00
  const fs = s.state.flights["HV6216|2026-10-13"];
  fs.leg = hv("12", { status: "Arrived", arr: { ...hv("12").arr, actual: "2026-10-12T14:31:00.000Z" } });
  fs.notified = { departed: true, landed: true };
  fs.done = true;
  fs.doneAt = Date.parse("2026-10-13T04:00:00Z");
  await s.tracker.tick(Date.parse("2026-10-13T06:50:00Z"));
  assert.match(s.sent[0][1], /Correctie/);
  assert.equal(fs.done, false);
  assert.equal(fs.leg.dep.scheduled, "2026-10-13T10:25:00.000Z");
});
