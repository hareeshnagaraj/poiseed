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
  let radius = RADIUS; // Default radius

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lat' && i + 1 < args.length) {
      lat = parseFloat(args[i + 1]);
      i++; // Skip next argument since we used it
    } else if (args[i] === '--lon' && i + 1 < args.length) {
      lon = parseFloat(args[i + 1]);
      i++; // Skip next argument since we used it
    } else if (args[i] === '--radius' && i + 1 < args.length) {
      radius = parseInt(args[i + 1]);
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

  if (radius < 1 || radius > 50000) {
    console.error("❌ Error: Radius must be between 1 and 50000 meters");
    process.exit(1);
  }

  return { latitude: lat, longitude: lon, radius: radius };
}

/* ─────────────────────────────────────────────
   Get current location based on IP
───────────────────────────────────────────── */
async function getCurrentLocation() {
  try {
    console.log("🌍 Getting your current location...");
    const { data } = await axios.get("http://ipapi.co/json/");
    
    // Validate the response data
    if (!data) {
      throw new Error("No data received from location service");
    }
    
    if (!data.latitude || !data.longitude) {
      throw new Error(`Invalid coordinates received: lat=${data.latitude}, lon=${data.longitude}`);
    }

    // Validate coordinate ranges
    if (data.latitude < -90 || data.latitude > 90) {
      throw new Error(`Invalid latitude: ${data.latitude} (must be between -90 and 90)`);
    }
    
    if (data.longitude < -180 || data.longitude > 180) {
      throw new Error(`Invalid longitude: ${data.longitude} (must be between -180 and 180)`);
    }
    
    // Build address string with available details
    const addressParts = [];
    if (data.city) addressParts.push(data.city);
    if (data.region) addressParts.push(data.region);
    if (data.postal) addressParts.push(data.postal);
    if (data.country_name) addressParts.push(data.country_name);
    
    const fullAddress = addressParts.join(", ");
    
    console.log(`📍 Found location: ${fullAddress}`);
    console.log(`📐 Coordinates: ${data.latitude}, ${data.longitude}`);
    
    // Warning about IP geolocation accuracy
    console.log(`⚠️  IP-based location detection can be inaccurate (±1-2km)`);
    console.log(`💡 For precise results, use: node index.mjs --lat ${data.latitude} --lon ${data.longitude}`);
    
    // If we have more detailed address info, show it
    if (data.postal || data.region_code || data.timezone) {
      console.log(`📮 Additional details:`);
      if (data.postal) console.log(`   Postal Code: ${data.postal}`);
      if (data.region_code) console.log(`   Region Code: ${data.region_code}`);
      if (data.timezone) console.log(`   Timezone: ${data.timezone}`);
      if (data.org) console.log(`   ISP: ${data.org}`);
    }
    
    return {
      success: true,
      latitude: data.latitude,
      longitude: data.longitude,
      city: data.city,
      region: data.region,
      country: data.country_name,
      postal: data.postal,
      fullAddress: fullAddress
    };
  } catch (error) {
    console.error(`❌ Location detection failed: ${error.message}`);
    return {
      success: false,
      error: error.message,
      latitude: null,
      longitude: null,
      city: null,
      region: null,
      country: null,
      postal: null,
      fullAddress: null
    };
  }
}

/* ─────────────────────────────────────────────
   Fetch one page of results
───────────────────────────────────────────── */
async function fetchPage({latitude, longitude, radius, pageToken = ""} = {}) {
  const url = "https://maps.googleapis.com/maps/api/place/nearbysearch/json";
  const params = {
    location: `${latitude},${longitude}`,
    radius: radius,
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
async function fetchNearbyPOIs(latitude, longitude, radius) {
  let all = [];
  let nextPageToken = "";

  do {
    const page = await fetchPage({ latitude, longitude, radius, pageToken: nextPageToken });
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
        country: "",
        fullAddress: `${cmdArgs.latitude}, ${cmdArgs.longitude}`
      };
    } else {
      // Fall back to IP-based location detection
      const locationResult = await getCurrentLocation();
      
      if (!locationResult.success) {
        console.error("🚨 CRITICAL ERROR: Unable to determine your location!");
        console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.error("❌ Location detection failed and no coordinates were provided via command line.");
        console.error("❌ This could be due to:");
        console.error("   • VPN or proxy blocking location services");
        console.error("   • Network connectivity issues");
        console.error("   • Location service API being unavailable");
        console.error("");
        console.error("💡 SOLUTIONS:");
        console.error("   • Provide coordinates manually: node index.mjs --lat 40.7829 --lon -73.9654");
        console.error("   • Try disabling VPN/proxy if you're using one");
        console.error("   • Check your internet connection");
        console.error("");
        console.error("⚠️  PROCEEDING WITH FALLBACK: Using NYC coordinates (40.727233, -73.984592)");
        console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.error("");
        
        // Use fallback NYC coordinates
        location = {
          latitude: 40.727233,
          longitude: -73.984592,
          city: "New York",
          region: "NY",
          country: "United States",
          postal: "10003",
          fullAddress: "New York, NY, 10003, United States (FALLBACK)"
        };
      } else {
        location = locationResult;
      }
    }
    
    // Then fetch nearby POIs
    console.log(`🔍 Searching for POIs within ${cmdArgs.radius}m...`);
    const pois = await fetchNearbyPOIs(location.latitude, location.longitude, cmdArgs.radius);
    
    const locationString = location.fullAddress || 
      (location.city && location.region ? `${location.city}, ${location.region}` : 
      `${location.latitude}, ${location.longitude}`);
    
    console.log(`✅ Fetched ${pois.length} POIs near ${locationString}`);
    console.dir(pois, { depth: null });
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
}

// Run the script
main();
