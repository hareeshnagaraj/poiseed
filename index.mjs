import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

/* ─────────────────────────────────────────────
   Config – tweak these or pass via CLI/ENV
───────────────────────────────────────────── */
const RADIUS = 500;             // metres
const CATEGORIES = ["park", "museum", "cafe", "restaurant", "bar", "hotel", "gym", "library", "parking", "pharmacy", "school", "supermarket", "theatre", "zoo"]; // Google Place types
const API_KEY = process.env.GOOGLE_PLACES_KEY;

/* ─────────────────────────────────────────────
   Parse command line arguments
───────────────────────────────────────────── */
function parseCommandLineArgs() {
  const args = process.argv.slice(2);
  let lat = null;
  let lon = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lat' && i + 1 < args.length) {
      lat = parseFloat(args[i + 1]);
      i++; // Skip next argument since we used it
    } else if (args[i] === '--lon' && i + 1 < args.length) {
      lon = parseFloat(args[i + 1]);
      i++; // Skip next argument since we used it
    }
  }

  // Validate coordinates if provided
  if ((lat !== null && lon === null) || (lat === null && lon !== null)) {
    console.error("❌ Error: Both --lat and --lon must be provided together");
    process.exit(1);
  }

  if (lat !== null && (lat < -90 || lat > 90)) {
    console.error("❌ Error: Latitude must be between -90 and 90");
    process.exit(1);
  }

  if (lon !== null && (lon < -180 || lon > 180)) {
    console.error("❌ Error: Longitude must be between -180 and 180");
    process.exit(1);
  }

  return { latitude: lat, longitude: lon };
}

/* ─────────────────────────────────────────────
   Get current location based on IP
───────────────────────────────────────────── */
async function getCurrentLocation() {
  try {
    console.log("🌍 Getting your current location...");
    const { data } = await axios.get("http://ipapi.co/json/");
    console.log(data);
    
    if (!data.latitude || !data.longitude) {
      throw new Error("Could not determine location from IP");
    }
    
    console.log(`📍 Found location: ${data.city}, ${data.region}, ${data.country_name}`);
    console.log(`📐 Coordinates: ${data.latitude}, ${data.longitude}`);
    
    return {
      latitude: data.latitude,
      longitude: data.longitude,
      city: data.city,
      region: data.region,
      country: data.country_name
    };
  } catch (error) {
    console.error("❌ Failed to get current location:", error.message);
    console.log("🔄 Falling back to NYC coordinates...");
    return {
      latitude: 40.727233,
      longitude: -73.984592,
      city: "New York",
      region: "NY",
      country: "United States"
    };
  }
}

/* ─────────────────────────────────────────────
   Fetch one page of results
───────────────────────────────────────────── */
async function fetchPage({latitude, longitude, pageToken = ""} = {}) {
  const url = "https://maps.googleapis.com/maps/api/place/nearbysearch/json";
  const params = {
    location: `${latitude},${longitude}`,
    radius: RADIUS,
    type: CATEGORIES.join("|"),
    key: API_KEY,
    pagetoken: pageToken
  };

  const { data } = await axios.get(url, { params });
  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    throw new Error(
      `Places API error: ${data.status} - ${data.error_message ?? ""}`
    );
  }
  return data;
}

/* ─────────────────────────────────────────────
   Pull results (handles paginated tokens)
───────────────────────────────────────────── */
async function fetchNearbyPOIs(latitude, longitude) {
  let all = [];
  let nextPageToken = "";

  do {
    const page = await fetchPage({ latitude, longitude, pageToken: nextPageToken });
    const normalised = page.results.map((p) => ({
      name: p.name,
      description: p.vicinity ?? "",            // or p.types?.join(", ")
      latitude: p.geometry.location.lat,
      longitude: p.geometry.location.lng,
      category: p.types?.[0] ?? "other",
      // you can add is_active, created_by_user_id, etc. here
    }));
    all = all.concat(normalised);
    nextPageToken = page.next_page_token ?? "";
    if (nextPageToken) {
      // The token needs ~2 seconds before it becomes valid
      await new Promise((r) => setTimeout(r, 2100));
    }
  } while (nextPageToken);

  return all;
}

/* ─────────────────────────────────────────────
   Main execution
───────────────────────────────────────────── */
async function main() {
  try {
    // Check for command line coordinates first
    const cmdArgs = parseCommandLineArgs();
    let location;

    if (cmdArgs.latitude !== null && cmdArgs.longitude !== null) {
      console.log("📍 Using coordinates from command line:");
      console.log(`📐 Coordinates: ${cmdArgs.latitude}, ${cmdArgs.longitude}`);
      location = {
        latitude: cmdArgs.latitude,
        longitude: cmdArgs.longitude,
        city: "Custom Location",
        region: "",
        country: ""
      };
    } else {
      // Fall back to IP-based location detection
      location = await getCurrentLocation();
    }
    
    // Then fetch nearby POIs
    console.log(`🔍 Searching for POIs within ${RADIUS}m...`);
    const pois = await fetchNearbyPOIs(location.latitude, location.longitude);
    
    const locationString = location.city && location.region ? 
      `${location.city}, ${location.region}` : 
      `${location.latitude}, ${location.longitude}`;
    
    console.log(`✅ Fetched ${pois.length} POIs near ${locationString}`);
    console.dir(pois, { depth: null });
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
}

// Run the script
main();
