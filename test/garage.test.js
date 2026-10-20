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
  assert.ok(r.waarschuwingen.some((w) => w.includes("voertuig-id X niet gevonden")));
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

import { resolveVehicles } from "../src/vehicles.js";
import { createTaxiIdClient } from "../src/taxiid.js";
test("onbekend voertuig-id wordt in taxiID opgezocht (en gecachet)", async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    assert.match(url, /\/vehicles\/(NEW|OLD)$/);
    return { ok: true, status: 200, json: async () => ({ id: "NEW", licensePlate: "ggz-37-r", brand: "BYD", model: "Atto 3", driverId: "geheim" }) };
  };
  const client = createTaxiIdClient({ apiKey: "x", fetchImpl, log: { warn() {} } });
  const table = { OLD: { kenteken: "GGZ-37-R", naam: "BYD Atto 3" } };
  const rides = [{ vehicleId: "NEW", status: "assigned" }, { vehicleId: "OLD", status: "assigned" }, { vehicleId: "GONE", status: "canceled" }];
  const v = await resolveVehicles(table, rides, client);
  assert.equal(v.NEW.kenteken, "GGZ-37-R");
  assert.equal(v.NEW.naam, "BYD Atto 3");
  assert.ok(!JSON.stringify(v).includes("geheim"));
  assert.equal(v.GONE, undefined);
  await resolveVehicles(table, rides, client);
  assert.equal(calls, 2); // NEW en OLD één keer opgezocht, daarna uit de cache
});

test("alleen eigen auto's in de garage; andere auto's apart vermeld", () => {
  const V3 = { G: { kenteken: "GGZ-37-R", naam: null }, H: { kenteken: "GHN-49-K", naam: null }, N: { kenteken: "GNP-46-F", naam: null }, Z: { kenteken: "ZD792B", naam: "Bmw 3 gt" } };
  const rides = [ride("G", "2026-10-14T07:10:00Z"), ride("H", "2026-10-14T11:00:00Z"), ride("Z", "2026-10-14T10:00:00Z"), ride("Z", "2026-10-14T12:00:00Z")];
  const r = computeGarageOrder(rides, V3, { nowMs: Date.parse("2026-10-13T11:00:00Z"), eigenKentekens: ["GGZ37R", "ghn-49-k", "GNP-46-F"] });
  assert.deepEqual(r.inrijvolgorde.map((c) => c.kenteken), ["GNP-46-F", "GHN-49-K", "GGZ-37-R"]);
  assert.deepEqual(r.andereAutos, [{ kenteken: "ZD792B", aantalRitten: 2, eersteRit: "12:00" }]);
  // zonder lijst: alle auto's (oude gedrag)
  assert.equal(computeGarageOrder(rides, V3, { nowMs: Date.parse("2026-10-13T11:00:00Z") }).inrijvolgorde.length, 4);
});

test("kenteken komt actueel uit taxiID, ook als de tabel iets anders zegt (chauffeur wisselde van auto)", async () => {
  const table = {
    HAN: { kenteken: "GGZ-37-R", naam: "BYD Atto 3" }, // zo stond het op 13-10
    RON: { kenteken: "GHN-49-K", naam: "BYD Atto 3" },
    HANS: { kenteken: "GNP-46-F", naam: "Toyota bZ4X" },
  };
  const huidig = { HAN: "GHN-49-K", RON: "GHN-49-K", HANS: "GNP-46-F" };
  const taxiId = { getVehicle: async (id) => ({ kenteken: huidig[id], naam: "BYD Atto 3" }) };
  const rides = [ride("HAN", "2026-10-15T02:25:00Z"), ride("RON", "2026-10-15T10:50:00Z"), ride("HANS", "2026-10-15T02:00:00Z")];
  const v = await resolveVehicles(table, rides, taxiId);
  assert.equal(v.HAN.kenteken, "GHN-49-K");
  const r = computeGarageOrder(rides, v, { nowMs: Date.parse("2026-10-14T15:55:00Z"), eigenKentekens: ["GGZ-37-R", "GHN-49-K", "GNP-46-F"] });
  // GGZ-37-R heeft geen rit meer maar blijft als eigen auto in de rij (achteraan)
  assert.deepEqual(r.inrijvolgorde.map((c) => c.kenteken), ["GGZ-37-R", "GHN-49-K", "GNP-46-F"]);
  assert.equal(r.inrijvolgorde[1].eersteRit.tijd, "04:25");
  assert.equal(r.inrijvolgorde[1].aantalRitten, 2);
  assert.equal(r.inrijvolgorde[0].eersteRit, null);
});

