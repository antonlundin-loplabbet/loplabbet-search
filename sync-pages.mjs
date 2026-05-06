/**
 * sync-pages.mjs
 * Hämtar loplabbet.se sitemap, fetchar varje sida, extraherar innehåll
 * och synkar till Typesense "pages"-kollektionen.
 */

import { XMLParser } from "fast-xml-parser";
import * as cheerio from "cheerio";

const TYPESENSE_HOST = process.env.TYPESENSE_HOST;
const TYPESENSE_KEY = process.env.TYPESENSE_ADMIN_KEY;
const COLLECTION = "pages";

const SITEMAP_URL = "https://www.loplabbet.se/sitemap.xml";

// Skip dessa path-prefix: produktsidor (finns redan i products) + tekniska sidor
const SKIP_PREFIXES = [
  "/katalog",
  "/varukorg",
  "/kassa",
  "/mina-sidor",
  "/inloggning",
  "/orderbekraftelse",
  "/skovaljaren",
];

// Parallella fetches åt gången (snäll mot servern)
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

// ── 2. Filtrera bort sidor vi inte vill ha med ────────────────────────────
function filterUrls(urls) {
  const filtered = urls.filter(({ url }) => {
    try {
      const path = new URL(url).pathname;
      return !SKIP_PREFIXES.some((prefix) => path.startsWith(prefix));
    } catch {
      return false;
    }
  });
  console.log(`    ${filtered.length} URLer efter filtrering.`);
  return filtered;
}

// ── 3. Hämta och extrahera innehåll från en sida ──────────────────────────
async function fetchAndExtract({ url, lastmod }) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Loplabbet-Search-Indexer/1.0" },
      redirect: "follow",
    });
    if (!res.ok) return null;

    const html = await res.text();
    const $ = cheerio.load(html);

    // Rensa bort skräp innan vi extraherar text
    $("script, style, nav, header, footer, aside, .cookie-banner, .breadcrumb").remove();

    // Titel: <title> → första <h1> → URL-slug
    let title = $("title").first().text().trim();
    title = title.replace(/\s*[\|\-–—]\s*Löplabbet.*$/i, "").trim();
    if (!title) title = $("h1").first().text().trim();
    if (!title) title = url.split("/").filter(Boolean).pop() || "Sida";

    // Meta description
    const description =
      $('meta[name="description"]').attr("content")?.trim() ||
      $('meta[property="og:description"]').attr("content")?.trim() ||
      "";

    // Brödtext: helst <main>, annars <article>, annars <body>
    const $body = $("main").length ? $("main") : $("article").length ? $("article") : $("body");
    let content = $body.text().replace(/\s+/g, " ").trim();

    // Begränsa innehållet (Typesense har ~5MB per dokument, men vi vill hålla index lean)
    if (content.length > 5000) content = content.substring(0, 5000);

    // Hoppa över tomma sidor
    if (!content || content.length < 50) return null;

    // Sektion utifrån URL-path: /produktguider/... → "Produktguider"
    const path = new URL(url).pathname;
    const sectionSlug = path.split("/").filter(Boolean)[0] || "Övrigt";
    const section = sectionSlug
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

    // ID från path (Typesense-vänligt: alphanumeriskt)
    const id = path
      .replace(/[^a-zA-Z0-9]/g, "_")
      .replace(/^_+|_+$/g, "")
      .substring(0, 200) || "root";

    return {
      id,
      title,
      description,
      content,
      url,
      section,
      lastmod,
    };
  } catch (e) {
    console.warn(`  ⚠️  ${url}: ${e.message}`);
    return null;
  }
}

// ── 4. Hämta alla parallellt med rate-limit ───────────────────────────────
async function fetchAllPages(urls) {
  console.log(`📥  Hämtar ${urls.length} sidor (parallellt ${CONCURRENCY} åt gången)...`);
  const results = [];
  let done = 0;

  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const docs = await Promise.all(batch.map(fetchAndExtract));

    for (const doc of docs) {
      if (doc) results.push(doc);
    }

    done += batch.length;
    process.stdout.write(`\r    ${done} / ${urls.length} (extraherade: ${results.length})`);

    if (i + CONCURRENCY < urls.length) {
      await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
    }
  }

  console.log(`\n    ✅  ${results.length} sidor extraherade.`);
  return results;
}

// ── 5. Upserta till Typesense ──────────────────────────────────────────────
async function upsertToTypesense(pages) {
  console.log(`\n📤  Synkar ${pages.length} sidor till Typesense...`);

  const BATCH = 100;
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < pages.length; i += BATCH) {
    const batch = pages.slice(i, i + BATCH);
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

    process.stdout.write(`\r    ${Math.min(i + BATCH, pages.length)} / ${pages.length} (✅ ${ok} ❌ ${fail})`);
  }

  console.log(`\n\n─────────────────────────────────`);
  console.log(`✅  Lyckades:     ${ok}`);
  console.log(`❌  Misslyckades: ${fail}`);
  console.log(`─────────────────────────────────`);
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀  Löplabbet Pages Sync startar...\n");
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
