import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_PATH = fileURLToPath(new URL("../config/voertuigen.json", import.meta.url));

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
