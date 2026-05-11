/**
 * setup-curations.mjs (v4 — verifierade fältnamn)
 * Skapar/uppdaterar curation rules för Löplabbet sökwidget i Typesense v30.
 *
 * Alla fält och datatyper i denna fil är verifierade mot sync.mjs:s
 * mappning från Noselake/Prisjakt → Typesense. Om sync.mjs uppdateras
 * med nya fält bör denna fil hållas i synk.
 *
 * Bekräftade fält i Typesense-collectionen "products":
 *   Från Noselake (via dynamic_facets):
 *     drop          string  ("0", "1", ..., "15" — utan "mm"-suffix)
 *     stability     string  ("Flexibel", "Medium", "Stabil")
 *     cushioning    string  ("Mjuk", "Medel", "Fast")
 *     last_width    string  ("Smal", "Normal", "Bred", "Extra bred")
 *     weight_grams  int32
 *     popularity    float
 *     colors        string[]
 *     description   string
 *   Från Prisjakt:
 *     name              string
 *     brand             string
 *     gender            string  ("Dam", "Herr", "Unisex")
 *     category          string  (förstadelen av product_type, _-separerat)
 *     subcategory       string  ("Tävling", "Distans", "Trail" — verifierat fungerande)
 *     price             float
 *     sale_price        float (nullable)
 *     on_sale           boolean
 *     discount_percent  int32 (nullable)
 *     in_stock          boolean
 *
 * Användning:
 *   TYPESENSE_HOST=... TYPESENSE_ADMIN_KEY=... node setup-curations.mjs
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
//
// Princip: curation rules används BARA för det synonymer fundamentalt
// inte kan göra. Synonymer hanterar all begrepp→produkt-matchning via
// text (tävling, mjuk, stabil, bred, distans, mm.) eftersom det jobbar
// mot namn och beskrivning. Curations kompletterar med:
//
//   1. Numeriska/range-filter   (drop, vikt, pris, rabatt)
//   2. Boolean-filter           (rea, i lager)
//   3. Sort-overrides           ("bästsäljare", "billigast")
//   4. Disambiguering           (vaporfly vs alphafly, On vs ord med "on")
//
// Vissa tydliga köpintenter filtreras hårt (kön, passform, dämpning,
// stabilitet). Det ger bättre resultat än ren synonym-expansion när
// facettvärdena finns i indexet.

const RACE_FILTER = "(shoe_type:=`Tävling` || name:`KOLFIBERSKOR` || name:`TÄVLINGSSKOR` || name:`RACINGSKOR`)";
const DAM_FILTER = "gender:=[`Dam`,`Unisex`]";
const HERR_FILTER = "gender:=[`Herr`,`Unisex`]";
const BRED_FILTER = "last_width:=[`Bred`,`Extra bred`]";
const SMAL_FILTER = "last_width:=`Smal`";
const MJUK_FILTER = "cushioning:=`Mjuk`";
const FAST_FILTER = "cushioning:=`Fast`";
const STABIL_FILTER = "stability:=`Stabil`";
const NEUTRAL_FILTER = "stability:=[`Flexibel`,`Medium`]";

const items = [
  // ═══════════════════════════════════════════════════════════════════════
  //  SKOTYP-FILTER (shoe_type från namn-suffix)
  //  Säkerställer att begreppssökningar bara returnerar skor, inte
  //  löparbälten/klockor/kläder med liknande ord i namnet.
  // ═══════════════════════════════════════════════════════════════════════
  { id: "shoetype-tavling",      rule: { query: "tävling", match: "contains" },      filter_by: RACE_FILTER },
  { id: "shoetype-tavlingssko",  rule: { query: "tävlingssko", match: "contains" },  filter_by: RACE_FILTER },
  { id: "shoetype-tavlingsko",   rule: { query: "tävlingsko", match: "contains" },   filter_by: RACE_FILTER },
  { id: "shoetype-tavlingsskor", rule: { query: "tävlingsskor", match: "contains" }, filter_by: RACE_FILTER },
  { id: "shoetype-kolfiber",     rule: { query: "kolfiber", match: "contains" },     filter_by: RACE_FILTER },
  { id: "shoetype-kolfibersko",  rule: { query: "kolfibersko", match: "contains" },  filter_by: RACE_FILTER },
  { id: "shoetype-kolfiberskor", rule: { query: "kolfiberskor", match: "contains" }, filter_by: RACE_FILTER },
  { id: "shoetype-carbon",       rule: { query: "carbon", match: "contains" },       filter_by: RACE_FILTER },
  { id: "shoetype-carbonsko",    rule: { query: "carbonsko", match: "contains" },    filter_by: RACE_FILTER },
  { id: "shoetype-racingsko",    rule: { query: "racingsko", match: "contains" },    filter_by: RACE_FILTER },
  { id: "shoetype-racingskor",   rule: { query: "racingskor", match: "contains" },   filter_by: RACE_FILTER },
  { id: "shoetype-trail",        rule: { query: "trailsko", match: "contains" },     filter_by: "shoe_type:=`Trail`" },
  { id: "shoetype-trailskor",    rule: { query: "trailskor", match: "contains" },    filter_by: "shoe_type:=`Trail`" },
  { id: "shoetype-terrang",      rule: { query: "terrängsko", match: "contains" },   filter_by: "shoe_type:=`Trail`" },
  { id: "shoetype-promenad",     rule: { query: "promenadsko", match: "contains" },  filter_by: "shoe_type:=`Promenad`" },
  { id: "shoetype-promenadskor", rule: { query: "promenadskor", match: "contains" }, filter_by: "shoe_type:=`Promenad`" },

  // Kön
  { id: "concept-dam",           rule: { query: "dam", match: "contains" },          filter_by: DAM_FILTER },
  { id: "concept-damskor",       rule: { query: "damskor", match: "contains" },      filter_by: DAM_FILTER },
  { id: "concept-women",         rule: { query: "women", match: "contains" },        filter_by: DAM_FILTER },
  { id: "concept-herr",          rule: { query: "herr", match: "contains" },         filter_by: HERR_FILTER },
  { id: "concept-herrskor",      rule: { query: "herrskor", match: "contains" },     filter_by: HERR_FILTER },

  // Passform, dämpning och stabilitet
  { id: "concept-bred",          rule: { query: "bred", match: "contains" },          filter_by: BRED_FILTER },
  { id: "concept-bred-passform", rule: { query: "bred passform", match: "contains" }, filter_by: BRED_FILTER },
  { id: "concept-bred-fot",      rule: { query: "bred fot", match: "contains" },      filter_by: BRED_FILTER },
  { id: "concept-wide-fit",      rule: { query: "wide fit", match: "contains" },      filter_by: BRED_FILTER },
  { id: "concept-smal",          rule: { query: "smal", match: "contains" },          filter_by: SMAL_FILTER },
  { id: "concept-smal-passform", rule: { query: "smal passform", match: "contains" }, filter_by: SMAL_FILTER },
  { id: "concept-smal-fot",      rule: { query: "smal fot", match: "contains" },      filter_by: SMAL_FILTER },
  { id: "concept-mjuk-sko",      rule: { query: "mjuk", match: "contains" },          filter_by: MJUK_FILTER },
  { id: "concept-mjuk",          rule: { query: "mjuk dämpning", match: "contains" }, filter_by: MJUK_FILTER },
  { id: "concept-maxdampad",     rule: { query: "max dämpning", match: "contains" },  filter_by: MJUK_FILTER },
  { id: "concept-fast",          rule: { query: "fast dämpning", match: "contains" }, filter_by: FAST_FILTER },
  { id: "concept-responsiv",     rule: { query: "responsiv", match: "contains" },     filter_by: FAST_FILTER },
  { id: "concept-stabil",        rule: { query: "stabil", match: "contains" },        filter_by: STABIL_FILTER },
  { id: "concept-pronation",     rule: { query: "pronation", match: "contains" },     filter_by: STABIL_FILTER },
  { id: "concept-neutral",       rule: { query: "neutral", match: "contains" },       filter_by: NEUTRAL_FILTER },

  // ═══════════════════════════════════════════════════════════════════════
  //  DROP — numeriskt range-filter (synonymer kan inte göra detta)
  // ═══════════════════════════════════════════════════════════════════════
  { id: "concept-lagt-drop",   rule: { query: "lågt drop", match: "contains" },   filter_by: "drop:=[`0`,`1`,`2`,`3`,`4`]" },
  { id: "concept-hogt-drop",   rule: { query: "högt drop", match: "contains" },   filter_by: "drop:=[`8`,`9`,`10`,`11`,`12`]" },
  { id: "concept-noll-drop",   rule: { query: "0 drop", match: "contains" },      filter_by: "drop:=`0`" },

  // ═══════════════════════════════════════════════════════════════════════
  //  VIKT — numeriskt filter
  // ═══════════════════════════════════════════════════════════════════════
  { id: "concept-latt",        rule: { query: "lätt sko", match: "contains" },    filter_by: "weight_grams:<220" },
  { id: "concept-tung",        rule: { query: "tung sko", match: "contains" },    filter_by: "weight_grams:>280" },

  // ═══════════════════════════════════════════════════════════════════════
  //  PRIS & REA — numeriskt/boolean
  // ═══════════════════════════════════════════════════════════════════════
  { id: "concept-billig",      rule: { query: "billig", match: "contains" },      filter_by: "price:<1500" },
  { id: "concept-budget",      rule: { query: "budget", match: "contains" },      filter_by: "price:<1500" },
  { id: "concept-premium",     rule: { query: "premium", match: "contains" },     filter_by: "price:>=2200" },
  { id: "concept-rea",         rule: { query: "rea", match: "contains" },         filter_by: "on_sale:=true" },
  { id: "concept-erbjudande",  rule: { query: "erbjudande", match: "contains" },  filter_by: "on_sale:=true" },
  { id: "concept-stor-rea",    rule: { query: "stor rea", match: "contains" },    filter_by: "discount_percent:>=30" },
  { id: "concept-i-lager",     rule: { query: "i lager", match: "contains" },     filter_by: "in_stock:=true" },

  // ═══════════════════════════════════════════════════════════════════════
  //  RANKING (sort-override — synonymer kan inte ändra ordning)
  // ═══════════════════════════════════════════════════════════════════════
  { id: "rank-bastsaljare",    rule: { query: "bästsäljare", match: "contains" }, sort_by: "popularity:desc" },
  { id: "rank-populart",       rule: { query: "populär", match: "contains" },     sort_by: "popularity:desc" },
  { id: "rank-billigast",      rule: { query: "billigast", match: "contains" },   sort_by: "price:asc" },
  { id: "rank-storst-rabatt",  rule: { query: "störst rabatt", match: "contains" }, sort_by: "discount_percent:desc" },

  // ═══════════════════════════════════════════════════════════════════════
  //  MODELL-DISAMBIGUERING — tvingar namn-match före brand/popularity
  //  Behövs för modeller där populärare grannmodell skulle ranka högre
  // ═══════════════════════════════════════════════════════════════════════
  { id: "model-vaporfly",      rule: { query: "vaporfly", match: "contains" },    filter_by: "name:`vaporfly`" },
  { id: "model-alphafly",      rule: { query: "alphafly", match: "contains" },    filter_by: "name:`alphafly`" },
  { id: "model-metaspeed",     rule: { query: "metaspeed", match: "contains" },   filter_by: "name:`metaspeed`" },
  { id: "model-deviate",       rule: { query: "deviate", match: "contains" },     filter_by: "name:`deviate`" },
  { id: "model-pegasus",       rule: { query: "pegasus", match: "contains" },     filter_by: "name:`pegasus`" },
  { id: "model-bondi",         rule: { query: "bondi", match: "contains" },       filter_by: "name:`bondi`" },
  { id: "model-novablast",     rule: { query: "novablast", match: "contains" },   filter_by: "name:`novablast`" },
  { id: "model-ghost",         rule: { query: "ghost", match: "contains" },       filter_by: "name:`ghost`" },
  { id: "model-cloud",         rule: { query: "cloud", match: "contains" },       filter_by: "name:`cloud`" },
  { id: "model-clifton",       rule: { query: "clifton", match: "contains" },     filter_by: "name:`clifton`" },
  { id: "model-endorphin",     rule: { query: "endorphin", match: "contains" },   filter_by: "name:`endorphin`" },

  // ═══════════════════════════════════════════════════════════════════════
  //  MÄRKES-DISAMBIGUERING — kort/tvetydigt märkesnamn
  // ═══════════════════════════════════════════════════════════════════════
  { id: "brand-on",            rule: { query: "on cloud", match: "contains" },    filter_by: "brand:=`On`" },
];

// ── Reglar som tagits bort i denna version och ska raderas från Typesense ──
// Dessa upsertades tidigare men ersatts av synonymer som hanterar samma intent
// via textmatchning. Listan kan tömmas när alla miljöer kört scriptet en gång.
const obsoleteIds = [
  "concept-tavling", "concept-distans", "concept-trail", "concept-marathon",
  "concept-daily", "concept-daily-2", "concept-tempo", "concept-intervaller",
  "concept-aterhamtning",
  "concept-medium-stab", "concept-flexibel",
  "concept-mjuk-2", "concept-medel", "concept-lagom",
  "concept-fast-2",
  "concept-bred-a-extra", "concept-bred-b-bred", "concept-bred-c-fot",
  "rank-nyhet", // tidigare experiment, sort_by release_date — fältet finns inte
];

// ── Anropshjälpare ──────────────────────────────────────────────────────────
async function tsRequest(method, path, body) {
  const url = `https://${TYPESENSE_HOST}${path}`;
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-TYPESENSE-API-KEY": TYPESENSE_KEY,
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, text, json };
}

// ── 1. Säkerställ att curation set finns ────────────────────────────────────
async function ensureCurationSet() {
  console.log(`📦  Säkerställer att curation_set "${CURATION_SET}" finns...`);
  const r = await tsRequest("PUT", `/curation_sets/${CURATION_SET}`, { items: [] });
  if (!r.ok) {
    console.log(`   ℹ️   Initial PUT gav HTTP ${r.status} (ofarligt om setet redan finns).`);
  } else {
    console.log(`   ✅  OK.`);
  }
}

async function ensureShoeTypeField() {
  console.log(`🔎  Kontrollerar att fältet "shoe_type" finns i "${COLLECTION}"...`);
  const get = await tsRequest("GET", `/collections/${COLLECTION}`);
  if (!get.ok) {
    console.error(`   ❌  Kunde inte läsa collection: HTTP ${get.status}`);
    return false;
  }

  const hasField = get.json?.fields?.some(f => f.name === "shoe_type");
  if (hasField) {
    console.log(`   ℹ️   Finns redan.`);
    return true;
  }

  const patch = await tsRequest("PATCH", `/collections/${COLLECTION}`, {
    fields: [
      { name: "shoe_type", type: "string", facet: true, optional: true },
    ],
  });
  if (!patch.ok) {
    console.error(`   ❌  Kunde inte lägga till shoe_type: HTTP ${patch.status} — ${patch.text.slice(0, 200)}`);
    return false;
  }

  console.log(`   ✅  Lade till shoe_type i schemat. Kör sync efter detta så befintliga dokument får värden.`);
  return true;
}

// ── 1b. Radera obsoleta items ───────────────────────────────────────────────
async function deleteObsolete() {
  console.log(`\n🗑️   Raderar ${obsoleteIds.length} obsoleta regler...`);
  let removed = 0, missing = 0;
  for (const id of obsoleteIds) {
    const r = await tsRequest("DELETE", `/curation_sets/${CURATION_SET}/items/${id}`);
    if (r.ok) {
      console.log(`   ✅  ${id}`);
      removed++;
    } else if (r.status === 404) {
      // Redan borta — ofarligt
      missing++;
    } else {
      console.log(`   ⚠️   ${id} HTTP ${r.status} — ${r.text.slice(0, 80)}`);
    }
  }
  console.log(`   → ${removed} raderade, ${missing} fanns redan inte.`);
}

// ── 2. Upserta varje item separat ───────────────────────────────────────────
async function upsertItem(item) {
  const body = {
    rule: item.rule,
    ...(item.filter_by && { filter_by: item.filter_by }),
    ...(item.sort_by && { sort_by: item.sort_by }),
    ...(item.includes && { includes: item.includes }),
    ...(item.excludes && { excludes: item.excludes }),
    ...(item.replace_query && { replace_query: item.replace_query }),
  };
  const r = await tsRequest("PUT", `/curation_sets/${CURATION_SET}/items/${item.id}`, body);
  if (!r.ok) {
    const msg = r.json?.message ?? r.text.slice(0, 160);
    console.log(`   ❌  ${item.id.padEnd(30)} HTTP ${r.status}  — ${msg}`);
    return false;
  }
  const action = item.filter_by ?? item.sort_by ?? "(includes/excludes)";
  console.log(`   ✅  ${item.id.padEnd(30)} "${item.rule.query}" → ${action}`);
  return true;
}

// ── 3. Länka set till collection ────────────────────────────────────────────
async function linkToCollection() {
  console.log(`\n🔗  Länkar curation_set "${CURATION_SET}" till collection "${COLLECTION}"...`);
  const get = await tsRequest("GET", `/collections/${COLLECTION}`);
  if (!get.ok) {
    console.error(`   ❌  Kunde inte läsa collection: HTTP ${get.status}`);
    return false;
  }
  const existing = get.json?.curation_sets ?? [];
  if (existing.includes(CURATION_SET)) {
    console.log(`   ℹ️   Redan länkat.`);
    return true;
  }
  const merged = Array.from(new Set([...existing, CURATION_SET]));
  const patch = await tsRequest("PATCH", `/collections/${COLLECTION}`, { curation_sets: merged });
  if (!patch.ok) {
    console.error(`   ❌  PATCH misslyckades: HTTP ${patch.status} — ${patch.text.slice(0, 200)}`);
    return false;
  }
  console.log(`   ✅  Länkat: curation_sets=${JSON.stringify(merged)}`);
  return true;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`🚀  Sätter ${items.length} curation rules på "${COLLECTION}" (Typesense v30)\n`);

  const schemaOk = await ensureShoeTypeField();
  if (!schemaOk) process.exit(1);

  await ensureCurationSet();
  await deleteObsolete();

  console.log(`\n📤  Upsertar ${items.length} items...`);
  let ok = 0, fail = 0;
  for (const item of items) {
    if (await upsertItem(item)) ok++; else fail++;
  }

  const linkOk = await linkToCollection();

  console.log(`\n─────────────────────────────────`);
  console.log(`✅  Lyckades:     ${ok} / ${items.length}`);
  console.log(`❌  Misslyckades: ${fail} / ${items.length}`);
  console.log(`🔗  Länkning:     ${linkOk ? "OK" : "MISSLYCKAD"}`);
  console.log(`─────────────────────────────────`);

  if (fail > 0) {
    console.log(`\n💡  HTTP 400 = fel filter_by-syntax (ofta värden som "Stabil"/"Bred" som inte exakt matchar fältets faktiska värde).`);
    console.log(`💡  Verifiera fältvärden med: curl -H "X-TYPESENSE-API-KEY: $KEY" "https://$HOST/collections/products/documents/search?q=*&per_page=5" | jq '.hits[].document | {drop, stability, cushioning, last_width, gender, subcategory}'`);
  }
}

main().catch((e) => { console.error("💥  Oväntat fel:", e); process.exit(1); });