test("geeft taxiID geen antwoord, dan geldt de tabel", async () => {
  const v = await resolveVehicles({ A: { kenteken: "GGZ-37-R", naam: "BYD Atto 3" } }, [ride("A", "2026-10-15T02:25:00Z")], { getVehicle: async () => null });
  assert.equal(v.A.kenteken, "GGZ-37-R");
});

test("waarschuwing als één auto bij twee chauffeurs met ritten staat", () => {
  const v = { HAN: { kenteken: "GHN-49-K", naam: null }, RON: { kenteken: "GHN-49-K", naam: null } };
  const rides = [ride("HAN", "2026-10-15T02:25:00Z"), ride("RON", "2026-10-15T10:50:00Z")];
  const r = computeGarageOrder(rides, v, { nowMs: Date.parse("2026-10-14T15:55:00Z") });
  assert.ok(r.waarschuwingen.some((w) => /GHN-49-K staat bij 2 chauffeurs/.test(w)));
});

test("kenteken in vaste schrijfwijze en luchthaven als plaatsnaam", () => {
  const v = { R: { kenteken: "GHN49K", naam: "BYD Atto 3" } };
  const rides = [ride("R", "2026-10-15T02:25:00Z", { departure: { city: "Nuenen" }, destination: { internationalAlias: "Eindhoven Airport", gps: { lat: 51.45, lng: 5.37 } } })];
  const r = computeGarageOrder(rides, v, { nowMs: Date.parse("2026-10-14T16:00:00Z"), eigenKentekens: ["GHN-49-K"] });
  assert.equal(r.inrijvolgorde[0].kenteken, "GHN-49-K");
  assert.equal(r.inrijvolgorde[0].eersteRit.naar, "Eindhoven Airport");
});

import { rittenMetActieveAuto } from "../src/vehicles.js";
import { pasRoosterToe } from "../src/rooster.js";
test("auto via de chauffeur (activeVehicleId), niet via het achterlopende id in de rit (20-10-2026)", async () => {
  // Zoals 21-10-2026: rit van Han (04:30) en drie ritten van Ronald (13:30, 16:30, 22:10).
  const rides = [
    ride("RIT_HAN", "2026-10-21T02:30:00Z", { driverId: "D_HAN" }),
    ride("RIT_OUD", "2026-10-21T11:30:00Z", { driverId: "D_RON" }),
    ride("RIT_OUD", "2026-10-21T14:30:00Z", { driverId: "D_RON" }),
    ride("RIT_OUD", "2026-10-21T20:10:00Z", { driverId: "D_RON" }),
  ];
  const actief = { D_HAN: "HAN", D_RON: "RON" };
  const plaat = { RIT_HAN: "GHN-49-K", RIT_OUD: "GNP-46-F", HAN: "GGZ-37-R", RON: "GHN49K" };
  const taxiId = { getActiveVehicleId: async (d) => actief[d], getVehicle: async (id) => ({ kenteken: plaat[id], naam: null }) };
  const metAuto = await rittenMetActieveAuto(rides, taxiId);
  assert.equal(metAuto[1].vehicleId, "RON");
  assert.equal(rides[1].vehicleId, "RIT_OUD"); // origineel onveranderd
  const v = await resolveVehicles({}, metAuto, taxiId);
  // rooster: Han rijdt woensdag de GHN-49-K
  const { vehicles } = pasRoosterToe(v, [{ naam: "Han", kenteken: "GHN-49-K", voertuigIds: ["HAN"] }]);
  const r = computeGarageOrder(metAuto, vehicles, { nowMs: Date.parse("2026-10-20T15:15:00Z"), eigenKentekens: ["GGZ-37-R", "GHN-49-K", "GNP-46-F"] });
  const ghn = r.inrijvolgorde.find((c) => c.kenteken === "GHN-49-K");
  assert.equal(ghn.aantalRitten, 4);
  assert.equal(ghn.eersteRit.tijd, "04:30");
  assert.equal(r.inrijvolgorde.find((c) => c.kenteken === "GNP-46-F").aantalRitten, 0);
});

test("zonder antwoord over de chauffeur blijft het id uit de rit", async () => {
  const rides = [ride("A", "2026-10-21T02:30:00Z", { driverId: "D" })];
  const out = await rittenMetActieveAuto(rides, { getActiveVehicleId: async () => null });
  assert.equal(out[0].vehicleId, "A");
});
