/**
 * import-synonyms.mjs (v3 — multi-collection link)
 *
 * Skapar/uppdaterar synonym_set "loplabbet-synonyms" och länkar det
 * till BÅDA products- och pages-kollektionen. Använder Typesense v30+ API.
 *
 * Diff mot v2:
 * - Länkar setet till flera collections (definieras i COLLECTIONS nedan).
 * - Mergar in setet i collectionens befintliga synonym_sets istället för
 *   att skriva över — så andra synonym-set inte tappas bort.
 * - Tar bort legacy-fallbacken (Typesense v30+ är nu krav).
 */

import { readFileSync } from "fs";

const HOST     = process.env.TYPESENSE_HOST;
const API_KEY  = process.env.TYPESENSE_ADMIN_KEY;
const SET_NAME = "loplabbet-synonyms";

// Collections som ska få setet länkat. Lägg till fler om widgeten
// utökas med fler index.
const COLLECTIONS = ["products", "pages"];

if (!HOST || !API_KEY) {
  console.error("❌  Sätt TYPESENSE_HOST och TYPESENSE_ADMIN_KEY.");
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
  "X-TYPESENSE-API-KEY": API_KEY,
};

// Ladda och städa kommentarer från synonym-filen
const raw = readFileSync("./typesense-synonyms.json", "utf8");
const stripped = raw.replace(/\/\/.*$/gm, "");
const synonyms = JSON.parse(stripped);

console.log(`\n🔄  Importerar ${synonyms.length} synonymgrupper...\n`);

// ── Steg 1: Upserta synonym set ────────────────────────────────────────────
async function upsertSet() {
  const setBody = {
    items: synonyms.map(syn => {
      const item = { id: syn.id, synonyms: syn.synonyms };
      if (syn.root) item.root = syn.root;
      return item;
    })
  };

  console.log(`📤  PUT /synonym_sets/${SET_NAME} (${synonyms.length} grupper)...`);
  const res = await fetch(`https://${HOST}/synonym_sets/${SET_NAME}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(setBody),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`❌  PUT misslyckades: HTTP ${res.status} — ${err.slice(0, 300)}`);
    if (res.status === 401) {
      console.error("   → API-nyckeln saknar 'synonym_sets:*' action.");
      console.error("   → v30 bytte ut 'synonyms:*' mot 'synonym_sets:*'. Generera ny key.");
    }
    return false;
  }

  console.log(`✅  Synonym set "${SET_NAME}" sparat.`);
  return true;
}

// ── Steg 2: Länka set till flera collections (merge-not-replace) ───────────
async function linkToCollection(collection) {
  // Hämta befintlig länkning
  const get = await fetch(`https://${HOST}/collections/${collection}`, { headers });
  if (!get.ok) {
    console.error(`   ❌  ${collection}: kunde inte läsa collection (HTTP ${get.status})`);
    return false;
  }
  const data = await get.json();
  const existing = data.synonym_sets ?? [];

  if (existing.includes(SET_NAME)) {
    console.log(`   ℹ️   ${collection}: redan länkat.`);
    return true;
  }

  const merged = Array.from(new Set([...existing, SET_NAME]));

  const patch = await fetch(`https://${HOST}/collections/${collection}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ synonym_sets: merged }),
  });
  if (!patch.ok) {
    const err = await patch.text();
    console.error(`   ❌  ${collection}: PATCH misslyckades (HTTP ${patch.status}) — ${err.slice(0, 200)}`);
    return false;
  }
  console.log(`   ✅  ${collection}: länkat (synonym_sets=${JSON.stringify(merged)})`);
  return true;
}

// ── Main ────────────────────────────────────────────────────────────────────
const setOk = await upsertSet();
if (!setOk) process.exit(1);

console.log(`\n🔗  Länkar set till ${COLLECTIONS.length} collection(s)...`);
let linkOk = 0, linkFail = 0;
for (const c of COLLECTIONS) {
  if (await linkToCollection(c)) linkOk++; else linkFail++;
}

console.log(`\n─────────────────────────────────`);
console.log(`✅  Set sparat:        ${synonyms.length} grupper`);
console.log(`🔗  Länkade collections: ${linkOk} / ${COLLECTIONS.length}`);
if (linkFail > 0) console.log(`❌  Misslyckade länkar:  ${linkFail}`);
console.log(`─────────────────────────────────`);
console.log(`\n✨  Klart.`);
