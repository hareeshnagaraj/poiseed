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

Run the script to find POIs near your current location:

```bash
node index.mjs
```

### Sample Output

```
🌍 Getting your current location...
📍 Found location: New York, New York, United States
📐 Coordinates: 40.7128, -74.0060
🔍 Searching for POIs within 500m...
✅ Fetched 45 POIs near New York, New York

[
  {
    name: 'Central Park',
    description: '5th Ave, New York',
    latitude: 40.7829,
    longitude: -73.9654,
    category: 'park'
  },
  {
    name: 'MoMA',
    description: '11 W 53rd St, New York',
    latitude: 40.7614,
    longitude: -73.9776,
    category: 'museum'
  },
  // ... more POIs
]
```

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