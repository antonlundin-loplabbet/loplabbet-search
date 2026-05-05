/**
 * import-synonyms.mjs
 * Importerar synonymer till Typesense Cloud
 *
 * Kör med:
 *   TYPESENSE_HOST=xxx.typesense.net TYPESENSE_API_KEY=din-admin-nyckel node import-synonyms.mjs
 *
 * Eller sätt variablerna i en .env och kör med:
 *   npx dotenv-cli node import-synonyms.mjs
 */

import { readFileSync } from "fs";

const HOST = process.env.TYPESENSE_HOST;
const API_KEY = process.env.TYPESENSE_API_KEY;
const COLLECTION = process.env.TYPESENSE_COLLECTION || "products";

if (!HOST || !API_KEY) {
  console.error(
    "❌  Sätt TYPESENSE_HOST och TYPESENSE_API_KEY som miljövariabler."
  );
  process.exit(1);
}

// Ladda synonymfilen – ta bort JS-kommentarer (// ...) innan JSON-parse
const raw = readFileSync("./typesense-synonyms.json", "utf8");
const stripped = raw.replace(/\/\/.*$/gm, ""); // strip inline comments
const synonyms = JSON.parse(stripped);

const baseUrl = `https://${HOST}/collections/${COLLECTION}/synonyms`;
const headers = {
  "Content-Type": "application/json",
  "X-TYPESENSE-API-KEY": API_KEY,
};

let ok = 0;
let fail = 0;

console.log(`\n🔄  Importerar ${synonyms.length} synonymgrupper till "${COLLECTION}"...\n`);

for (const syn of synonyms) {
  const { id, ...body } = syn;
  const url = `${baseUrl}/${id}`;

  try {
    const res = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });

    if (res.ok) {
      console.log(`✅  ${id}`);
      ok++;
    } else {
      const err = await res.text();
      console.warn(`⚠️   ${id} → ${res.status}: ${err}`);
      fail++;
    }
  } catch (e) {
    console.error(`❌  ${id} → ${e.message}`);
    fail++;
  }
}

console.log(`\n─────────────────────────────────`);
console.log(`✅  Klara:    ${ok}`);
console.log(`❌  Misslyckades: ${fail}`);
console.log(`─────────────────────────────────\n`);
