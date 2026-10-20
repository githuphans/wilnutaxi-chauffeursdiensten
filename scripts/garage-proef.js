/**
 * Proef met de ECHTE taxiID-ritten (alleen lezen): toont de inrijvolgorde
 * in de terminal, plus per voertuig-id een paar ritreferenties zodat je in
 * het taxiID-portaal kunt opzoeken welk kenteken erbij hoort.
 * Geen namen, telefoonnummers of adressen in de uitvoer.
 *
 *   node scripts/garage-proef.js               (plandag volgens de klok)
 *   node scripts/garage-proef.js 2026-10-13    (een bepaalde dag)
 */
import "dotenv/config";
import { createTaxiIdClient } from "../src/taxiid.js";
import { computeGarageOrder } from "../src/garage.js";
import { cityOf, isCanceled } from "../src/taxiid.js";
import { createRoosterBron, loadRoosterConfig, pasRoosterToe } from "../src/rooster.js";
import { planDay } from "../src/garage.js";
import { loadVehicles, resolveVehicles, loadEigenKentekens, rittenMetActieveAuto } from "../src/vehicles.js";

const day = process.argv[2];
const client = createTaxiIdClient();
const rides = await rittenMetActieveAuto((await client.getUpcomingRides()).rides, client);
let vehicles = await resolveVehicles(loadVehicles(), rides, client);
const dagVoorRooster = day ?? planDay(Date.now(), Number(process.env.GARAGE_WISSELUUR ?? 12));
const bron = createRoosterBron();
const diensten = bron.actief ? await bron.voorDag(dagVoorRooster, loadRoosterConfig(), loadEigenKentekens()) : [];
const toegepast = pasRoosterToe(vehicles, diensten);
vehicles = toegepast.vehicles;
console.log(bron.actief ? `Rooster: ${diensten.length ? diensten.map((d) => `${d.naam} ${d.kenteken}`).join(", ") : "geen diensten gevonden op deze dag"}` : "Rooster: ROOSTER_ICS_URL niet ingesteld");
for (const a of toegepast.afwijkingen) console.log(`! ${a.naam}: rooster ${a.rooster}, chauffeursapp ${a.app}`);
const r = computeGarageOrder(rides, vehicles, { nowMs: Date.now(), day, switchHour: Number(process.env.GARAGE_WISSELUUR ?? 12), eigenKentekens: loadEigenKentekens() });

console.log(`\nInrijvolgorde voor ${r.dagLabel} (${rides.length} ritten opgehaald rond nu):\n`);
console.table(
  r.inrijvolgorde.map((c) => ({
    inrijden: c.inrijden,
    plek: c.positie,
    kenteken: c.kenteken ?? "(onbekend)",
    vehicleId: c.vehicleId,
    eersteRit: c.eersteRit?.tijd ?? "geen",
    route: c.eersteRit ? `${c.eersteRit.van ?? "?"} -> ${c.eersteRit.naar ?? "?"}` : "",
    referentie: c.eersteRit?.referentie ?? "",
    ritten: c.aantalRitten,
  }))
);
for (const w of r.waarschuwingen) console.log(`! ${w}`);
if (r.andereAutos.length) console.log(`Niet in de garage (andere auto's): ${r.andereAutos.map((a) => `${a.kenteken} (${a.aantalRitten} rit${a.aantalRitten === 1 ? "" : "ten"}, eerste ${a.eersteRit})`).join(", ")}`);

// Ritten waar ook uit het adres geen plaats te halen is: toon alleen de VELDNAMEN (geen waarden).
const zonderPlaats = rides.filter((x) => !isCanceled(x) && (!cityOf(x.departure) || !cityOf(x.destination)));
if (zonderPlaats.length) {
  console.log(`\n${zonderPlaats.length} rit(ten) zonder herkenbare plaats. Veldnamen (geen waarden):`);
  for (const x of zonderPlaats.slice(0, 5)) {
    console.log(`- ${x.reference}: vertrek [${Object.keys(x.departure ?? {}).join(", ")}], aankomst [${Object.keys(x.destination ?? {}).join(", ")}]`);
  }
}
