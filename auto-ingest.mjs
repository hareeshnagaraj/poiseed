#!/usr/bin/env node
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import process from "process";

/* ─────────────────────────────────────────────
   Auto-fetch and ingest POIs in one command
   
   Usage:
     node auto-ingest.mjs --lat 40.7829 --lon -73.9654 --radius 500 --target 100
     node auto-ingest.mjs --lat 40.7829 --lon -73.9654 --categories restaurant,cafe --ai
   
   This script:
   1. Fetches POIs using index.mjs
   2. Writes them to a timestamped file
   3. Automatically ingests them to the server
   
   All index.mjs flags are supported (--radius, --categories, --ai, --target, etc.)
   Additional flags:
     --baseUrl <url>    API base URL (default: http://localhost:3000)
     --batch <n>        Batch size for ingestion (default: 100)
     --dry-run          Skip the actual POST to server
     --delete-file      Delete the JSON file after ingestion (default: keep)
     --no-ingest        Only fetch and save, skip ingestion
───────────────────────────────────────────── */

function parseArgs() {
  const args = process.argv.slice(2).map(arg => {
    // Normalize em-dashes and en-dashes to regular dashes (common copy-paste issue)
    return arg.replace(/^[—–]+/, '--');
  });
  const fetchArgs = [];
  let baseUrl = process.env.BASE_URL || "http://localhost:3000";
  let batchSize = 100;
  let dryRun = false;
  let deleteFile = false;
  let noIngest = false;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--baseUrl" && i + 1 < args.length) {
      baseUrl = args[i + 1];
      i++;
    } else if (args[i] === "--batch" && i + 1 < args.length) {
      batchSize = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--delete-file") {
      deleteFile = true;
    } else if (args[i] === "--no-ingest") {
      noIngest = true;
    } else {
      // Pass through to index.mjs
      fetchArgs.push(args[i]);
      if (args[i].startsWith("--") && i + 1 < args.length && !args[i + 1].startsWith("--")) {
        i++;
        fetchArgs.push(args[i]);
      }
    }
  }
  
  return { fetchArgs, baseUrl, batchSize, dryRun, deleteFile, noIngest };
}

function generateFilename() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  return `auto-${timestamp}.json`;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    console.log(`\n🚀 Running: ${command} ${args.join(" ")}\n`);
    
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: true
    });
    
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });
    
    child.on("error", (err) => {
      reject(err);
    });
  });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const { fetchArgs, baseUrl, batchSize, dryRun, deleteFile, noIngest } = parseArgs();
  
  // Validate that we have required args
  const hasLat = fetchArgs.includes("--lat");
  const hasLon = fetchArgs.includes("--lon");
  
  if (!hasLat && !hasLon) {
    console.log("ℹ️  No coordinates provided, using IP-based location detection");
  } else if (!hasLat || !hasLon) {
    console.error("❌ Error: Both --lat and --lon must be provided together");
    process.exit(1);
  }
  
  const filename = generateFilename();
  const outputPath = path.join(process.cwd(), filename);
  
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║         AUTO-FETCH AND INGEST POI WORKFLOW                    ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log(`📁 Output file: ${filename}`);
  console.log(`🔗 Target API: ${baseUrl}`);
  if (noIngest) {
    console.log(`⚠️  Ingestion disabled (--no-ingest)`);
  }
  console.log("");
  
  try {
    // Step 1: Fetch POIs
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📥 STEP 1: Fetching POIs from Google Places API");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    
    await runCommand("node", [
      "index.mjs",
      ...fetchArgs,
      "--json",
      "--out",
      filename
    ]);
    
    // Verify file was created
    const exists = await fileExists(outputPath);
    if (!exists) {
      throw new Error(`Failed to create output file: ${filename}`);
    }
    
    // Check file size
    const stats = await fs.stat(outputPath);
    const content = await fs.readFile(outputPath, "utf8");
    const pois = JSON.parse(content);
    
    console.log(`\n✅ Successfully fetched ${pois.length} POIs (${(stats.size / 1024).toFixed(1)} KB)`);
    
    if (pois.length === 0) {
      console.log("⚠️  No POIs to ingest, exiting.");
      if (deleteFile) {
        await fs.unlink(outputPath);
        console.log(`🗑️  Deleted empty file: ${filename}`);
      } else {
        console.log(`📁 Keeping file: ${filename}`);
      }
      return;
    }
    
    // Step 2: Ingest POIs
    if (!noIngest) {
      console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("📤 STEP 2: Ingesting POIs to server");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      
      const ingestArgs = [
        "ingest_pois.mjs",
        "--file",
        filename,
        "--baseUrl",
        baseUrl,
        "--batch",
        batchSize.toString()
      ];
      
      if (dryRun) {
        ingestArgs.push("--dry-run");
      }
      
      await runCommand("node", ingestArgs);
      
      console.log("\n✅ Ingestion complete!");
    }
    
    // Step 3: Cleanup
    if (deleteFile && !noIngest) {
      console.log(`\n🗑️  Cleaning up: deleting ${filename}...`);
      await fs.unlink(outputPath);
      console.log("✅ Cleanup complete");
    } else {
      console.log(`\n📁 Keeping file: ${filename}`);
    }
    
    console.log("\n╔════════════════════════════════════════════════════════════════╗");
    console.log("║                    ✨ WORKFLOW COMPLETE ✨                     ║");
    console.log("╚════════════════════════════════════════════════════════════════╝");
    
  } catch (error) {
    console.error(`\n❌ Workflow failed: ${error.message}`);
    
    // Cleanup on error only if deleteFile flag is set
    if (deleteFile && await fileExists(outputPath)) {
      console.log(`\n🗑️  Cleaning up failed run: deleting ${filename}...`);
      await fs.unlink(outputPath);
    } else if (await fileExists(outputPath)) {
      console.log(`\n📁 Keeping file for debugging: ${filename}`);
    }
    
    process.exit(1);
  }
}

main();

