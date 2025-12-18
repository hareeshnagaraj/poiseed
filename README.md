# POI Seed - Location-Based POI Collection & Ingestion

Intelligent POI (Point of Interest) collector that fetches, classifies, and ingests places from Google Places API with AI-powered categorization.

## ✨ Two Approaches

1. **Coordinate-Based** (`index.mjs`) - Spiral search from a point
2. **Locale-Based** (`poiseed.mjs`) - Smart grid coverage of an entire city/area ⭐ **Recommended**

## ⚡ Quick Command Reference

```bash
# Seed entire city → streams directly to database! ⭐
npm run seed -- --locale "Austin, TX" --target 200 --categories restaurant,cafe,bar

# Collect from coordinates → writes to file (then manually ingest)
npm run collect -- --lat 37.7749 --lon -122.4194 --target 100 --out sf.json
npm run ingest -- --file sf.json --baseUrl https://geocast-gamma.vercel.app
```

**💡 Note:** `npm run seed` automatically ingests to database as it collects (no second step needed!)

## 🚀 Quick Start

### Prerequisites

```bash
# Required environment variables
export GOOGLE_PLACES_KEY=your_google_api_key
export OPENAI_API_KEY=your_openai_key  # Optional, for AI classification
export ADMIN_TOKEN=your_admin_token    # For database ingestion
```

### Installation

```bash
npm install
```

## 📝 Usage

### Using npm scripts (Recommended)

#### 🌆 Seed entire city by name (Smart Grid - Auto-ingests to DB!)
```bash
# This automatically streams to database as it collects!
npm run seed -- --locale "San Francisco, CA" --max-points 50 --categories restaurant,cafe,bar,shopping
```

#### 📍 Collect POIs by coordinates (Spiral Search)
```bash
npm run collect -- --lat 37.7749 --lon -122.4194 --target 100 --out sf.json
```

#### Collect POIs with AI classification
```bash
npm run collect:ai -- --lat 37.7749 --lon -122.4194 --target 100 --out sf.json
```

#### Collect specific categories only
```bash
npm run collect:categories -- --lat 37.7749 --lon -122.4194 --target 100 --categories restaurant,cafe,bar,shopping --out output.json
```

#### Ingest collected POIs to database
```bash
npm run ingest -- --file sf.json --baseUrl https://geocast-gamma.vercel.app
```

#### Full workflow (collect + ingest)
```bash
npm run seed -- --lat 37.7749 --lon -122.4194 --target 100 --categories restaurant,cafe,bar
```

### Common Workflows

**🌆 Seed entire city (automatically ingests to database!)**
```bash
# Austin, TX - collect exactly 200 POIs → goes straight to DB
npm run seed -- --locale "Austin, TX" --target 200 --categories restaurant,cafe,bar --ai

# San Francisco - restaurants & cafes, stop at 100 POIs
npm run seed -- --locale "San Francisco, CA" --target 100 --categories restaurant,cafe --ai

# NYC downtown - unlimited POIs from up to 30 grid points
npm run seed -- --locale "SoHo, New York" --max-points 30 --categories shopping,entertainment --out soho.json
```

**📍 Seed from coordinates with spiral search**
```bash
npm run seed:restaurants -- --lat 40.7128 --lon -73.9654 --target 200
```

**🛍️ Collect shopping & entertainment**
```bash
npm run seed:shopping -- --lat 34.0522 --lon -118.2437 --target 150
```

**🌃 Night life (bars & venues)**
```bash
npm run seed:nightlife -- --lat 30.2672 --lon -97.7431 --target 100
```

**🏥 Healthcare facilities**
```bash
npm run collect:categories -- --lat 37.7749 --lon -122.4194 --target 50 --categories health --out health.json
```

## 🎯 Available Categories

