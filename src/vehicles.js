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
 * Vult de koppeltabel aan met voertuigen die wel in de ritten staan maar niet
 * (of zonder kenteken) in de tabel: die worden in taxiID opgezocht.
 * De tabel gaat voor (eigen naam/kenteken); taxiID vult aan wat ontbreekt.
 */
export async function resolveVehicles(table, rides, taxiId) {
  const out = { ...table };
  const ids = new Set();
  for (const r of rides) {
    if (r?.vehicleId && !String(r.status ?? "").toLowerCase().includes("cancel")) ids.add(r.vehicleId);
  }
  const missing = [...ids].filter((id) => !out[id]?.kenteken);
  if (!missing.length || !taxiId?.getVehicle) return out;
  const found = await Promise.all(missing.map((id) => taxiId.getVehicle(id).then((v) => [id, v])));
  for (const [id, v] of found) {
    if (v) out[id] = { kenteken: v.kenteken, naam: out[id]?.naam || v.naam || null };
  }
  return out;
}
