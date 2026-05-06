/**
 * create-pages-collection.mjs
 * Skapar Typesense-kollektionen för sidor (landningssidor, guider, kundservice).
 * Kör EN GÅNG.
 *
 * Kör med:
 *   TYPESENSE_HOST=xxx TYPESENSE_ADMIN_KEY=xxx node create-pages-collection.mjs
 *
 * Återskapa:
 *   ... RECREATE=true node create-pages-collection.mjs
 */

const HOST = process.env.TYPESENSE_HOST;
const API_KEY = process.env.TYPESENSE_ADMIN_KEY;
const COLLECTION = "pages";
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
    { name: "id", type: "string" },
    { name: "title", type: "string" },
    { name: "description", type: "string" },
    { name: "content", type: "string" },
    { name: "url", type: "string", index: false },
    { name: "section", type: "string", facet: true },
    { name: "lastmod", type: "int64" },
  ],
  default_sorting_field: "lastmod",
};

async function run() {
  if (RECREATE) {
    console.log(`🗑️   Raderar befintlig kollektion "${COLLECTION}"...`);
    const del = await fetch(`${base}/collections/${COLLECTION}`, {
      method: "DELETE",
      headers,
    });
    if (del.ok) console.log("✅  Raderad.");
    else if (del.status === 404) console.log("ℹ️   Fanns inte — fortsätter.");
  }

  console.log(`🔄  Skapar kollektion "${COLLECTION}"...`);
  const res = await fetch(`${base}/collections`, {
    method: "POST",
    headers,
    body: JSON.stringify(schema),
  });

  const body = await res.json();
  if (res.ok) console.log(`✅  Kollektion skapad! ${body.fields?.length} fält.`);
  else if (res.status === 409) console.log("ℹ️   Kollektionen finns redan.");
  else {
    console.error(`❌  Fel:`, body);
    process.exit(1);
  }
}

run();
