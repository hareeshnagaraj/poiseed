# POISeed 🌱

A Node.js tool that automatically discovers nearby Points of Interest (POIs) using your current location and the Google Places API.

## Features

- 🌍 **Auto-location detection** - Uses IP geolocation to find your current location
- 📍 **Nearby search** - Finds POIs within a configurable radius (default: 500m)
- 🏞️ **Multiple categories** - Searches for parks, museums, cafes, and restaurants
- 🔄 **Pagination handling** - Automatically fetches all available results
- 🛡️ **Fallback mechanism** - Falls back to NYC coordinates if location detection fails
- 📊 **Clean output** - Returns normalized POI data with consistent structure

## Prerequisites

- Node.js (v14+ recommended)
- Google Cloud Platform account with Places API enabled
- Google Places API key

## Setup

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd poiseed
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Get a Google Places API Key**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select existing one
   - Enable the "Places API"
   - Create an API key in "Credentials"
   - Enable billing on your project (required for Places API)

4. **Configure environment variables**
   ```bash
   # Create .env file
   touch .env
   
   # Add your API key
   echo "GOOGLE_PLACES_KEY=your_google_places_api_key_here" > .env
   ```

## Usage

### 🚀 Quick Start: Auto-Fetch & Ingest (Recommended)

The fastest way to fetch and automatically upload POIs to your server in one command:

```bash
# Fetch and ingest POIs at specific coordinates
node auto-ingest.mjs --lat 40.7829 --lon -73.9654

# With custom radius and categories
node auto-ingest.mjs --lat 40.7829 --lon -73.9654 --radius 1000 --categories restaurant,cafe

# Collect a specific number of POIs
node auto-ingest.mjs --lat 40.7829 --lon -73.9654 --target 500

# With AI-powered classification
node auto-ingest.mjs --lat 40.7829 --lon -73.9654 --ai --categories restaurant,bar

# Just fetch and save (skip ingestion)
node auto-ingest.mjs --lat 40.7829 --lon -73.9654 --no-ingest

# Delete the JSON file after ingestion (files are kept by default)
node auto-ingest.mjs --lat 40.7829 --lon -73.9654 --delete-file
```

**Environment Variables:**
- `ADMIN_TOKEN` - Required for ingestion (admin API token)
- `BASE_URL` - Optional API base URL (default: http://localhost:3000)
- `GOOGLE_PLACES_KEY` - Required for fetching POIs
- `OPENAI_API_KEY` - Optional, for AI classification (with `--ai` flag)

**What it does:**
1. Fetches POIs from Google Places API
2. Saves to a timestamped file (e.g., `auto-2025-10-15T14-30-00.json`)
3. Automatically uploads to your server
4. Keeps the file for your records (unless `--delete-file` is used)

**Available Flags:**
- `--lat <number>` - Latitude coordinate
- `--lon <number>` - Longitude coordinate
- `--radius <meters>` - Search radius (default: 500)
- `--target <number>` - Collect specific number of POIs using spiral search
- `--categories <list>` - Filter by categories (e.g., restaurant,cafe,bar)
- `--ai` - Use AI-powered classification (requires OPENAI_API_KEY)
- `--baseUrl <url>` - API server URL (default: http://localhost:3000)
- `--batch <number>` - Batch size for ingestion (default: 100)
- `--no-ingest` - Only fetch and save, skip server upload
- `--delete-file` - Delete JSON file after ingestion (default: keep)
- `--dry-run` - Fetch and validate but don't actually POST to server

---

### Manual Workflow

#### Option 1: Fetch POIs Only

Run the script to find POIs near your current location:

```bash
node index.mjs
```

#### Option 2: Specify custom coordinates

You can provide specific latitude and longitude coordinates:

```bash
# Search near specific coordinates
node index.mjs --lat 40.7829 --lon -73.9654

# Example: Central Park, NYC
node index.mjs --lat 40.7829 --lon -73.9654

# Example: London, UK  
node index.mjs --lat 51.5074 --lon -0.1278

# Custom search radius (default: 500m)
node index.mjs --lat 40.7829 --lon -73.9654 --radius 1000
```

#### Option 3: Adjust search radius

If IP-based location detection is inaccurate, you can increase the search radius:

```bash
# Increase radius to 1500m to compensate for location inaccuracy
node index.mjs --radius 1500

# Or use with specific coordinates
node index.mjs --lat 40.727291 --lon -73.986654 --radius 750
```

#### Option 4: Manual Ingestion

After fetching POIs to a JSON file, you can manually ingest them:

```bash
# Ingest POIs from a file
node ingest_pois.mjs --file tmp1.json --baseUrl http://localhost:3000 --batch 100
```

**Parameters:**
- `--lat` - Latitude (-90 to 90)
- `--lon` - Longitude (-180 to 180)  
- `--radius` - Search radius in meters (1 to 50000, default: 500)

**Note:** Both `--lat` and `--lon` must be provided together. The script will validate that:
- Latitude is between -90 and 90
- Longitude is between -180 and 180
- Radius is between 1 and 50000 meters

## IP Geolocation Accuracy

⚠️ **Important:** IP-based location detection can be inaccurate by 1-2 kilometers, especially if you're using a VPN or proxy. This can significantly affect results when searching within a 500m radius.

**If your location seems wrong:**
1. **Use exact coordinates** (recommended): `node index.mjs --lat YOUR_LAT --lon YOUR_LON`
2. **Increase search radius**: `node index.mjs --radius 1500`
3. **Check for VPN/proxy** that might be affecting your IP location

### Sample Output

```
📍 Using coordinates from command line:
📐 Coordinates: 40.7829, -73.9654
🔍 Searching for POIs within 500m...
✅ Fetched 23 POIs near 40.7829, -73.9654

[
  {
    name: 'Central Park',
    description: '5th Ave, New York',
    latitude: 40.7829,
    longitude: -73.9654,
    category: 'park'
  },
  // ... more POIs
]
```

**Auto-location fallback:** If no coordinates are provided via command line, the script automatically detects your location using IP geolocation.

## Configuration

You can modify these constants in `index.mjs`:

```javascript
const RADIUS = 500;             // Search radius in meters
const CATEGORIES = ["park", "museum", "cafe", "restaurant"]; // POI types to search for
```

Available Google Places categories include:
- `park`, `museum`, `cafe`, `restaurant`
- `tourist_attraction`, `shopping_mall`, `gym`
- `hospital`, `school`, `bank`
- And many more...

## How It Works

1. **Location Detection**: Uses [ipapi.co](http://ipapi.co) to determine your approximate location based on IP address
2. **Places Search**: Queries Google Places API with your coordinates and specified categories
3. **Result Processing**: Normalizes the API response into a consistent format
4. **Pagination**: Automatically handles multiple pages of results (Google returns max 20 per page)

## API Costs

- Google Places API provides $200 free credit monthly for new accounts
- After free tier: ~$32 per 1,000 requests for Nearby Search
- IP geolocation via ipapi.co is free (1,000 requests/month)

## Error Handling

- If location detection fails → Falls back to NYC coordinates
- If Places API fails → Shows detailed error message
- If API key is missing → Clear instructions provided

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the ISC License.

## Troubleshooting

**"REQUEST_DENIED" error**: Make sure billing is enabled on your Google Cloud project

**"API key not valid"**: Verify your API key is correct and Places API is enabled

**No results found**: Try increasing the `RADIUS` or checking different `CATEGORIES`

**Location detection fails**: The script will fall back to NYC coordinates and still work 