/**
 * Proef (ALLEEN LEZEN): per rit van een dag welk voertuig-id erbij staat,
 * welk kenteken taxiID NU bij dat id geeft, en welke kentekenachtige waarden
 * in de rit zelf staan (bv. het kenteken dat bij het toewijzen is vastgelegd).
 * Geen namen, telefoonnummers of adressen in de uitvoer.
 *
 *   node scripts/rit-proef.js 2026-10-21
 */
import "dotenv/config";
import { createTaxiIdClient, isCanceled } from "../src/taxiid.js";
import { amsterdamYmd } from "../src/rooster.js";

const dag = process.argv[2] ?? amsterdamYmd(Date.now() + 86400000);
const client = createTaxiIdClient();
const { rides } = await client.getUpcomingRides();
const vandaag = rides.filter((r) => !isCanceled(r) && amsterdamYmd(Date.parse(r.requestedDate)) === dag);

// Alleen waarden die op een kenteken/code lijken: letters én cijfers, geen spaties of +.
const lijktKenteken = (s) => typeof s === "string" && /^[A-Z0-9-]{5,10}$/i.test(s) && /[A-Z]/i.test(s) && /\d/.test(s) && !/^[0-9a-f]{24}$/i.test(s);
function kentekenVelden(obj, pad = "", diepte = 0, uit = []) {
  if (!obj || typeof obj !== "object" || diepte > 3) return uit;
  for (const [k, v] of Object.entries(obj)) {
    if (/customer|passenger|klant|debtor|contact|phone|email|departure|destination|address/i.test(k)) continue;
    const p = pad ? `${pad}.${k}` : k;
    if (lijktKenteken(v)) uit.push(`${p}=${v}`);
    else if (typeof v === "object") kentekenVelden(v, p, diepte + 1, uit);
  }
  return uit;
}

console.log(`${vandaag.length} ritten op ${dag}\n`);
const ids = [...new Set(vandaag.map((r) => r.vehicleId).filter(Boolean))];
const live = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, (await client.getVehicle(id))?.kenteken ?? "(niet gevonden)"])));
for (const r of vandaag.sort((a, b) => Date.parse(a.requestedDate) - Date.parse(b.requestedDate))) {
  const tijd = new Date(r.requestedDate).toLocaleTimeString("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit" });
  console.log(`${tijd}  rit ${r.reference}  voertuig-id ${r.vehicleId ?? "(geen)"}  -> nu in taxiID: ${live[r.vehicleId] ?? "-"}`);
  const velden = kentekenVelden(r);
  console.log(`        in de rit zelf: ${velden.length ? velden.join(", ") : "(geen kentekenvelden)"}`);
  console.log(`        veldnamen met vehicle/driver/taxi: ${Object.keys(r).filter((k) => /vehicle|driver|taxi|car|plate/i.test(k)).join(", ") || "-"}`);
}
