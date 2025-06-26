import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

/* ─────────────────────────────────────────────
   Config – tweak these or pass via CLI/ENV
───────────────────────────────────────────── */
const RADIUS = 500;             // metres
const CATEGORIES = ["park", "museum", "cafe", "restaurant"]; // Google Place types
const API_KEY = process.env.GOOGLE_PLACES_KEY;

/* ─────────────────────────────────────────────
   Get current location based on IP
───────────────────────────────────────────── */
async function getCurrentLocation() {
  try {
    console.log("🌍 Getting your current location...");
    const { data } = await axios.get("http://ipapi.co/json/");
    
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
    // Get current location first
    const location = await getCurrentLocation();
    
    // Then fetch nearby POIs
    console.log(`🔍 Searching for POIs within ${RADIUS}m...`);
    const pois = await fetchNearbyPOIs(location.latitude, location.longitude);
    
    console.log(`✅ Fetched ${pois.length} POIs near ${location.city}, ${location.region}`);
    console.dir(pois, { depth: null });
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
}

// Run the script
main();
