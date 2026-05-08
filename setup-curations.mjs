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
const items = [
  // ═══════════════════════════════════════════════════════════════════════
  //  DROP
  // ═══════════════════════════════════════════════════════════════════════
  { id: "concept-lagt-drop",   rule: { query: "lågt drop", match: "contains" },   filter_by: "drop:=[`0`,`1`,`2`,`3`,`4`]" },
  { id: "concept-hogt-drop",   rule: { query: "högt drop", match: "contains" },   filter_by: "drop:=[`8`,`9`,`10`,`11`,`12`]" },
  { id: "concept-noll-drop",   rule: { query: "0 drop", match: "contains" },      filter_by: "drop:=`0`" },

  // ═══════════════════════════════════════════════════════════════════════
  //  SKOTYP (subcategory från Prisjakt product_type)
  // ═══════════════════════════════════════════════════════════════════════
  { id: "concept-tavling",     rule: { query: "tävling", match: "contains" },     filter_by: "subcategory:=`Tävling`" },
  { id: "concept-distans",     rule: { query: "distans", match: "contains" },     filter_by: "subcategory:=`Distans`" },
  { id: "concept-trail",       rule: { query: "trail", match: "contains" },       filter_by: "subcategory:=`Trail`" },
  { id: "concept-marathon",    rule: { query: "marathon", match: "contains" },    filter_by: "subcategory:=`Distans`" },

  // ═══════════════════════════════════════════════════════════════════════
  //  EGENSKAPER
  //  Värden från CMS-template:
  //    Stabilitet:  Flexibel / Medium / Stabil
  //    Dämpning:    Mjuk / Medel / Fast
  // ═══════════════════════════════════════════════════════════════════════
  { id: "concept-latt",        rule: { query: "lätt sko", match: "contains" },    filter_by: "weight_grams:<220" },
  { id: "concept-tung",        rule: { query: "tung sko", match: "contains" },    filter_by: "weight_grams:>280" },
  { id: "concept-stabil",      rule: { query: "stabil", match: "contains" },      filter_by: "stability:=`Stabil`" },
  { id: "concept-medium-stab", rule: { query: "lätt stabilitet", match: "contains" }, filter_by: "stability:=`Medium`" },
  { id: "concept-flexibel",    rule: { query: "flexibel", match: "contains" },    filter_by: "stability:=`Flexibel`" },
  { id: "concept-neutral",     rule: { query: "neutral", match: "contains" },     filter_by: "stability:=`Flexibel`" }, // "neutral sko" = flexibel i Löplabbet-terminologi

  // ═══════════════════════════════════════════════════════════════════════
  //  BREDD (last_width — verifierat fältnamn)
  //  OBS: id-ordning styr precedens. "extra bred" måste komma före "bred sko".
  // ═══════════════════════════════════════════════════════════════════════
  { id: "concept-bred-a-extra", rule: { query: "extra bred", match: "contains" }, filter_by: "last_width:=`Extra bred`" },
  { id: "concept-bred-b-bred",  rule: { query: "bred sko", match: "contains" },   filter_by: "last_width:=[`Bred`,`Extra bred`]" },
  { id: "concept-bred-c-fot",   rule: { query: "bred fot", match: "contains" },   filter_by: "last_width:=[`Bred`,`Extra bred`]" },
  { id: "concept-smal",         rule: { query: "smal", match: "contains" },       filter_by: "last_width:=`Smal`" },

  // ═══════════════════════════════════════════════════════════════════════
  //  DÄMPNING (cushioning) — värden: Mjuk / Medel / Fast
  // ═══════════════════════════════════════════════════════════════════════
  { id: "concept-mjuk",        rule: { query: "mjuk", match: "contains" },        filter_by: "cushioning:=`Mjuk`" },
  { id: "concept-mjuk-2",      rule: { query: "mycket dämpning", match: "contains" }, filter_by: "cushioning:=`Mjuk`" },
  { id: "concept-medel",       rule: { query: "medel dämpning", match: "contains" }, filter_by: "cushioning:=`Medel`" },
  { id: "concept-lagom",       rule: { query: "lagom dämpning", match: "contains" }, filter_by: "cushioning:=`Medel`" },
  { id: "concept-fast",        rule: { query: "responsiv", match: "contains" },   filter_by: "cushioning:=`Fast`" },
  { id: "concept-fast-2",      rule: { query: "fast dämpning", match: "contains" }, filter_by: "cushioning:=`Fast`" },

  // ═══════════════════════════════════════════════════════════════════════
  //  MÅLGRUPP (gender — normaliserat till Dam/Herr/Unisex i sync.mjs)
  // ═══════════════════════════════════════════════════════════════════════
  { id: "concept-dam",         rule: { query: "damsko", match: "contains" },      filter_by: "gender:=`Dam`" },
  { id: "concept-herr",        rule: { query: "herrsko", match: "contains" },     filter_by: "gender:=`Herr`" },

  // ═══════════════════════════════════════════════════════════════════════
  //  PRIS & REA (alla verifierade)
  // ═══════════════════════════════════════════════════════════════════════
  { id: "concept-billig",      rule: { query: "billig", match: "contains" },      filter_by: "price:<1500" },
  { id: "concept-budget",      rule: { query: "budget", match: "contains" },      filter_by: "price:<1500" },
  { id: "concept-premium",     rule: { query: "premium", match: "contains" },     filter_by: "price:>=2200" },
  { id: "concept-rea",         rule: { query: "rea", match: "contains" },         filter_by: "on_sale:=true" },
  { id: "concept-erbjudande",  rule: { query: "erbjudande", match: "contains" },  filter_by: "on_sale:=true" },
  { id: "concept-stor-rea",    rule: { query: "stor rea", match: "contains" },    filter_by: "discount_percent:>=30" },
  { id: "concept-i-lager",     rule: { query: "i lager", match: "contains" },     filter_by: "in_stock:=true" },

  // ═══════════════════════════════════════════════════════════════════════
  //  RANKING (dynamic sort) — popularity finns, release_date gör inte
  // ═══════════════════════════════════════════════════════════════════════
  { id: "rank-bastsaljare",    rule: { query: "bästsäljare", match: "contains" }, sort_by: "popularity:desc" },
  { id: "rank-populart",       rule: { query: "populär", match: "contains" },     sort_by: "popularity:desc" },
  { id: "rank-billigast",      rule: { query: "billigast", match: "contains" },   sort_by: "price:asc" },
  { id: "rank-storst-rabatt",  rule: { query: "störst rabatt", match: "contains" }, sort_by: "discount_percent:desc" },

  // ═══════════════════════════════════════════════════════════════════════
  //  MODELL-DISAMBIGUERING — tvingar namn-match före brand/popularity
  // ═══════════════════════════════════════════════════════════════════════
  { id: "model-vaporfly",      rule: { query: "vaporfly", match: "contains" },    filter_by: "name:`vaporfly`" },
  { id: "model-pegasus",       rule: { query: "pegasus", match: "contains" },     filter_by: "name:`pegasus`" },
  { id: "model-bondi",         rule: { query: "bondi", match: "contains" },       filter_by: "name:`bondi`" },
  { id: "model-novablast",     rule: { query: "novablast", match: "contains" },   filter_by: "name:`novablast`" },
  { id: "model-ghost",         rule: { query: "ghost", match: "contains" },       filter_by: "name:`ghost`" },
  { id: "model-cloud",         rule: { query: "cloud", match: "contains" },       filter_by: "name:`cloud`" },
  { id: "model-clifton",       rule: { query: "clifton", match: "contains" },     filter_by: "name:`clifton`" },
  { id: "model-endorphin",     rule: { query: "endorphin", match: "contains" },   filter_by: "name:`endorphin`" },

  // ═══════════════════════════════════════════════════════════════════════
  //  MÄRKES-DISAMBIGUERING
  // ═══════════════════════════════════════════════════════════════════════
  { id: "brand-on",            rule: { query: "on cloud", match: "contains" },    filter_by: "brand:=`On`" },
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

  await ensureCurationSet();

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