- `park` - Outdoor recreational spaces
- `restaurant` - Food, drinks, dining
- `attraction` - Tourist sites, museums, landmarks
- `cafe` - Coffee shops, casual dining
- `bar` - Bars, pubs, nightlife
- `shopping` - Retail stores
- `library` - Educational/community spaces
- `beach` - Waterfront recreation
- `gym` - Fitness centers, sports facilities
- `venue` - Event venues, concerts, stadiums
- `entertainment` - Movies, theaters, amusement
- `health` - Medical facilities, doctors, hospitals
- `misc` - Everything else

## 🔧 CLI Options

### Locale-Based Seeding (poiseed.mjs - Recommended!)

**Command:** `npm run seed -- [options]` or `node poiseed.mjs seed [options]`

| Option | Description | Default | Example |
|--------|-------------|---------|---------|
| `--locale` | City/location name (required) | None | `--locale "Austin, TX"` |
| `--target` | Total unique POIs to collect | Unlimited | `--target 100` |
| `--radius` | Search radius per grid point | 400m | `--radius 500` |
| `--max-points` | Max grid points to query | 200 | `--max-points 100` |
| `--categories` | Comma-separated category list | All | `--categories restaurant,cafe` |
| `--ai` | Enable AI classification | false | `--ai` |
| `--batch` | Batch size for DB ingestion | 100 | `--batch 50` |
| `--baseUrl` | API base URL | localhost:3000 | `--baseUrl https://api.example.com` |
| `--dry-run` | Test without uploading | false | `--dry-run` |
| `--out` | Save to JSON file | None | `--out austin.json` |

**Features:**
- ✅ Geocodes city/locale names automatically
- ✅ Smart grid generation (higher density in center)
- ✅ Streams ingestion as it fetches (real-time progress)
- ✅ Deduplicates across all grid points
- ✅ Shows detailed breakdown by category
- ✅ Stops at target POI count (skips remaining grid points)

**💡 Target vs Max-Points:**
- `--target 100` = Stop after collecting 100 unique POIs (efficient!)
- `--max-points 50` = Query up to 50 grid points (area coverage limit)
- Use both: `--target 200 --max-points 100` = Stop at 200 POIs OR 100 points, whichever comes first

### Coordinate-Based Collection (index.mjs)

| Option | Description | Default | Example |
|--------|-------------|---------|---------|
| `--lat` | Latitude | Required | `--lat 37.7749` |
| `--lon` | Longitude | Required | `--lon -122.4194` |
| `--target` | Number of unique POIs to collect | None | `--target 100` |
| `--radius` | Search radius in meters | 500 | `--radius 1000` |
| `--step` | Step size for spiral search | 80% of radius | `--step 400` |
| `--maxSteps` | Maximum spiral steps | 200 | `--maxSteps 500` |
| `--categories` | Comma-separated category list | All | `--categories restaurant,cafe` |
| `--ai` | Enable AI classification | false | `--ai` |
| `--json` | Output as JSON | false | `--json` |
| `--out` | Output file path | stdout | `--out pois.json` |
| `--details` | Show detailed output | false | `--details` |

### Ingestion Options

| Option | Description | Default | Example |
|--------|-------------|---------|---------|
| `--file` | Input JSON file | Required | `--file pois.json` |
| `--baseUrl` | API base URL | localhost:3000 | `--baseUrl https://api.example.com` |
| `--batch` | Batch size for uploads | 100 | `--batch 50` |
| `--dry-run` | Test without uploading | false | `--dry-run` |

## 📦 Package.json Scripts

### Core Scripts

```bash
# Collect POIs (basic)
npm run collect -- [options]

# Collect with AI classification
npm run collect:ai -- [options]

# Collect specific categories
npm run collect:categories -- [options]

# Ingest to database
npm run ingest -- [options]

# Full workflow (collect + ingest)
npm run seed -- [options]
```

### Preset Workflows

```bash
# Restaurants & cafes
npm run seed:restaurants -- --lat LAT --lon LON --target N

# Shopping & entertainment  
npm run seed:shopping -- --lat LAT --lon LON --target N

# Nightlife (bars & venues)
npm run seed:nightlife -- --lat LAT --lon LON --target N

# All food & drink
npm run seed:food -- --lat LAT --lon LON --target N
```

