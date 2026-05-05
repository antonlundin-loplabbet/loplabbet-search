/**
 * sync.mjs
 * Hämtar Prisjakt-feed + Noselake API, slår ihop och synkar till Typesense.
 *
 * Kör manuellt:
 *   TYPESENSE_HOST=xxx TYPESENSE_ADMIN_KEY=xxx node sync.mjs
 *
 * Körs automatiskt via GitHub Actions varje natt kl 03:00.
 */

import { XMLParser } from "fast-xml-parser";

// ── Konfiguration ──────────────────────────────────────────────────────────
const TYPESENSE_HOST = process.env.TYPESENSE_HOST;
const TYPESENSE_KEY = process.env.TYPESENSE_ADMIN_KEY;
const COLLECTION = "products";

const PRISJAKT_URL =
  "https://cdn.intersport.se/pricefiles/v2/loplabbet-prisjakt-v1.xml";
const NOSELAKE_URL =
  "https://services.intersport.se/api/noselake/searcher/website";
const NOSELAKE_PAGE_SIZE = 100;

if (!TYPESENSE_HOST || !TYPESENSE_KEY) {
  console.error("❌  Sätt TYPESENSE_HOST och TYPESENSE_ADMIN_KEY.");
  process.exit(1);
}

const tsHeaders = {
  "Content-Type": "application/x-ndjson",
  "X-TYPESENSE-API-KEY": TYPESENSE_KEY,
};

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
  return items;
}

// ── 2. Gruppera Prisjakt per item_group_id ─────────────────────────────────
function groupPrisjaktItems(items) {
  const groups = new Map();

  for (const item of items) {
    const gid = String(item.item_group_id);

    if (!groups.has(gid)) {
      // Rensa pris-strängar: "2099 SEK" → 2099
      const price = parseFloat(String(item.price).replace(/[^\d.]/g, ""));
      const saleStr = String(item.sale_price ?? "").replace(/[^\d.]/g, "");
      const salePrice = saleStr ? parseFloat(saleStr) : null;

      // Kategorier: "Löparskor_Terräng" → ["Löparskor", "Terräng"]
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
        product_url: String(item.link ?? "").replace(/\/\d+$/, ""), // ta bort sista /storlek
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

// ── 3. Hämta alla Noselake-produkter (paginerat) ───────────────────────────
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

    // Kort paus för att inte hammra API:et
    await sleep(150);
  }

  console.log(`\n    ✅  ${allDocs.length} Noselake-produkter hämtade.`);
  return allDocs;
}

// ── 4. Bygg Noselake-lookup map ─────────────────────────────────────────────
function buildNoselakeMap(docs) {
  const map = new Map();
  for (const doc of docs) {
    const key = String(doc.itemnumber ?? "").trim();
    if (key) map.set(key, doc);
  }
  return map;
}

// ── 5. Slå ihop Prisjakt + Noselake ────────────────────────────────────────
function mergeProducts(prisjaktGroups, noselakeMap) {
  const merged = [];

  for (const [gid, product] of prisjaktGroups) {
    const nl = noselakeMap.get(gid);

    if (nl) {
      // Berika med Noselake-data
      product.description = String(nl.description ?? "").substring(0, 2000);
      product.popularity = parseFloat(nl.popularity ?? "0") || 0;

      // Dynamiska facetter (Drop, Stabilitet, Dämpning, Läst)
      const facets = nl.dynamic_facets ?? [];
      for (const f of facets) {
        switch (f.filterkey) {
          case "Drop":
            product.drop = String(f.filtervalue);
            break;
          case "Stabilitet":
            product.stability = String(f.filtervalue);
            break;
          case "Dämpning":
            product.cushioning = String(f.filtervalue);
            break;
          case "Läst":
            product.last_width = String(f.filtervalue);
            break;
        }
      }

      // Vikt
      const weightFacet = nl.dynamic_range_facets;
      if (weightFacet?.filterkey === "Vikt") {
        product.weight_grams = parseInt(weightFacet.filtervalue) || null;
      }

      // Färger
      const colors = (nl.colors ?? [])
        .map((c) => c.name)
        .filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i);
      if (colors.length) product.colors = colors;

      // Bättre produktnamn från Noselake om tillgängligt
      if (nl.commercialname) {
        product.name = String(nl.commercialname).trim();
      }
    } else {
      // Ingen Noselake-matchning — sätt defaults
      product.description = product.name;
      product.popularity = 0;
    }

    merged.push(product);
  }

  console.log(
    `    Matchade: ${merged.filter((p) => p.description !== p.name).length} / ${merged.length} produkter berikade med Noselake.`
  );
  return merged;
}

// ── 6. Upserta till Typesense i batchar ────────────────────────────────────
async function upsertToTypesense(products) {
  console.log(`\n📤  Synkar ${products.length} produkter till Typesense...`);

  const BATCH = 250;
  let ok = 0;
  let fail = 0;

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

    process.stdout.write(
      `\r    ${Math.min(i + BATCH, products.length)} / ${products.length} (✅ ${ok} ❌ ${fail})`
    );
  }

  console.log(`\n\n─────────────────────────────────`);
  console.log(`✅  Lyckades:     ${ok}`);
  console.log(`❌  Misslyckades: ${fail}`);
  console.log(`─────────────────────────────────`);
}

// ── Hjälpfunktioner ────────────────────────────────────────────────────────
function cleanTitle(title) {
  // Ta bort storleksinformation på slutet: "... XL" eller "... EU 42"
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀  Löplabbet Typesense Sync startar...\n");
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

main().catch((err) => {
  console.error("💥  Oväntat fel:", err);
  process.exit(1);
});
