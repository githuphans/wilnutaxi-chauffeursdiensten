/**
 * Proef met AeroDataBox: zoekt één vlucht op en toont het bericht dat een
 * chauffeur bij aanmelden zou krijgen. Kost één aanroep (2 units).
 *
 *   node scripts/vlucht-proef.js KL1234 2026-10-12
 */
import "dotenv/config";
import { createAeroDataBox, chooseLeg } from "../src/flights/aerodatabox.js";
import { normalizeFlightNumber } from "../src/flights/flightNumber.js";
import { confirmationText } from "../src/flights/logic.js";
import { dayLabel } from "../src/time.js";

const flight = normalizeFlightNumber(process.argv[2] ?? "");
const date = process.argv[3];
if (!flight || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
  console.log("Gebruik: node scripts/vlucht-proef.js KL1234 2026-10-12");
  process.exit(1);
}
const res = await createAeroDataBox().getFlight(flight, date);
if (res.kind !== "found") {
  console.log(res.kind === "empty" ? "Vlucht niet gevonden." : `Fout: ${res.reason}`);
  process.exit(1);
}
const home = (process.env.THUIS_LUCHTHAVENS || "EIN,AMS,RTM,BRU,CRL,DUS,NRN,CGN,MST,LGG").split(",");
const { leg, rol } = chooseLeg(res.legs, home);
console.log(`(${res.legs.length} vluchtdeel/delen gevonden, gekozen: ${leg.from.iata} -> ${leg.to.iata}, rol: ${rol})\n`);
console.log(confirmationText({ flight, leg, rol, dagLabel: dayLabel(date), rit: null }));
