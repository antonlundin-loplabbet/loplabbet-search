/**
 * create-collection.mjs
 * Skapar Typesense-kollektionen med rätt schema.
 * Kör EN GÅNG när du sätter upp projektet.
 *
 * Kör med:
 *   TYPESENSE_HOST=xxx TYPESENSE_ADMIN_KEY=xxx node create-collection.mjs
 *
 * Vill du radera och återskapa (vid schema-ändringar):
 *   TYPESENSE_HOST=xxx TYPESENSE_ADMIN_KEY=xxx RECREATE=true node create-collection.mjs
 */

const HOST = process.env.TYPESENSE_HOST;
const API_KEY = process.env.TYPESENSE_ADMIN_KEY;
const COLLECTION = "products";
const RECREATE = process.env.RECREATE === "true";

if (!HOST || !API_KEY) {
  console.error("❌  Sätt TYPESENSE_HOST och TYPESENSE_ADMIN_KEY.");
  process.exit(1);
}

const base = `https://${HOST}`;
const headers = {
  "Content-Type": "application/json",
  "X-TYPESENSE-API-KEY": API_KEY,
};

const schema = {
  name: COLLECTION,
  fields: [
    // ── Identifiering ──────────────────────────────────────────────
    { name: "id", type: "string" },               // item_group_id / itemnumber
    { name: "name", type: "string", infix: true },             // Produktnamn (commercialname)
    { name: "brand", type: "string", facet: true, infix: true },
    { name: "gender", type: "string", facet: true },

    // ── Kategorier ─────────────────────────────────────────────────
    { name: "category", type: "string", facet: true },     // t.ex. "Löparskor"
    { name: "subcategory", type: "string", facet: true },  // t.ex. "Terräng"
    { name: "shoe_type", type: "string", facet: true, optional: true }, // Härleds från namn-suffix: Tävling/Trail/Promenad/Löpning

    // ── Priser ─────────────────────────────────────────────────────
    { name: "price", type: "float" },
    { name: "sale_price", type: "float", optional: true },
    { name: "on_sale", type: "bool", facet: true },
    { name: "discount_percent", type: "int32", optional: true },

    // ── Tillgänglighet ─────────────────────────────────────────────
    { name: "in_stock", type: "bool", facet: true },
    { name: "available_sizes", type: "string[]", facet: true },

    // ── Sökbar text ────────────────────────────────────────────────
    { name: "description", type: "string", infix: true },

    // ── Media & URL (ej indexerade) ────────────────────────────────
    { name: "image_url", type: "string", index: false },
    { name: "product_url", type: "string", index: false },

    // ── Ranking ────────────────────────────────────────────────────
    { name: "popularity", type: "float" },

    // ── Skofacetter (optional — finns bara för skor) ───────────────
    { name: "drop", type: "string", optional: true, facet: true },
    { name: "stability", type: "string", optional: true, facet: true },
    { name: "cushioning", type: "string", optional: true, facet: true },
    { name: "last_width", type: "string", optional: true, facet: true },
    { name: "weight_grams", type: "int32", optional: true },

    // ── Färger ─────────────────────────────────────────────────────
    { name: "colors", type: "string[]", optional: true, facet: true },
  ],

  // Standardsortering: popularitet fallande
  default_sorting_field: "popularity",
};

async function run() {
  // Radera om RECREATE=true
  if (RECREATE) {
    console.log(`🗑️   Raderar befintlig kollektion "${COLLECTION}"...`);
    const del = await fetch(`${base}/collections/${COLLECTION}`, {
      method: "DELETE",
      headers,
    });
    if (del.ok) console.log("✅  Raderad.");
    else if (del.status === 404) console.log("ℹ️   Fanns inte — fortsätter.");
    else console.warn(`⚠️   Svar: ${del.status}`);
  }

  // Skapa kollektion
  console.log(`\n🔄  Skapar kollektion "${COLLECTION}"...`);
  const res = await fetch(`${base}/collections`, {
    method: "POST",
    headers,
    body: JSON.stringify(schema),
  });

  const body = await res.json();

  if (res.ok) {
    console.log(`✅  Kollektion skapad!`);
    console.log(`    Fält: ${body.fields?.length}`);
  } else if (res.status === 409) {
    console.log(`ℹ️   Kollektionen finns redan. Kör med RECREATE=true för att återskapa.`);
  } else {
    console.error(`❌  Fel ${res.status}:`, body);
    process.exit(1);
  }
}

run();