## 💡 Examples

### Example 1: Seed entire city (locale-based - recommended!)
```bash
# Seed Austin with all categories → automatically ingests to database!
npm run seed -- \
  --locale "Austin, TX" \
  --max-points 100 \
  --ai \
  --baseUrl https://geocast-gamma.vercel.app

# Dry run without actually ingesting (test first)
npm run seed -- \
  --locale "Downtown San Francisco, CA" \
  --max-points 30 \
  --categories restaurant,cafe \
  --ai \
  --dry-run

# Save backup JSON file (still ingests to DB)
npm run seed -- \
  --locale "Austin, TX" \
  --max-points 50 \
  --categories restaurant,cafe \
  --out austin_food.json
```

### Example 2: Seed San Francisco from coordinates (spiral search)
```bash
# Collect 200 restaurants, cafes, and bars
npm run collect:ai -- \
  --lat 37.7749 \
  --lon -122.4194 \
  --target 200 \
  --categories restaurant,cafe,bar \
  --out sf_food.json

# Ingest to production
npm run ingest -- \
  --file sf_food.json \
  --baseUrl https://geocast-gamma.vercel.app
```

### Example 3: Quick seed nightlife
```bash
# Locale-based
npm run seed -- --locale "6th Street, Austin" --categories bar,venue

# Coordinate-based
npm run seed:nightlife -- --lat 30.2672 --lon -97.7431 --target 100
```

### Example 4: Single query (no spiral)
```bash
npm run collect -- \
  --lat 40.7589 \
  --lon -73.9851 \
  --radius 1000 \
  --categories attraction,entertainment \
  --out times_square.json
```

### Example 5: Detailed output for review
```bash
npm run collect -- \
  --lat 34.0522 \
  --lon -118.2437 \
  --target 50 \
  --categories restaurant \
  --details
```

## 🔄 How It Works

### Locale-Based Seeding (poiseed.mjs)

1. **Geocode** - Converts city name to coordinates and bounds
2. **Smart Grid** - Generates query points with higher density in center
3. **Fetch & Process** - Queries each grid point (with filtering pipeline below)
4. **Stream Ingest** - Uploads batches to database as it collects (no waiting!)
5. **Deduplicate** - Prevents duplicate POIs across grid points
6. **Summary** - Shows breakdown by category

### Coordinate-Based Collection (index.mjs)

1. **Spiral Search** - Expands outward from starting point
2. **Deduplicate** - Tracks unique POIs until target reached
3. **Output** - Writes to file when complete

### Common Processing Pipeline (both scripts)

### 1. **Pre-filter** (Global ineligibility)
Removes administrative areas, generic entries, address-like names

### 2. **Rule-based classification**
Categorizes places using Google types and keywords

### 3. **Validation**
Ensures categories match place characteristics

### 4. **Category filter** (if specified)
Filters to only requested categories

### 5. **AI classification** (optional)
Refines categorization using GPT-4 for validated entries only

### 6. **Deduplication**
Uses `place_id` or name+coordinates to prevent duplicates

### 7. **Spiral search** (with `--target`)
Expands outward from starting point until target is reached

## 🆚 Which Script Should I Use?

| Feature | `poiseed.mjs` (Locale) | `index.mjs` (Coordinate) |
|---------|------------------------|--------------------------|
| **Input** | City/location name | Lat/lon coordinates |
| **Coverage** | Smart grid across area | Spiral from point |
| **Best For** | Seeding entire cities | Targeted dense collection |
| **Ingestion** | ✅ Auto-ingests to DB | ❌ Manual (write file → ingest) |
| **Progress** | Real-time batch updates | Step-by-step spiral |
| **Use When** | "Seed downtown Austin" | "Get 200 POIs near X,Y" |

**💡 Recommendation:** Use `poiseed.mjs seed` for most city seeding. It's faster, provides better coverage, and shows real-time progress!

