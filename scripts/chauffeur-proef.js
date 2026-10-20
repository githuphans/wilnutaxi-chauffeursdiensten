/**
 * Proef (ALLEEN LEZEN): staat de actuele auto bij de CHAUFFEUR in taxiID?
 * Per rit van de dag wordt de chauffeur (driverId) opgezocht. Getoond worden
 * alleen veldnamen en de waarden van velden over voertuig/kenteken -- geen
 * namen, telefoonnummers of adressen.
 *
 *   node scripts/chauffeur-proef.js 2026-10-21
 */
import "dotenv/config";
import { createTaxiIdClient, isCanceled } from "../src/taxiid.js";
import { amsterdamYmd } from "../src/rooster.js";

const apiKey = process.env.TAXIID_PROD_API_KEY;
const baseUrl = (process.env.TAXIID_PROD_BASE_URL || "https://api.dispatchapi.io/api").replace(/\/$/, "");
const companyId = process.env.TAXIID_COMPANY_ID || "5e76134226a257e34bd9bb17";
const dag = process.argv[2] ?? amsterdamYmd(Date.now() + 86400000);

const client = createTaxiIdClient();
const { rides } = await client.getUpcomingRides();
const lijst = rides.filter((r) => !isCanceled(r) && amsterdamYmd(Date.parse(r.requestedDate)) === dag);

const VOERTUIG = /vehicle|plate|car|kenteken|taxi/i;
function voertuigVelden(obj, pad = "", diepte = 0, uit = []) {
  if (!obj || typeof obj !== "object" || diepte > 2) return uit;
  for (const [k, v] of Object.entries(obj)) {
    const p = pad ? `${pad}.${k}` : k;
    if (VOERTUIG.test(k) && (typeof v === "string" || typeof v === "number")) uit.push(`${p}=${v}`);
    else if (VOERTUIG.test(k) && v && typeof v === "object") voertuigVelden(v, p, diepte + 1, uit);
  }
  return uit;
}

async function get(pad) {
  try {
    const res = await fetch(`${baseUrl}${pad}`, { headers: { Authorization: apiKey, "Content-Type": "application/json" } });
    return { status: res.status, body: res.ok ? await res.json().catch(() => null) : null };
  } catch (err) {
    return { status: `fout (${err.message})`, body: null };
  }
}

const gezien = new Set();
for (const r of lijst.sort((a, b) => Date.parse(a.requestedDate) - Date.parse(b.requestedDate))) {
  const tijd = new Date(r.requestedDate).toLocaleTimeString("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit" });
  console.log(`\n${tijd}  rit ${r.reference}  voertuig-id ${r.vehicleId}  chauffeur-id ${r.driverId ?? "(geen)"}`);
  if (!r.driverId || gezien.has(r.driverId)) continue;
  gezien.add(r.driverId);
  for (const pad of [`/drivers/${r.driverId}`, `/companies/${companyId}/drivers/${r.driverId}`]) {
    const { status, body } = await get(pad);
    const kort = pad.replace(companyId, "<bedrijf>").replace(r.driverId, "<chauffeur>");
    if (!body) {
      console.log(`  ${kort}: HTTP ${status}`);
      continue;
    }
    console.log(`  ${kort}: HTTP ${status}`);
    console.log(`    veldnamen: ${Object.keys(body).sort().join(", ")}`);
    const velden = voertuigVelden(body);
    console.log(`    voertuigvelden: ${velden.length ? velden.join(", ") : "(geen)"}`);
    for (const id of velden.map((v) => v.split("=")[1]).filter((v) => /^[0-9a-f]{24}$/i.test(v))) {
      const veh = await client.getVehicle(id);
      console.log(`    -> voertuig ${id}: ${veh?.kenteken ?? "(niet gevonden)"}`);
    }
    break;
  }
}
