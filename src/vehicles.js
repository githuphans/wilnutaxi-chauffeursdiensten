import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_PATH = fileURLToPath(new URL("../config/voertuigen.json", import.meta.url));
const EIGEN_PATH = fileURLToPath(new URL("../config/eigen-autos.json", import.meta.url));

/**
 * Kentekens van de eigen auto's (alleen die horen in de garage). Uit
 * EIGEN_KENTEKENS (komma's) of anders config/eigen-autos.json. Leeg = alle auto's.
 */
export function loadEigenKentekens(env = process.env, path = EIGEN_PATH) {
  if (env.EIGEN_KENTEKENS) return env.EIGEN_KENTEKENS.split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw?.kentekens) ? raw.kentekens.map(String) : [];
  } catch {
    return [];
  }
}

/** Leest de koppeltabel vehicleId -> { kenteken, naam }. Sleutels die met "_" beginnen zijn uitleg. */
export function loadVehicles(path = process.env.VOERTUIGEN_PAD || DEFAULT_PATH) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const out = {};
  for (const [id, v] of Object.entries(raw)) {
    if (id.startsWith("_") || !v || typeof v !== "object") continue;
    out[id] = { kenteken: String(v.kenteken ?? "").trim() || null, naam: String(v.naam ?? "").trim() || null };
  }
  return out;
}

/**
 * Actuele koppeling voertuig-id -> kenteken.
 *
 * In taxiID hoort een voertuig-id bij een chauffeur; het kenteken erbij is wat
 * de chauffeur in zijn app als auto heeft gekozen en kan dus per dienst
 * wisselen (14-10-2026: Han reed eerst GGZ-37-R, daarna GHN-49-K met hetzelfde
 * id). Daarom zoeken we ELK id uit de ritten en de tabel steeds opnieuw op in
 * taxiID (kort gecachet). De tabel is alleen nog reserve als taxiID geen
 * antwoord geeft, en levert de nette naam per kenteken (bv. "Toyota bZ4X").
 */
export async function resolveVehicles(table, rides, taxiId) {
  const norm = (k) => String(k ?? "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const naamPerKenteken = new Map();
  for (const v of Object.values(table)) if (v?.kenteken && v.naam) naamPerKenteken.set(norm(v.kenteken), v.naam);

  const ids = new Set(Object.keys(table));
  for (const r of rides) {
    if (r?.vehicleId && !String(r.status ?? "").toLowerCase().includes("cancel")) ids.add(r.vehicleId);
  }
  const out = {};
  const found = taxiId?.getVehicle ? await Promise.all([...ids].map((id) => taxiId.getVehicle(id).then((v) => [id, v]))) : [...ids].map((id) => [id, null]);
  for (const [id, v] of found) {
    const kenteken = v?.kenteken ?? table[id]?.kenteken ?? null;
    if (!kenteken) continue;
    out[id] = { kenteken, naam: naamPerKenteken.get(norm(kenteken)) ?? v?.naam ?? table[id]?.naam ?? null, bron: v ? "taxiid" : "tabel" };
  }
  return out;
}
