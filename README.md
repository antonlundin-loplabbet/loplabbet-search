# loplabbet-search

Typesense-synk för Löplabbets produktsök. Hämtar data från Prisjakt-feed + Noselake API och indexerar i Typesense Cloud.

## Struktur

```
loplabbet-search/
├── create-collection.mjs   # Kör EN GÅNG — skapar Typesense-schemat
├── sync.mjs                # Daglig synk: feed + API → Typesense
├── import-synonyms.mjs     # Importerar synonymer till Typesense
├── typesense-synonyms.json # Synonymlistan
├── package.json
└── .github/
    └── workflows/
        └── sync.yml        # Kör sync.mjs automatiskt varje natt kl 03:00
```

## Kom igång

### 1. Lägg till GitHub Secrets

Gå till repo → Settings → Secrets and variables → Actions:

| Secret | Värde |
|--------|-------|
| `TYPESENSE_HOST` | Din host, t.ex. `xyz.typesense.net` |
| `TYPESENSE_ADMIN_KEY` | Admin API-nyckel |
| `TYPESENSE_SEARCH_KEY` | Search-only nyckel (används av frontend-widgeten) |

### 2. Installera beroenden

```bash
npm install
```

### 3. Skapa Typesense-kollektionen (görs en gång)

```bash
TYPESENSE_HOST=xxx TYPESENSE_ADMIN_KEY=xxx npm run create-collection
```

### 4. Importera synonymer

```bash
TYPESENSE_HOST=xxx TYPESENSE_ADMIN_KEY=xxx npm run import-synonyms
```

### 5. Kör första synken

```bash
TYPESENSE_HOST=xxx TYPESENSE_ADMIN_KEY=xxx npm run sync
```

### 6. Automatisk synk

GitHub Actions kör `sync.mjs` varje natt kl 03:00. Du kan också trigga manuellt under Actions-fliken i GitHub.

## Schema-ändringar

Om du behöver ändra schema (lägga till fält etc.):

```bash
TYPESENSE_HOST=xxx TYPESENSE_ADMIN_KEY=xxx RECREATE=true npm run create-collection
```

⚠️ Obs: `RECREATE=true` raderar och återskapar kollektionen. Kör sedan sync igen.
