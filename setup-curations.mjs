/**
 * setup-curations.mjs (v2 — Typesense v30 API)
 * Skapar/uppdaterar curation rules för begreppsfrågor.
 *
 * v30-migration: overrides är inte längre nested under collections.
 *   Gammal path: PUT /collections/{name}/overrides/{id}      (404 i v30)
 *   Ny path:    PUT /curation_sets/{name}  +  länkning till collection
 *
 * Scriptet:
 *   1. PUT:ar hela curation set:et i ett anrop (idempotent — skriver över)
 *   2. PATCH:ar collectionen så den länkas till setet
 *
 * Användning:
 *   TYPESENSE_HOST=... TYPESENSE_ADMIN_KEY=... node setup-curations.mjs
 *
 * API-nyckel: behöver `curation_sets:*` action (inte längre `overrides:*`).
 * Master key fungerar alltid. Vid 401 — generera ny key med rätt action.
 */

const TYPESENSE_HOST = process.env.TYPESENSE_HOST;
const TYPESENSE_KEY = process.env.TYPESENSE_ADMIN_KEY;
const COLLECTION = "products";
const CURATION_SET = "loplabbet_concepts";

if (!TYPESENSE_HOST || !TYPESENSE_KEY) {
  console.error("❌  Sätt TYPESENSE_HOST och TYPESENSE_ADMIN_KEY.");
  process.exit(1);
}

// ── Reglerna ───────────────────────────────────────────────────────────────
// Justera filter_by om fältnamn/typ skiljer sig från antagandena nedan.
// Verifiera schemat med:
//   curl -H "X-TYPESENSE-API-KEY: $KEY" https://$HOST/collections/products | jq '.fields[]'

const items = [
  // ── Drop-begrepp ─────────────────────────────────────────────────────────
  {
    id: "concept-lagt-drop",
    rule: { query: "lågt drop", match: "contains" },
    filter_by: "drop:=[`0`,`1`,`2`,`3`,`4`]",
  },
  {
    id: "concept-hogt-drop",
    rule: { query: "högt drop", match: "contains" },
    filter_by: "drop:=[`8`,`9`,`10`,`11`,`12`]",
  },
  {
    id: "concept-noll-drop",
    rule: { query: "0 drop", match: "contains" },
    filter_by: "drop:=`0`",
  },

  // ── Skotyp/användning ────────────────────────────────────────────────────
  {
    id: "concept-tavling",
    rule: { query: "tävling", match: "contains" },
    filter_by: "subcategory:=`Tävling`",
  },
  {
    id: "concept-distans",
    rule: { query: "distans", match: "contains" },
    filter_by: "subcategory:=`Distans`",
  },
  {
    id: "concept-trail",
    rule: { query: "trail", match: "contains" },
    filter_by: "subcategory:=`Trail`",
  },

  // ── Egenskaper ───────────────────────────────────────────────────────────
  {
    id: "concept-latt",
    rule: { query: "lätt sko", match: "contains" },
    filter_by: "weight_grams:<220",
  },
  {
    id: "concept-stabil",
    rule: { query: "stabil", match: "contains" },
    filter_by: "stability:=`Stabil`",
  },
  {
    id: "concept-neutral",
    rule: { query: "neutral", match: "contains" },
    filter_by: "stability:=`Neutral`",
  },

  // ── Modell-disambiguering ────────────────────────────────────────────────
  // Vaporfly-sökning lockar Alphafly. Dynamiskt filter på namn för säkerhets skull.
  {
    id: "model-vaporfly",
    rule: { query: "vaporfly", match: "contains" },
    filter_by: "name:`vaporfly`",
  },
];

// ── 1. Upsert hela curation set ─────────────────────────────────────────────
async function upsertCurationSet() {
  const url = `https://${TYPESENSE_HOST}/curation_sets/${CURATION_SET}`;
  const body = { items };

  console.log(`📤  PUT /curation_sets/${CURATION_SET} (${items.length} items)...`);
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-TYPESENSE-API-KEY": TYPESENSE_KEY,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`❌  HTTP ${res.status} — ${text.slice(0, 400)}`);
    if (res.status === 401) {
      console.error("   → API-nyckeln saknar 'curation_sets:*' action.");
      console.error("   → Generera ny nyckel med rätt action eller använd master key.");
    } else if (res.status === 400) {
      console.error("   → Sannolikt fel filter_by-syntax. Verifiera fältnamn och typ i schemat.");
    }
    return false;
  }

  console.log(`✅  Curation set "${CURATION_SET}" sparad.`);
  for (const item of items) {
    console.log(`   • ${item.id.padEnd(28)} "${item.rule.query}" → ${item.filter_by}`);
  }
  return true;
}

// ── 2. Länka set till collection ────────────────────────────────────────────
async function linkToCollection() {
  const url = `https://${TYPESENSE_HOST}/collections/${COLLECTION}`;

  // Kolla först befintliga länkningar så vi inte oavsiktligt kastar bort andra set
  const getRes = await fetch(url, {
    headers: { "X-TYPESENSE-API-KEY": TYPESENSE_KEY },
  });
  if (!getRes.ok) {
    console.error(`❌  Kunde inte hämta collection: HTTP ${getRes.status}`);
    return false;
  }
  const collection = await getRes.json();
  const existing = collection.curation_sets ?? [];
  const merged = Array.from(new Set([...existing, CURATION_SET]));

  if (existing.includes(CURATION_SET)) {
    console.log(`ℹ️   Collection "${COLLECTION}" är redan länkad till "${CURATION_SET}".`);
    return true;
  }

  console.log(`🔗  PATCH /collections/${COLLECTION} → curation_sets=${JSON.stringify(merged)}`);
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-TYPESENSE-API-KEY": TYPESENSE_KEY,
    },
    body: JSON.stringify({ curation_sets: merged }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`❌  HTTP ${res.status} — ${text.slice(0, 400)}`);
    return false;
  }
  console.log(`✅  Collection "${COLLECTION}" länkad till "${CURATION_SET}".`);
  return true;
}

async function main() {
  console.log(`🚀  Sätter curation rules i Typesense (v30 API)...\n`);

  const setOk = await upsertCurationSet();
  if (!setOk) process.exit(1);

  console.log("");
  const linkOk = await linkToCollection();
  if (!linkOk) process.exit(1);

  console.log(`\n─────────────────────────────────`);
  console.log(`✅  Klart. ${items.length} regler aktiva på collection "${COLLECTION}".`);
  console.log(`─────────────────────────────────`);
}

main().catch((e) => { console.error("💥  Oväntat fel:", e); process.exit(1); });
