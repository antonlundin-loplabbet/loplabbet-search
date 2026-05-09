/**
 * sync.mjs (v3 — fixad Noselake-paginering)
 * Hämtar Prisjakt-feed + Noselake API, slår ihop och synkar till Typesense.
 *
 * Fix mot v2: searcher-endpointen ignorerade `from`/`size` så vi fick bara
 * 36 unika produkter på loop. Använder `hits=10000` (samma approach som
 * fetch_descriptions.py i prisjakt-filter-repot) för att hämta hela
 * katalogen i en request. Läser även rätt totalfält (`numberOfHits`).
 */

import { XMLParser } from "fast-xml-parser";

const TYPESENSE_HOST = process.env.TYPESENSE_HOST;
const TYPESENSE_KEY = process.env.TYPESENSE_ADMIN_KEY;
const COLLECTION = "products";

const PRISJAKT_URL = "https://cdn.intersport.se/pricefiles/v2/loplabbet-prisjakt-v1.xml";
const NOSELAKE_URL = "https://services.intersport.se/api/noselake/searcher/website";
const NOSELAKE_HITS = 10000;

if (!TYPESENSE_HOST || !TYPESENSE_KEY) {
  console.error("❌  Sätt TYPESENSE_HOST och TYPESENSE_ADMIN_KEY.");
  process.exit(1);
}

const tsHeaders = {
  "Content-Type": "application/x-ndjson",
  "X-TYPESENSE-API-KEY": TYPESENSE_KEY,
};

// ── Nyckelnormalisering (NYTT) ─────────────────────────────────────────────
// Båda källorna kan ha ID:n i olika format:
//   Noselake itemnumber: "159653301"  (9 siffror — modell + färg)
//   Prisjakt item_group_id: kanske "1596533", "1596533-01", "1596533/01"
//
// Vi tar bort allt utom siffror och returnerar en lista av kandidater så
// matchningen funkar oavsett format. Den första som ger träff vinner.
function makeKeyCandidates(rawId) {
  const onlyDigits = String(rawId ?? "").replace(/\D/g, "");
  if (!onlyDigits) return [];

  const candidates = [onlyDigits];
  // Om 9 siffror → testa även första 7 (modell utan färg)
  if (onlyDigits.length === 9) {
    candidates.push(onlyDigits.slice(0, 7));
  }
  // Om 7 siffror → testa även med "01" tillagt (default färg)
  if (onlyDigits.length === 7) {
    candidates.push(onlyDigits + "01");
  }
  return candidates;
}

// ── 1. Hämta Prisjakt-feed ─────────────────────────────────────────────────
async function fetchPrisjaktFeed() {
  console.log("📥  Hämtar Prisjakt-feed...");
  const res = await fetch(PRISJAKT_URL);
  if (!res.ok) throw new Error(`Prisjakt fetch failed: ${res.status}`);
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);
  const items = parsed?.items?.item ?? [];
  console.log(`    ${items.length} rader hämtade.`);
  // DEBUG: visa exempel på item_group_id för att verifiera format
  if (items.length > 0) {
    const samples = items.slice(0, 3).map(i => i.item_group_id);
    console.log(`    🔎 Prisjakt item_group_id-exempel: ${JSON.stringify(samples)}`);
  }
  return items;
}

function groupPrisjaktItems(items) {
  const groups = new Map();

  for (const item of items) {
    const gid = String(item.item_group_id);

    if (!groups.has(gid)) {
      const price = parseFloat(String(item.price).replace(/[^\d.]/g, ""));
      const saleStr = String(item.sale_price ?? "").replace(/[^\d.]/g, "");
      const salePrice = saleStr ? parseFloat(saleStr) : null;

      const [category, subcategory] = String(item.product_type ?? "")
        .split("_")
        .map((s) => s.trim());

      const shoeType = deriveShoeType(item.title);

      groups.set(gid, {
        id: gid,
        name: cleanTitle(item.title),
        brand: String(item.brand ?? "").trim(),
        gender: normalizeGender(item.gender),
        category: category ?? "",
        subcategory: subcategory ?? "",
        shoe_type: shoeType,
        price,
        sale_price: salePrice,
        on_sale: salePrice !== null && salePrice < price,
        discount_percent:
          salePrice && price
            ? Math.round(((price - salePrice) / price) * 100)
            : null,
        image_url: String(item.image_link ?? ""),
        product_url: String(item.link ?? "").replace(/\/\d+$/, ""),
        available_sizes: [],
        in_stock: false,
      });
    }

    const group = groups.get(gid);
    const size = String(item.size ?? "").trim();
    const inStock = String(item.availability) === "in_stock";

    if (size && size !== "ONESIZE" && !group.available_sizes.includes(size)) {
      group.available_sizes.push(size);
    }
    if (inStock) group.in_stock = true;
  }

  return groups;
}

