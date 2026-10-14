import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFlightNumber, extractFlightNumber, extractDate } from "../src/flights/flightNumber.js";
import { detectEvents, nextCheckAt, classify } from "../src/flights/logic.js";
import { chooseLeg, mapLeg } from "../src/flights/aerodatabox.js";

test("vluchtnummers normaliseren", () => {
  assert.equal(normalizeFlightNumber("hv6474"), "HV6474");
  assert.equal(normalizeFlightNumber("FR 1718"), "FR1718");
  assert.equal(normalizeFlightNumber("OS 7"), "OS7");
  assert.equal(normalizeFlightNumber("KL-0123"), "KL123");
  assert.equal(normalizeFlightNumber("u2 1234"), "U21234");
  assert.equal(normalizeFlightNumber("TRA6474"), "TRA6474");
  assert.equal(normalizeFlightNumber("Schiphol"), null);
  assert.equal(normalizeFlightNumber(""), null);
});

test("vluchtnummer en datum uit een bericht halen", () => {
  assert.equal(extractFlightNumber("ik heb morgen fr 1718"), "FR1718");
  assert.equal(extractFlightNumber("KL1234 13-10"), "KL1234");
  assert.equal(extractFlightNumber("13-10"), null);
  assert.equal(extractFlightNumber("hallo"), null);
  assert.equal(extractDate("KL1234 morgen", "2026-10-11"), "2026-10-12");
  assert.equal(extractDate("KL1234 13-10", "2026-10-11"), "2026-10-13");
  assert.equal(extractDate("KL1234 2026-10-14", "2026-10-11"), "2026-10-14");
  assert.equal(extractDate("KL1234 2-1", "2026-12-30"), "2027-01-02");
  assert.equal(extractDate("KL1234", "2026-10-11"), null);
});

const raw = (over = {}) => ({
  number: "KL 1234",
  status: "Expected",
  airline: { name: "KLM" },
  departure: { airport: { iata: "BCN", municipalityName: "Barcelona" }, scheduledTime: { utc: "2026-10-12 07:10Z" } },
  arrival: { airport: { iata: "EIN", municipalityName: "Eindhoven" }, scheduledTime: { utc: "2026-10-12 09:25Z" } },
  ...over,
});

test("juiste vluchtdeel kiezen (aankomst op thuisluchthaven)", () => {
  const legs = [
    mapLeg({ ...raw(), arrival: { airport: { iata: "BCN" } }, departure: { airport: { iata: "LIS" } } }),
    mapLeg(raw()),
  ];
  const c = chooseLeg(legs, ["EIN", "AMS"]);
  assert.equal(c.rol, "aankomst");
  assert.equal(c.leg.to.iata, "EIN");
  const out = chooseLeg([mapLeg({ ...raw(), departure: { airport: { iata: "EIN" } }, arrival: { airport: { iata: "PMI" } } })], ["EIN"]);
  assert.equal(out.rol, "vertrek");
});

test("meldingen: vertraging, opgestegen, nieuwe ETA, geland -- elk één keer", () => {
  let notified = { lastEta: "2026-10-12T09:25:00.000Z" };
  const run = (r) => {
    const ev = detectEvents({ flight: "KL1234", leg: mapLeg(r), rol: "aankomst", notified });
    notified = ev.notified;
    return ev;
  };
  let ev = run(raw({ departure: { ...raw().departure, revisedTime: { utc: "2026-10-12 07:50Z" } }, arrival: { ...raw().arrival, predictedTime: { utc: "2026-10-12 10:00Z" } } }));
  assert.equal(ev.messages.length, 1);
  assert.match(ev.messages[0], /vertrekt later: verwacht 09:50 in plaats van 09:10 \(\+40 min\)/);
  assert.equal(run(raw({ departure: { ...raw().departure, revisedTime: { utc: "2026-10-12 07:52Z" } }, arrival: { ...raw().arrival, predictedTime: { utc: "2026-10-12 10:02Z" } } })).messages.length, 0);

  ev = run(raw({ status: "EnRoute", departure: { ...raw().departure, runwayTime: { utc: "2026-10-12 07:55Z" } }, arrival: { ...raw().arrival, predictedTime: { utc: "2026-10-12 10:05Z" } } }));
  assert.equal(ev.messages.length, 1);
  assert.match(ev.messages[0], /opgestegen om 09:55 uit Barcelona.*12:05/);

  ev = run(raw({ status: "EnRoute", departure: { ...raw().departure, runwayTime: { utc: "2026-10-12 07:55Z" } }, arrival: { ...raw().arrival, predictedTime: { utc: "2026-10-12 09:50Z" } } }));
  assert.match(ev.messages[0], /nieuwe verwachte aankomst 11:50 \(was 12:05; gepland 11:25\)/);

  ev = run(raw({ status: "Arrived", arrival: { ...raw().arrival, runwayTime: { utc: "2026-10-12 09:48Z" }, baggageBelt: "3" } }));
  assert.match(ev.messages[0], /geland om 11:48 in Eindhoven\. Bagageband 3\./);
  assert.equal(ev.done, true);
  assert.equal(run(raw({ status: "Arrived" })).messages.length, 0);
});

