/**
 * import-synonyms.mjs (v2 — synonym_sets API)
 *
 * Skapar/uppdaterar ett synonym_set "loplabbet-synonyms" och länkar
 * det till products-kollektionen. Använder Typesense v30+ API.
 *
 * Bakåtkompatibilitet: faller tillbaka till legacy per-collection-API
 * om synonym_sets returnerar 404.
 */

import { readFileSync } from "fs";

const HOST       = process.env.TYPESENSE_HOST;
const API_KEY    = process.env.TYPESENSE_ADMIN_KEY;
const COLLECTION = process.env.TYPESENSE_COLLECTION || "products";
const SET_NAME   = "loplabbet-synonyms";

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

// ── Steg 1: Försök med v30+ synonym_sets API ───────────────────────────
async function tryV30() {
  const setBody = {
    items: synonyms.map(syn => {
      const item = { id: syn.id, synonyms: syn.synonyms };
      if (syn.root) item.root = syn.root;
      return item;
    })
  };

  console.log(`📤  Försöker via synonym_sets API (v30+)...`);
  const setUrl = `https://${HOST}/synonym_sets/${SET_NAME}`;
  const res = await fetch(setUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify(setBody),
  });

  if (res.status === 404) {
    console.log(`    synonym_sets-endpointen finns inte (≤v29). Faller tillbaka.`);
    return false;
  }

  if (!res.ok) {
    const err = await res.text();
    console.error(`❌  synonym_sets PUT failade: ${res.status} ${err}`);
    return false;
  }

  console.log(`✅  Synonym set "${SET_NAME}" sparat (${synonyms.length} grupper).`);

  // Länka set till kollektionen
  console.log(`🔗  Länkar set till "${COLLECTION}"...`);
  const linkRes = await fetch(`https://${HOST}/collections/${COLLECTION}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ synonym_sets: [SET_NAME] }),
  });
  if (!linkRes.ok) {
    const err = await linkRes.text();
    console.error(`⚠️   Kunde inte länka set: ${linkRes.status} ${err}`);
    console.error(`     Du kan länka manuellt eller via search-parametern synonym_sets=${SET_NAME}.`);
  } else {
    console.log(`✅  Set länkat till ${COLLECTION}.`);
  }

  return true;
}

// ── Steg 2: Fallback till legacy per-collection API ────────────────────
async function tryLegacy() {
  console.log(`📤  Försöker via legacy per-collection API...`);
  const baseUrl = `https://${HOST}/collections/${COLLECTION}/synonyms`;
  let ok = 0, fail = 0;

  for (const syn of synonyms) {
    const { id, ...body } = syn;
    const res = await fetch(`${baseUrl}/${id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });
    if (res.ok) ok++;
    else {
      fail++;
      const err = await res.text();
      console.warn(`⚠️   ${id} → ${res.status}: ${err.slice(0, 200)}`);
    }
  }
  console.log(`\nLegacy-resultat: ${ok} OK, ${fail} misslyckade.`);
  return ok > 0;
}

// ── Main ────────────────────────────────────────────────────────────────
const v30Ok = await tryV30();
if (!v30Ok) {
  await tryLegacy();
}

console.log(`\n✨  Klart.`);
