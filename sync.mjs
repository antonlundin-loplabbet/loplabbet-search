/**
 * sync.mjs (v2 — fixad ID-matchning)
 * Hämtar Prisjakt-feed + Noselake API, slår ihop och synkar till Typesense.
 *
 * Fix mot tidigare version: Prisjakts item_group_id och Noselakes itemnumber
 * matchade inte alls (bara 36/3582 träffade). Nu normaliseras båda till
 * en gemensam nyckel + vi loggar matchningsstatistik.
 */

import { XMLParser } from "fast-xml-parser";

const TYPESENSE_HOST = process.env.TYPESENSE_HOST;
const TYPESENSE_KEY = process.env.TYPESENSE_ADMIN_KEY;
const COLLECTION = "products";

const PRISJAKT_URL = "https://cdn.intersport.se/pricefiles/v2/loplabbet-prisjakt-v1.xml";
const NOSELAKE_URL = "https://services.intersport.se/api/noselake/searcher/website";
const NOSELAKE_PAGE_SIZE = 100;

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

      groups.set(gid, {
        id: gid,
        name: cleanTitle(item.title),
        brand: String(item.brand ?? "").trim(),
        gender: normalizeGender(item.gender),
        category: category ?? "",
        subcategory: subcategory ?? "",
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
async function fetchAllNoselake() {
  console.log("📥  Hämtar Noselake-API (alla sidor)...");
  const allDocs = [];
  let from = 0;

  while (true) {
    const url = `${NOSELAKE_URL}?q=&site=Loplabbet&from=${from}&size=${NOSELAKE_PAGE_SIZE}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Noselake fetch failed: ${res.status}`);
    const json = await res.json();

    const docs = json?.data?.products?.documents ?? [];
    allDocs.push(...docs);

    const total = json?.data?.stats?.totalHits ?? 0;
    from += NOSELAKE_PAGE_SIZE;
    process.stdout.write(`\r    ${allDocs.length} / ${total} produkter...`);
    if (from >= total) break;
    await sleep(150);
  }

  console.log(`\n    ✅  ${allDocs.length} Noselake-produkter hämtade.`);

  // DEBUG: visa exempel på itemnumber
  if (allDocs.length > 0) {
    const samples = allDocs.slice(0, 3).map(d => d.itemnumber);
    console.log(`    🔎 Noselake itemnumber-exempel: ${JSON.stringify(samples)}`);

    // DIAGNOSTIK: hur många docs har faktiskt itemnumber, och vilka fält finns?
    const withItemnumber = allDocs.filter(d => d.itemnumber).length;
    console.log(`    🔎 ${withItemnumber}/${allDocs.length} docs har itemnumber på toppnivå`);

    const firstDoc = allDocs[0];
    const midDoc = allDocs[Math.floor(allDocs.length / 2)];
    const lastDoc = allDocs[allDocs.length - 1];

    console.log(`    🔎 Fält i doc #0:    ${Object.keys(firstDoc).sort().join(", ")}`);
    console.log(`    🔎 Fält i doc #${Math.floor(allDocs.length / 2)}: ${Object.keys(midDoc).sort().join(", ")}`);
    console.log(`    🔎 Fält i doc #${allDocs.length - 1}: ${Object.keys(lastDoc).sort().join(", ")}`);

    // Hitta första doc UTAN itemnumber och dumpa hela strukturen
    const docWithout = allDocs.find(d => !d.itemnumber);
    if (docWithout) {
      console.log(`    🔎 Exempel på doc UTAN itemnumber (första 800 tecken):`);
      console.log(`       ${JSON.stringify(docWithout).slice(0, 800)}`);
    }
  }
  return allDocs;
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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
