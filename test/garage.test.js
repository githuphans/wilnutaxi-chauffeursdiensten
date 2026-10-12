import { test } from "node:test";
import assert from "node:assert/strict";
import { computeGarageOrder, planDay } from "../src/garage.js";

const V = {
  A: { kenteken: "AA-111-A", naam: "Tesla" },
  B: { kenteken: "BB-222-B", naam: "eSprinter" },
  C: { kenteken: "CC-333-C", naam: null },
  D: { kenteken: "DD-444-D", naam: null },
};
const ride = (vehicleId, iso, extra = {}) => ({ reference: `R${iso}`, requestedDate: iso, status: "assigned", vehicleId, departure: { city: "Nuenen" }, destination: { city: "Schiphol" }, ...extra });
// 11 okt 2026 21:00 NL-tijd = 19:00 UTC
const now = Date.parse("2026-10-11T19:00:00Z");

test("plandag: na 12 uur morgen, ervoor vandaag", () => {
  assert.equal(planDay(now), "2026-10-12");
  assert.equal(planDay(Date.parse("2026-10-11T23:30:00Z")), "2026-10-12"); // 01:30 NL op de 12e
});

test("vroegste rit staat bij de deur (gaat er als laatste in), auto zonder rit achteraan", () => {
  const rides = [
    ride("A", "2026-10-12T08:00:00Z"), // 10:00
    ride("A", "2026-10-12T05:00:00Z"), // 07:00 -> eerste rit van A
    ride("B", "2026-10-12T03:30:00Z"), // 05:30
    ride("C", "2026-10-12T12:00:00Z"), // 14:00
    ride("D", "2026-10-11T20:00:00Z"), // vanavond 22:00 -> telt niet voor morgen
    ride("B", "2026-10-12T02:00:00Z", { status: "canceled" }), // geannuleerd
  ];
  const r = computeGarageOrder(rides, V, { nowMs: now });
  assert.equal(r.dag, "2026-10-12");
  assert.deepEqual(r.inrijvolgorde.map((c) => c.kenteken), ["DD-444-D", "CC-333-C", "AA-111-A", "BB-222-B"]);
  assert.equal(r.inrijvolgorde[3].eersteRit.tijd, "05:30");
  assert.equal(r.inrijvolgorde[2].eersteRit.tijd, "07:00");
  assert.equal(r.inrijvolgorde[2].aantalRitten, 2);
  assert.equal(r.inrijvolgorde[0].eersteRit, null);
  assert.equal(r.waarschuwingen.length, 0);
});

test("ritten zonder auto en onbekende voertuigen geven een waarschuwing", () => {
  const rides = [ride(null, "2026-10-12T04:00:00Z"), ride("X", "2026-10-12T06:00:00Z")];
  const r = computeGarageOrder(rides, V, { nowMs: now });
  assert.equal(r.zonderAuto.length, 1);
  assert.match(r.waarschuwingen[0], /1 rit heeft nog geen auto \(eerste om 06:00\)/);
  assert.ok(r.waarschuwingen.some((w) => w.includes("Onbekend voertuig-id X")));
  assert.equal(r.inrijvolgorde.at(-1).vehicleId, "X");
});

test("geen persoonsgegevens in de uitvoer", () => {
  const rides = [ride("A", "2026-10-12T05:00:00Z", { customer: { name: "Jan Jansen", phone: "0612345678" }, departure: { city: "Nuenen", street: "Dorpsstraat 1" } })];
  const out = JSON.stringify(computeGarageOrder(rides, V, { nowMs: now }));
  assert.ok(!out.includes("Jansen") && !out.includes("0612") && !out.includes("Dorpsstraat"));
});

import { startsAtAirport } from "../src/taxiid.js";
test("luchthaven herkennen aan het vertrekpunt", () => {
  assert.equal(startsAtAirport({ departure: { name: "Eindhoven Airport" } }), true);
  assert.equal(startsAtAirport({ departure: { address: "Luchthavenweg 25", city: "Eindhoven" } }), true);
  assert.equal(startsAtAirport({ departure: { description: "Flughafen Weeze" } }), true);
  assert.equal(startsAtAirport({ departure: { address: "Heikampen 21", city: "Nuenen" } }), false);
  assert.equal(startsAtAirport({ departure: { city: "Amstelveen" } }), false);
  assert.equal(startsAtAirport({}), false);
});

import { cityOf } from "../src/taxiid.js";
test("plaatsnaam uit het adres als city ontbreekt", () => {
  assert.equal(cityOf({ city: "Nuenen" }), "Nuenen");
  assert.equal(cityOf({ city: "", address: "Zilvermeeuwhof 10, Nuenen, Nederland" }), "Nuenen");
  assert.equal(cityOf({ formattedAddress: "Torenallee 20, 5617 BC Eindhoven, Nederland" }), "Eindhoven");
  assert.equal(cityOf({ description: "Frankenlaan 5, 6419 BT Heerlen, Nederland" }), "Heerlen");
  assert.equal(cityOf({ address: "Luchthavenweg 25" }), null);
  assert.equal(cityOf(null), null);
});

test("twee voertuig-id's met hetzelfde kenteken worden één kaart", () => {
  const V2 = { G1: { kenteken: "GGZ-37-R", naam: "BYD Atto 3" }, G2: { kenteken: "GGZ-37-R", naam: "BYD Atto 3" }, N: { kenteken: "GNP-46-F", naam: null }, H: { kenteken: "GHN-49-K", naam: null } };
  const rides = [
    ride("G2", "2026-10-13T02:00:00Z"), // 04:00
    ride("G2", "2026-10-13T06:30:00Z"),
    ride("N", "2026-10-13T14:00:00Z"), // 16:00
    ride("H", "2026-10-13T11:30:00Z"), // 13:30
  ];
  const r = computeGarageOrder(rides, V2, { nowMs: Date.parse("2026-10-12T12:00:00Z") });
  assert.equal(r.inrijvolgorde.length, 3);
  assert.deepEqual(r.inrijvolgorde.map((c) => c.kenteken), ["GNP-46-F", "GHN-49-K", "GGZ-37-R"]);
  assert.equal(r.inrijvolgorde[2].eersteRit.tijd, "04:00");
  assert.equal(r.inrijvolgorde[2].aantalRitten, 2);
  assert.deepEqual(r.inrijvolgorde[2].vehicleIds.sort(), ["G1", "G2"]);
  assert.equal(r.waarschuwingen.length, 0);
});
