/**
 * setup-curations.mjs
 * Skapar/uppdaterar Typesense curation rules för begreppsfrågor som inte
 * mappar direkt mot produktnamn (lågt drop, distans, lätt, stabil etc.).
 *
 * Idempotent — PUT på override-ID skriver över befintlig regel. Kör manuellt
 * när du vill lägga till eller justera regler. Curations lever i Typesense
 * och påverkar alla framtida sökningar oavsett widget-version.
 *
 * Användning:
 *   TYPESENSE_HOST=... TYPESENSE_ADMIN_KEY=... node setup-curations.mjs
 *
 * Verifiera fältformat först! Curations använder `filter_by` mot fält i
 * collection-schemat. Om t.ex. `drop` är string i schemat ser syntax ut
 * som drop:=[`0`,`1`,`2`...]; om det är int32 blir det drop:[0..4].
 * Kolla med: curl -H "X-TYPESENSE-API-KEY: $KEY" https://$HOST/collections/products
 */

const TYPESENSE_HOST = process.env.TYPESENSE_HOST;
const TYPESENSE_KEY = process.env.TYPESENSE_ADMIN_KEY;
const COLLECTION = "products";

if (!TYPESENSE_HOST || !TYPESENSE_KEY) {
  console.error("❌  Sätt TYPESENSE_HOST och TYPESENSE_ADMIN_KEY.");
  process.exit(1);
}

// ── Reglerna ───────────────────────────────────────────────────────────────
// Antaganden om fält (justera filter_by om verkligheten skiljer sig):
//   drop          string  ("0", "4", "8" — utan "mm"-suffix)
//   subcategory   string  ("Distans", "Tävling", "Trail" etc.)
//   stability     string  ("Neutral", "Stabil")
//   weight_grams  int32
//   name          string  (full produkttitel)
//
// `match: "contains"` betyder att regeln triggar om frasen finns någonstans
// i sökningen (t.ex. "lågt drop hoka" triggar lågt-drop-regeln).
// Använd "exact" för regler som ska vara striktare.

const curations = [
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
  // Vaporfly-sökning lockar Alphafly. Vi tvingar fram bara produkter med
  // "vaporfly" i namnet. Field weighting i widgeten löser detta också,
  // men curationen är ett bälte-och-hängslen-skydd.
  {
    id: "model-vaporfly",
    rule: { query: "vaporfly", match: "contains" },
    filter_by: "name:`vaporfly`",
  },
];

// ── Upsert ────────────────────────────────────────────────────────────────
async function upsertOverride(override) {
  const url = `https://${TYPESENSE_HOST}/collections/${COLLECTION}/overrides/${override.id}`;
  const body = {
    rule: override.rule,
    ...(override.filter_by && { filter_by: override.filter_by }),
    ...(override.includes && { includes: override.includes }),
    ...(override.excludes && { excludes: override.excludes }),
  };

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
    console.log(`❌  ${override.id.padEnd(28)} HTTP ${res.status} — ${text.slice(0, 180)}`);
    return false;
  }
  console.log(`✅  ${override.id.padEnd(28)} query="${override.rule.query}" → ${override.filter_by ?? "(includes/excludes)"}`);
  return true;
}

async function main() {
  console.log(`🚀  Sätter ${curations.length} curation rules i collection "${COLLECTION}"...\n`);
  let ok = 0, fail = 0;
  for (const c of curations) {
    if (await upsertOverride(c)) ok++; else fail++;
  }
  console.log(`\n─────────────────────────────────`);
  console.log(`✅  Lyckades:     ${ok}`);
  console.log(`❌  Misslyckades: ${fail}`);
  console.log(`─────────────────────────────────`);
  if (fail > 0) {
    console.log(`\nVid HTTP 400: oftast fel filter_by-syntax. Verifiera att fältet finns`);
    console.log(`i schemat och att typen (string/int32) stämmer med hur regeln formulerats.`);
  }
}

main().catch((e) => { console.error("💥  Oväntat fel:", e); process.exit(1); });