// ── 3. Hämta Noselake ──────────────────────────────────────────────────────
// Searcher-endpointen ignorerar `from`/`size` men respekterar `hits`.
// En enda request hämtar hela katalogen — samma approach som
// fetch_descriptions.py i prisjakt-filter-repot.
async function fetchAllNoselake() {
  console.log("📥  Hämtar Noselake-API...");

  const url = `${NOSELAKE_URL}?q=&site=Loplabbet&hits=${NOSELAKE_HITS}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "loplabbet-typesense-sync/3.0 (+https://github.com/antonlundin-loplabbet)",
      "Accept": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Noselake fetch failed: ${res.status}`);
  const json = await res.json();

  const products = json?.data?.products ?? {};
  const docs = products.documents ?? [];
  const total = products.numberOfHits ?? docs.length;

  console.log(`    ✅  ${docs.length} av ${total} Noselake-produkter hämtade.`);

  if (docs.length < total) {
    console.warn(`    ⚠️   Färre returnerades än totalen — höj NOSELAKE_HITS över ${total}.`);
  }

  // Sanity-check: räkna unika itemnumbers så vi snabbt ser om vi tappar duplicering
  const unique = new Set(docs.map(d => String(d.itemnumber ?? "")).filter(Boolean));
  console.log(`    🔎 ${unique.size} unika itemnumbers (${(docs.length / Math.max(unique.size, 1)).toFixed(2)} docs/itemnumber)`);

  return docs;
}

// ── 4. Bygg multi-key Noselake-map ─────────────────────────────────────────
// Lägger samma doc under flera nycklar för att maximera träff
function buildNoselakeMap(docs) {
  const map = new Map();
  for (const doc of docs) {
    const candidates = makeKeyCandidates(doc.itemnumber);
    for (const key of candidates) {
      // Behåll första matchning per nyckel (specifika 9-siffror har företräde)
      if (!map.has(key)) map.set(key, doc);
    }
  }
  console.log(`    Noselake-map byggd med ${map.size} nyckelvarianter från ${docs.length} produkter.`);
  return map;
}

// ── 5. Slå ihop ────────────────────────────────────────────────────────────
function mergeProducts(prisjaktGroups, noselakeMap) {
  const merged = [];
  let matchedCount = 0;
  const unmatchedSamples = [];

  for (const [gid, product] of prisjaktGroups) {
    // Testa flera nyckelkandidater
    const candidates = makeKeyCandidates(gid);
    let nl = null;
    for (const key of candidates) {
      if (noselakeMap.has(key)) { nl = noselakeMap.get(key); break; }
    }

    if (nl) {
      matchedCount++;
      product.description = String(nl.description ?? "").substring(0, 2000);
      product.popularity = parseFloat(nl.popularity ?? "0") || 0;

      const rawFacets = nl.dynamic_facets ?? [];
      const facets = Array.isArray(rawFacets) ? rawFacets : [rawFacets];
      for (const f of facets) {
        switch (f.filterkey) {
          case "Drop":       product.drop = String(f.filtervalue); break;
          case "Stabilitet": product.stability = String(f.filtervalue); break;
          case "Dämpning":   product.cushioning = String(f.filtervalue); break;
          case "Läst":       product.last_width = String(f.filtervalue); break;
        }
      }

      const weightFacet = nl.dynamic_range_facets;
      if (weightFacet?.filterkey === "Vikt") {
        product.weight_grams = parseInt(weightFacet.filtervalue) || null;
      }

      const colors = (nl.colors ?? [])
        .map((c) => c.name)
        .filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i);
      if (colors.length) product.colors = colors;

      if (nl.commercialname) {
        product.name = String(nl.commercialname).trim();
      }
    } else {
      product.description = product.name;
      product.popularity = 0;
      if (unmatchedSamples.length < 5) {
        unmatchedSamples.push({ gid, candidates, name: product.name });
      }
    }

    merged.push(product);
  }

  console.log(`\n📊  Matchningsstatistik:`);
  console.log(`    ✅  Berikade med Noselake-data: ${matchedCount} / ${merged.length}`);
  console.log(`    ❌  Ej matchade: ${merged.length - matchedCount}`);
  if (unmatchedSamples.length > 0) {
    console.log(`    🔎 Exempel på ej matchade Prisjakt-ID:n:`);
    for (const s of unmatchedSamples) {
      console.log(`         "${s.gid}" (kandidater: ${JSON.stringify(s.candidates)}) — ${s.name}`);
    }
  }

  return merged;
}