## 📊 Output Format

```json
[
  {
    "name": "Joe's Pizza",
    "description": "123 Main St, New York",
    "latitude": 40.7589,
    "longitude": -73.9851,
    "category": "restaurant",
    "types": ["restaurant", "food", "point_of_interest"],
    "isValidated": true,
    "confidence": 0.95,
    "reasoning": "AI classified as restaurant based on...",
    "classificationMethod": "AI",
    "rating": 4.5,
    "priceLevel": 2
  }
]
```

## 📊 Example Output (poiseed.mjs)

```
╔════════════════════════════════════════════════════════════════╗
║              LOCALE-BASED POI SEEDING                          ║
╚════════════════════════════════════════════════════════════════╝

📋 CONFIGURATION
  --locale       Austin, TX
  --radius       500m
  --max-points   50
  --categories   restaurant, cafe, bar, shopping

📍 STEP 1: Geocoding locale
✅ Found: Austin, TX, USA
📐 Center: 30.267153, -97.743061

📍 STEP 2: Generating smart grid
✅ Generated 50 query points (higher density in center)

📍 STEP 3: Fetching POIs from grid (streaming)

[100%] Point  50/50 @ (30.2961, -97.7330) → 60 raw, 25 valid, +12 new (total: 487)
     📤 Batch 5: ingested 100 POIs

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ VALIDATED POIs BY CATEGORY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🍽️ RESTAURANT (156)
   • Franklin Barbecue
   • Uchi
   • Matt's El Rancho
   ... and 153 more

🛒 SHOPPING (142)
   • Whole Foods Market
   • BookPeople
   • South Congress Books
   ... and 139 more

☕ CAFE (98)
   • Jo's Coffee
   • Café Medici
   ... and 96 more

🍺 BAR (91)
   • Rainey Street Historic District
   • The White Horse
   ... and 89 more

📊 SEEDING SUMMARY
🌍 Location: Austin, TX, USA
📍 Grid points queried: 50
🔍 Unique POIs found: 487
✅ POIs ingested: 487
```

## 🐛 Troubleshooting

### 401 Unauthorized during ingestion
```bash
# Check your admin token
echo $ADMIN_TOKEN

# Verify it matches Vercel env var
# Go to: Vercel → Project Settings → Environment Variables
```

### Too many medical facilities
```bash
# Exclude health category
npm run collect:categories -- \
  --categories restaurant,cafe,bar,shopping \
  --lat LAT --lon LON --target 100
```

### API rate limits
```bash
# Reduce batch size or add delays
# The tool automatically staggers requests (50-150ms random delay)
# AI batch size: 10 concurrent with 500ms between batches
```

### Not enough POIs found
```bash
# Increase radius or max steps
npm run collect -- \
  --lat LAT --lon LON \
  --target 200 \
  --radius 800 \
  --step 600 \
  --maxSteps 500
```

## 📝 Environment Variables

Create a `.env` file:

```bash
# Required for collection
GOOGLE_PLACES_KEY=your_google_api_key_here

# Optional for AI classification
OPENAI_API_KEY=your_openai_key_here

# Required for ingestion
ADMIN_TOKEN=your_admin_token_here

# Optional: default base URL
BASE_URL=https://geocast-gamma.vercel.app
```

## 🔐 Security Notes

- Never commit `.env` file
- Use environment-specific tokens
- Admin token should be 128+ character hex string
- Rotate tokens regularly

## 📈 Performance Tips

1. **Use category filters** to reduce AI costs
2. **Start with smaller targets** (50-100) then scale
3. **Use `--details`** first to review before ingesting
4. **Enable AI only when needed** for better categorization
5. **Adjust `--step`** based on area density (urban vs suburban)

## 🤝 Contributing

1. Add new categories in `POI_CATEGORIES`
2. Define rules in `CLASSIFICATION_RULES`
3. Add emoji in `getCategoryEmoji()`
4. Update this README

## 📄 License

MIT
