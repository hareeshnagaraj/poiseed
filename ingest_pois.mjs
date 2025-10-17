import fs from "fs/promises";
import path from "path";
import process from "process";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

/* ─────────────────────────────────────────────
   CLI: Ingest POIs from a JSON file and POST in bulk
   Usage examples:
     node ingest_pois.mjs --file tmp1.json --baseUrl http://localhost:3000 --batch 100
   Env:
     ADMIN_TOKEN (required)
     BASE_URL (optional; defaults to http://localhost:3000)
───────────────────────────────────────────── */

function parseArgs() {
  const args = process.argv.slice(2);
  let filePath = "tmp1.json";
  let baseUrl = process.env.BASE_URL || "http://localhost:3000";
  let batchSize = 100;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && i + 1 < args.length) {
      filePath = args[i + 1];
      i++;
    } else if (args[i] === "--baseUrl" && i + 1 < args.length) {
      baseUrl = args[i + 1];
      i++;
    } else if (args[i] === "--batch" && i + 1 < args.length) {
      batchSize = Math.max(1, parseInt(args[i + 1]));
      i++;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    }
  }

  return { filePath, baseUrl, batchSize, dryRun };
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function coerceNumber(value) {
  if (typeof value === "number") return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapToPayload(entry) {
  const name = (entry.name || "").toString().trim();
  const description = (entry.description || entry.vicinity || "").toString();

  const lat = entry.latitude ?? entry.lat ?? entry.geometry?.location?.lat ?? entry._original?.geometry?.location?.lat ?? null;
  const lon = entry.longitude ?? entry.lon ?? entry.lng ?? entry.geometry?.location?.lng ?? entry._original?.geometry?.location?.lng ?? null;

  const latitude = coerceNumber(lat);
  const longitude = coerceNumber(lon);

  const category = (entry.category || "misc").toString();

  return {
    name,
    description,
    latitude,
    longitude,
    category,
    is_active: true
  };
}

function isValidPayload(p) {
  return (
    typeof p.name === "string" && p.name.length > 0 &&
    typeof p.latitude === "number" && Number.isFinite(p.latitude) && p.latitude >= -90 && p.latitude <= 90 &&
    typeof p.longitude === "number" && Number.isFinite(p.longitude) && p.longitude >= -180 && p.longitude <= 180 &&
    typeof p.category === "string" && p.category.length > 0
  );
}

async function readPois(filePath) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  const raw = await fs.readFile(absolutePath, "utf8");
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse JSON at ${absolutePath}: ${e.message}`);
  }

  let items = [];
  if (Array.isArray(json)) {
    items = json;
  } else if (json && typeof json === "object") {
    // Attempt common shapes: { results: [...] } or { data: [...] }
    if (Array.isArray(json.results)) items = json.results;
    else if (Array.isArray(json.data)) items = json.data;
    else items = Object.values(json).flatMap(v => (Array.isArray(v) ? v : []));
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Input JSON does not contain an array of POIs");
  }

  const mapped = items.map(mapToPayload);
  const valid = mapped.filter(isValidPayload);

  const skipped = mapped.length - valid.length;
  console.log(`📦 Loaded ${items.length} items → ${valid.length} valid payloads (${skipped} skipped)`);
  return valid;
}

async function postBatch(baseUrl, adminToken, batch) {
  const url = `${baseUrl.replace(/\/$/, "")}/api/admin/pois/bulk`;
  const headers = {
    "Content-Type": "application/json",
    "x-admin-token": adminToken
  };

  const { data } = await axios.post(url, batch, { headers, timeout: 30000 });
  return data;
}

async function main() {
  const { filePath, baseUrl, batchSize, dryRun } = parseArgs();
  const adminToken = process.env.ADMIN_TOKEN;

  if (!adminToken) {
    console.error("❌ ADMIN_TOKEN env var is required");
    process.exit(1);
  }

  console.log(`🔗 Target: ${baseUrl}  |  File: ${filePath}  |  Batch: ${batchSize}${dryRun ? "  |  DRY-RUN" : ""}`);
  console.log(`🔑 Admin token: ${adminToken.substring(0, 8)}...${adminToken.substring(adminToken.length - 4)} (${adminToken.length} chars)`);

  try {
    const payloads = await readPois(filePath);
    const batches = chunkArray(payloads, batchSize);

    let totalCreated = 0;
    let totalSkipped = 0;
    let totalBatches = 0;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`🚀 Posting batch ${i + 1}/${batches.length} (${batch.length} items)...`);
      if (dryRun) {
        console.log("   🧪 Dry-run: skipping POST");
        totalBatches++;
        continue;
      }
      try {
        const res = await postBatch(baseUrl, adminToken, batch);
        const created = Number(res?.createdCount || 0);
        const skipped = Number(res?.skippedCount || 0);
        totalCreated += created;
        totalSkipped += skipped;
        totalBatches++;
        console.log(`   ✅ created=${created}, skipped=${skipped}`);
      } catch (err) {
        console.error(`   ❌ Batch ${i + 1} failed: ${err.message}`);
        // brief delay before continuing
        await new Promise(r => setTimeout(r, 1000));
      }
      // simple pacing to be polite
      await new Promise(r => setTimeout(r, 200));
    }

    console.log(`\n🎯 Done. Batches: ${totalBatches}, Created: ${totalCreated}, Skipped: ${totalSkipped}`);
  } catch (e) {
    console.error(`❌ Ingest failed: ${e.message}`);
    process.exit(1);
  }
}

main();


