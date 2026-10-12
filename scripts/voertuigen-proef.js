/**
 * Proef (ALLEEN LEZEN): geeft taxiID een lijst met voertuigen, met kenteken?
 * Probeert een paar gangbare adressen en toont per voertuig alleen het id,
 * het kenteken en de VELDNAMEN -- geen chauffeursnamen of andere gegevens.
 *
 *   node scripts/voertuigen-proef.js
 */
import "dotenv/config";

const apiKey = process.env.TAXIID_PROD_API_KEY;
const baseUrl = (process.env.TAXIID_PROD_BASE_URL || "https://api.dispatchapi.io/api").replace(/\/$/, "");
const companyId = process.env.TAXIID_COMPANY_ID || "5e76134226a257e34bd9bb17";
const ids = ["689a0b9b21ba4294ebdc1c39", "689a0f7521ba4294ebdc1c7e", "68c9fa1ca0b35e67cd36a5f9", "68cbe04a78c853f526bbdded"];

const paden = [
  `/companies/${companyId}/vehicles`,
  `/companies/${companyId}/fleet`,
  `/vehicles?filter=${encodeURIComponent(JSON.stringify({ where: { companyId } }))}`,
  `/vehicles/${ids[0]}`,
  `/companies/${companyId}/vehicles/${ids[0]}`,
];

const plate = (v) => v?.formattedLicensePlate || v?.licensePlate || v?.plate || v?.registration || null;

for (const pad of paden) {
  const kort = pad.split("?")[0].replace(companyId, "<bedrijf>");
  try {
    const res = await fetch(`${baseUrl}${pad}`, { headers: { Authorization: apiKey, "Content-Type": "application/json" } });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      console.log(`${kort}: HTTP ${res.status}`);
      continue;
    }
    const list = Array.isArray(body) ? body : body?.data ? body.data : [body];
    console.log(`\n${kort}: HTTP ${res.status}, ${list.length} voertuig(en)`);
    if (list[0]) console.log(`  veldnamen: ${Object.keys(list[0]).sort().join(", ")}`);
    for (const v of list.slice(0, 20)) console.log(`  ${v?.id ?? v?._id ?? "?"}  kenteken: ${plate(v) ?? "(geen)"}`);
  } catch (err) {
    console.log(`${kort}: fout (${err.message})`);
  }
}