test("annulering wordt gemeld en stopt het volgen", () => {
  const ev = detectEvents({ flight: "FR1718", leg: mapLeg(raw({ status: "Canceled" })), rol: "aankomst", notified: {} });
  assert.match(ev.messages[0], /GEANNULEERD/);
  assert.equal(ev.done, true);
});

test("pollschema: zuinig ver voor vertrek, 's nachts stil, vaak vlak voor landing", () => {
  const leg = mapLeg(raw()); // vertrek 09:10, aankomst 11:25 NL-tijd
  const MIN = 60000;
  // 21:00 de avond ervoor -> volgende controle 06:00 (nachtrust), niet om 00:00
  const t1 = nextCheckAt({ leg, nowMs: Date.parse("2026-10-11T19:00:00Z") });
  assert.equal(new Date(t1).toISOString(), "2026-10-12T04:00:00.000Z");
  // 08:00 (ruim 1 uur voor vertrek) -> 30 min
  const t2 = nextCheckAt({ leg, nowMs: Date.parse("2026-10-12T06:00:00Z") });
  assert.equal(t2 - Date.parse("2026-10-12T06:00:00Z"), 30 * MIN);
  // in de lucht, 1 uur 50 voor landing -> eerst naar 1 uur voor landing (max 45 min)
  const inAir = mapLeg(raw({ status: "EnRoute" }));
  const t3 = nextCheckAt({ leg: inAir, nowMs: Date.parse("2026-10-12T07:35:00Z") });
  assert.equal(t3 - Date.parse("2026-10-12T07:35:00Z"), 45 * MIN);
  // laatste uur -> elke 10 min
  const t4 = nextCheckAt({ leg: inAir, nowMs: Date.parse("2026-10-12T09:00:00Z") });
  assert.equal(t4 - Date.parse("2026-10-12T09:00:00Z"), 10 * MIN);
  // 9 uur na geplande aankomst -> opgeven
  assert.equal(nextCheckAt({ leg: inAir, nowMs: Date.parse("2026-10-12T18:30:00Z") }), null);
  assert.equal(classify(inAir).departed, true);
});

test("landing met een tijd 13 minuten in de toekomst telt niet (KL682, 14-10)", () => {
  const leg = mapLeg({
    number: "KL 682", status: "Arrived", airline: { name: "KLM" },
    departure: { airport: { iata: "YVR", municipalityName: "Vancouver" }, scheduledTime: { utc: "2026-10-14 00:50Z" }, runwayTime: { utc: "2026-10-14 01:28Z" } },
    arrival: { airport: { iata: "AMS", municipalityName: "Amsterdam" }, scheduledTime: { utc: "2026-10-14 10:05Z" }, runwayTime: { utc: "2026-10-14 09:52Z" } },
  });
  const vroeg = detectEvents({ flight: "KL682", leg, rol: "aankomst", notified: { departed: true }, nowMs: Date.parse("2026-10-14T09:39:00Z") });
  assert.ok(!vroeg.messages.some((m) => /geland/.test(m)));
  assert.equal(vroeg.done, false);
  const op_tijd = detectEvents({ flight: "KL682", leg, rol: "aankomst", notified: { departed: true }, nowMs: Date.parse("2026-10-14T09:53:00Z") });
  assert.ok(op_tijd.messages.some((m) => /geland om 11:52/.test(m)));
});
