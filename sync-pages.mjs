/**
 * sync-pages.mjs (v5 — whitelist edition)
 *
 * Hämtar loplabbet.se sitemap, släpper bara igenom URL:er som börjar
 * med ett godkänt prefix (guider, landningssidor, info-sidor),
 * och synkar till Typesense "pages"-kollektionen.
 *
 * Att lägga till/ta bort en kategori = redigera ALLOWED_PREFIXES nedan.
 */

import { XMLParser } from "fast-xml-parser";
import * as cheerio from "cheerio";

const TYPESENSE_HOST = process.env.TYPESENSE_HOST;
const TYPESENSE_KEY = process.env.TYPESENSE_ADMIN_KEY;
const COLLECTION = "pages";

const SITEMAP_URL = "https://www.loplabbet.se/sitemap.xml";

// ─────────────────────────────────────────────────────────────────────────
// WHITELIST: bara URL:er som börjar med något av dessa prefix släpps in.
// Motsvarar EpiServer-trädet: guider + landningssidor + info-sidor.
// Lägg till/ta bort efter behov.
// ─────────────────────────────────────────────────────────────────────────
const ALLOWED_PREFIXES = [
  "/produktguider",              // Produktguider (alla underkategorier)
  "/landningssida",              // Landningssidor
  "/loplabbet-tipsar",           // Löplabbet Tipsar (artiklar, tips, profiler)
  "/tidsbokning",                // Tidsbokning + ortopedteknik, löpteknikanalys, Löplabbetmetoden
  "/om-loplabbet",               // Om Löplabbet
  "/team-loplabbet",             // Team Löplabbet
  "/vara-butiker",               // Våra butiker
  "/butiker",                    // (alt-URL om "Våra butiker" råkar bo här)
  "/varumarken",                 // Varumärkessidor
  "/kundservice",                // Kundservice
  "/rea",                        // Rea-landningssida
  "/allmanna-kopvillkor",        // Köpvillkor
  "/tillganglighetsredogorelse", // Tillgänglighetsredogörelse
];

const CONCURRENCY = 5;
const FETCH_DELAY_MS = 100;

if (!TYPESENSE_HOST || !TYPESENSE_KEY) {
  console.error("❌  Sätt TYPESENSE_HOST och TYPESENSE_ADMIN_KEY.");
  process.exit(1);
}

const tsHeaders = {
  "Content-Type": "application/x-ndjson",
  "X-TYPESENSE-API-KEY": TYPESENSE_KEY,
};

// ── 1. Hämta sitemap ───────────────────────────────────────────────────────
async function fetchSitemap() {
  console.log("📥  Hämtar sitemap...");
  const res = await fetch(SITEMAP_URL);
  if (!res.ok) throw new Error(`Sitemap fetch failed: ${res.status}`);
  const xml = await res.text();

  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);
  const urls = parsed?.urlset?.url ?? [];

  const list = urls.map((u) => ({
    url: String(u.loc),
    lastmod: u.lastmod ? Math.floor(new Date(u.lastmod).getTime() / 1000) : 0,
  }));

  console.log(`    ${list.length} URLer i sitemap.`);
  return list;
}

// ── 2. Whitelist-filter ────────────────────────────────────────────────────
function filterUrls(urls) {
  const matchedByPrefix = new Map(ALLOWED_PREFIXES.map((p) => [p, 0]));
  const filtered = [];

  for (const item of urls) {
    let path;
    try {
      path = new URL(item.url).pathname.toLowerCase();
    } catch {
      continue;
    }

    // Matcha mot whitelist. Kräv antingen exakt match ELLER prefix följt av "/"
    // så att "/rea" inte råkar matcha "/realtid-nyheter" om det skulle finnas.
    const matched = ALLOWED_PREFIXES.find(
      (prefix) => path === prefix || path.startsWith(prefix + "/")
    );

    if (matched) {
      matchedByPrefix.set(matched, matchedByPrefix.get(matched) + 1);
      filtered.push(item);
    }
  }

  console.log(`    ${filtered.length} URLer matchar whitelist:`);
  for (const [prefix, count] of matchedByPrefix) {
    if (count > 0) console.log(`        ${prefix.padEnd(34)} ${count}`);
  }
  const zeroPrefixes = [...matchedByPrefix].filter(([_, c]) => c === 0).map(([p]) => p);
  if (zeroPrefixes.length) {
    console.log(`    ⚠️  Prefix utan träffar (kontrollera stavning): ${zeroPrefixes.join(", ")}`);
  }

  return filtered;
}

// ── 3. Hämta och parsa enskild sida ────────────────────────────────────────
async function fetchPage({ url, lastmod }) {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);

    const title = ($("title").first().text() || $("h1").first().text() || "").trim();
    const description =
      $('meta[name="description"]').attr("content") ||
      $('meta[property="og:description"]').attr("content") ||
      "";

    let mainText = "";
    const mainSelectors = ["main", "article", "[role='main']", ".content", "#content"];
    for (const sel of mainSelectors) {
      const el = $(sel).first();
      if (el.length) {
        mainText = el.text().replace(/\s+/g, " ").trim();
        break;
      }
    }
    if (!mainText) {
      mainText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 5000);
    }

    if (!title) return null;

    return {
      id: Buffer.from(url).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 64),
      url,
      title,
      description: description.trim(),
      content: mainText.slice(0, 3000),
      lastmod,
    };
  } catch (err) {
    console.warn(`    ⚠️  Kunde inte hämta ${url}: ${err.message}`);
    return null;
  }
}

// ── 4. Hämta alla sidor med begränsad parallellism ─────────────────────────
async function fetchAllPages(urls) {
  console.log(`📄  Hämtar ${urls.length} sidor (concurrency=${CONCURRENCY})...`);
  const results = [];

  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map((u) => fetchPage(u)));

    for (const r of batchResults) {
      if (r) results.push(r);
    }

    process.stdout.write(`\r    ${Math.min(i + CONCURRENCY, urls.length)} / ${urls.length} klar`);
    await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
  }

  console.log(`\n    ${results.length} sidor extraherade.`);
  return results;
}

// ── 5. Skicka till Typesense ───────────────────────────────────────────────
async function upsertToTypesense(pages) {
  console.log(`📤  Synkar ${pages.length} sidor till Typesense...`);
  const ndjson = pages.map((p) => JSON.stringify(p)).join("\n");

  const res = await fetch(
    `https://${TYPESENSE_HOST}/collections/${COLLECTION}/documents/import?action=upsert`,
    { method: "POST", headers: tsHeaders, body: ndjson }
  );

  const text = await res.text();
  const lines = text.split("\n").filter(Boolean);
  let ok = 0, fail = 0;
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      r.success ? ok++ : fail++;
      if (!r.success) console.warn("  ⚠️", r.error, r.document?.id);
    } catch {
      fail++;
    }
  }

  console.log(`\n─────────────────────────────────`);
  console.log(`✅  Lyckades:     ${ok}`);
  console.log(`❌  Misslyckades: ${fail}`);
  console.log(`─────────────────────────────────`);
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀  Löplabbet Pages Sync v5 (whitelist) startar...\n");
  const t0 = Date.now();

  const sitemapUrls = await fetchSitemap();
  const filtered = filterUrls(sitemapUrls);
  const pages = await fetchAllPages(filtered);
  await upsertToTypesense(pages);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n⏱️   Klar på ${elapsed}s`);
}

main().catch((err) => {
  console.error("💥  Oväntat fel:", err);
  process.exit(1);
});
