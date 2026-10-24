/**
 * Proef (ALLEEN LEZEN, verstuurt niets): wie krijgt een belherinnering en
 * met welke ritten? Laat ook zien of taxiID een chauffeurslijst geeft (voor
 * "wie ben je?" in de bot). Geen namen of telefoonnummers van passagiers.
 *
 *   npm run bellen                (morgen)
 *   npm run bellen -- 2026-10-26
 */
import "dotenv/config";
import { createTaxiIdClient } from "../src/taxiid.js";
import { rittenPerChauffeur, ritRegel } from "../src/belronde.js";
import { amsterdamYmd, addDays, dayLabel } from "../src/time.js";

const dag = /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2] ?? "") ? process.argv[2] : addDays(amsterdamYmd(Date.now()), 1);
const taxiId = createTaxiIdClient();

const lijst = await taxiId.listDrivers();
console.log(lijst ? `Chauffeurslijst uit taxiID: ${lijst.length} chauffeurs (${lijst.map((d) => d.naam ?? "?").join(", ")})` : "Chauffeurslijst uit taxiID: niet beschikbaar; de bot kiest uit de chauffeurs in de ritten.");

const { rides } = await taxiId.getUpcomingRides();
const { per, zonder } = rittenPerChauffeur(rides, dag);
console.log(`\nBelherinnering voor ${dayLabel(dag)} (${dag}):`);
if (!per.size && !zonder.length) console.log("  geen ritten");
for (const [id, items] of per) {
  const d = await taxiId.getDriver(id);
  console.log(`\n${d?.naam ?? "(naam onbekend)"}  [chauffeur-id ${id}]`);
  for (const i of items) console.log(`  ${ritRegel(i)}`);
}
if (zonder.length) {
  console.log("\nZonder chauffeur:");
  for (const i of zonder) console.log(`  ${ritRegel(i)}`);
}