// ── 6. Upsert ──────────────────────────────────────────────────────────────
async function upsertToTypesense(products) {
  console.log(`\n📤  Synkar ${products.length} produkter till Typesense...`);
  const BATCH = 250;
  let ok = 0, fail = 0;

  for (let i = 0; i < products.length; i += BATCH) {
    const batch = products.slice(i, i + BATCH);
    const ndjson = batch.map((p) => JSON.stringify(p)).join("\n");
    const res = await fetch(
      `https://${TYPESENSE_HOST}/collections/${COLLECTION}/documents/import?action=upsert`,
      { method: "POST", headers: tsHeaders, body: ndjson }
    );
    const text = await res.text();
    const lines = text.trim().split("\n");
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        r.success ? ok++ : fail++;
        if (!r.success) console.warn("  ⚠️", r.error, r.document?.id);
      } catch {
        fail++;
      }
    }
    process.stdout.write(`\r    ${Math.min(i + BATCH, products.length)} / ${products.length} (✅ ${ok} ❌ ${fail})`);
  }
  console.log(`\n\n─────────────────────────────────`);
  console.log(`✅  Lyckades:     ${ok}`);
  console.log(`❌  Misslyckades: ${fail}`);
  console.log(`─────────────────────────────────`);
}

function cleanTitle(title) {
  return String(title ?? "")
    .replace(/\s+(XS|S|M|L|XL|2XL|3XL|\d{2,3}(\.\d+)?)\s*$/i, "")
    .trim();
}

function normalizeGender(g) {
  const s = String(g ?? "").toLowerCase();
  if (s.includes("dam") || s.includes("women")) return "Dam";
  if (s.includes("herr") || s.includes("men")) return "Herr";
  return "Unisex";
}

// Härleder skotyp från namn-suffix (Anton's namnkonvention).
// Returnerar tom sträng för icke-skor — möjliggör strikta filter
// som "shoe_type:=Tävling" utan att dra in löparbälten/klockor/kläder.
function deriveShoeType(title) {
  const upper = String(title ?? "").toUpperCase();
  if (upper.endsWith("KOLFIBERSKOR"))   return "Tävling";
  if (upper.endsWith("TRAILSKOR"))      return "Trail";
  if (upper.endsWith("PROMENADSKOR"))   return "Promenad";
  if (upper.endsWith("LÖPARSKOR"))      return "Löpning";
  return "";
}

async function main() {
  console.log("🚀  Löplabbet Typesense Sync v2 startar...\n");
  const t0 = Date.now();

  const [prisjaktItems, noselakeDocs] = await Promise.all([
    fetchPrisjaktFeed(),
    fetchAllNoselake(),
  ]);

  const prisjaktGroups = groupPrisjaktItems(prisjaktItems);
  console.log(`\n📦  ${prisjaktGroups.size} unika produktgrupper från Prisjakt.`);

  const noselakeMap = buildNoselakeMap(noselakeDocs);
  const products = mergeProducts(prisjaktGroups, noselakeMap);

  await upsertToTypesense(products);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n⏱️   Klar på ${elapsed}s`);
}

main().catch((err) => { console.error("💥  Oväntat fel:", err); process.exit(1); });
