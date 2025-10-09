import axios from "axios";
import dotenv from "dotenv";
import OpenAI from "openai";
dotenv.config();

/* ─────────────────────────────────────────────
   Config – tweak these or pass via CLI/ENV
───────────────────────────────────────────── */
const RADIUS = 500;             // metres
// Approved POI categories - enforce consistency across the app
const POI_CATEGORIES = [
  'park',        // Outdoor recreational spaces
  'restaurant',  // Food, drinks, dining
  'attraction',  // Tourist sites, museums, landmarks, public squares
  'cafe',        // Coffee shops, casual dining
  'bar',         // Bars, pubs, nightlife
  'shopping',    // Retail stores
  'library',     // Educational/community spaces
  'beach',       // Waterfront recreation
  'gym',         // Fitness centers, sports facilities
  'venue',       // Venues, events, concerts, etc.
  'entertainment', // Entertainment, shows, movies, etc.
  'misc'         // Everything that doesn't fit elsewhere
];
// Types that are too generic to be useful for POI validation
const GENERIC_PLACE_TYPES = [
  'establishment',
  'point_of_interest',
  'locality',
  'political',
  'sublocality',
  'neighborhood',
  'administrative_area_level_1',
  'administrative_area_level_2',
  'country',
  'route',
  'street_address',
  'premise',
  'colloquial_area'
];
// Administrative/area-like types that we always exclude from POIs
const EXCLUDED_GLOBAL_TYPES = [
  'locality',
  'political',
  'country',
  'administrative_area_level_1',
  'administrative_area_level_2',
  'administrative_area_level_3',
  'sublocality',
  'neighborhood',
  'colloquial_area'
];
// Extremely generic or meaningless names to exclude when unsupported by specific types
const GENERIC_BAD_NAMES = ['website', 'home', 'my location', 'new york'];
const API_KEY = process.env.GOOGLE_PLACES_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Initialize OpenAI client (if API key is available)
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
// Global JSON output mode (suppress normal logs when true)
let JSON_MODE = false;

/* ─────────────────────────────────────────────
   AI-powered place classification
───────────────────────────────────────────── */
async function classifyPlaceWithAI(place) {
  if (!openai) {
    return null; // Fallback to rule-based if no OpenAI key
  }

  try {
    const prompt = `
Analyze this place and classify it into the most appropriate category.

Place Details:
- Name: "${place.name}"
- Description/Address: "${place.vicinity || 'N/A'}"
- Google Types: ${(place.types || []).join(', ')}
- Rating: ${place.rating || 'N/A'}

Available Categories: ${POI_CATEGORIES.join(', ')}

Category Definitions:
- park: Outdoor recreational spaces (parks, gardens, playgrounds)
- restaurant: Food, drinks, dining (restaurants, diners, food trucks)
- attraction: Tourist sites, museums, landmarks, public squares, religious sites
- cafe: Coffee shops, casual dining, bakeries
- bar: Bars, pubs, nightlife, breweries
- shopping: Retail stores, malls, supermarkets, pharmacies
- library: Educational/community spaces (libraries, schools, universities)
- beach: Waterfront recreation (beaches, piers, marinas)
- gym: Fitness centers, sports facilities, spas
- venue: Venues, events, concerts, stadiums, halls, convention centers
- entertainment: Entertainment, shows, movies, theaters, amusement parks
- misc: Everything that doesn't fit elsewhere

Consider:
1. What is the PRIMARY purpose/function of this place?
2. What would a person most likely visit this place for?
3. If a place has multiple functions, choose based on its MAIN purpose:
   - Movie theaters that serve food → entertainment (not restaurant)
   - Museums with cafes → attraction (not cafe)  
   - Hotels with restaurants → misc (not restaurant)
   - Gyms with juice bars → gym (not cafe)
   - Music venues that serve drinks → venue (not bar)
   - Stadiums with concessions → venue (not restaurant)
   - Music stores that sell instruments → shopping (not venue)
   - Bookstores with events → shopping (not venue)
4. The business name often indicates the primary function.

CRITICAL: Respond with ONLY a valid JSON object. Do NOT use markdown, code blocks, or any other formatting.

Required JSON format:
{
  "category": "most_appropriate_category",
  "confidence": 0.95,
  "reasoning": "Brief explanation of why this category was chosen",
  "isValid": true,
  "alternativeCategory": "second_best_option_or_null"
}

Rules:
- The category MUST be one from the available categories list
- Set isValid to false if this doesn't seem like a legitimate business/place
- Do NOT wrap the JSON in markdown code blocks
- Return ONLY the JSON object, nothing else
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Faster and cheaper than GPT-4
      messages: [
        {
          role: "system", 
          content: "You are a place classification assistant. Always respond with valid JSON only, never use markdown formatting or code blocks."
        },
        { 
          role: "user", 
          content: prompt 
        }
      ],
      temperature: 0.1, // Low temperature for consistent classification
      max_tokens: 200
    });

    let responseContent = response.choices[0].message.content.trim();
    
    // Clean up potential markdown formatting
    if (responseContent.startsWith('```json')) {
      responseContent = responseContent.replace(/```json\s*/, '').replace(/```\s*$/, '');
    } else if (responseContent.startsWith('```')) {
      responseContent = responseContent.replace(/```\s*/, '').replace(/```\s*$/, '');
    }
    
    // Remove any leading/trailing whitespace
    responseContent = responseContent.trim();

    let result;
    try {
      result = JSON.parse(responseContent);
    } catch (parseError) {
      console.warn(`⚠️ AI returned invalid JSON for ${place.name}. Response: ${responseContent.substring(0, 100)}...`);
      return null;
    }
    
    // Validate the response structure
    if (!result || typeof result !== 'object') {
      console.warn(`⚠️ AI returned invalid response structure for ${place.name}`);
      return null;
    }
    
    if (!POI_CATEGORIES.includes(result.category)) {
      console.warn(`⚠️ AI returned invalid category: ${result.category} for ${place.name}`);
      return null;
    }

    return result;
  } catch (error) {
    console.warn(`⚠️ AI classification failed for ${place.name}: ${error.message}`);
    return null;
  }
}

/* ─────────────────────────────────────────────
   Batch AI classification with rate limiting
───────────────────────────────────────────── */
async function batchClassifyWithAI(places) {
  if (!openai || places.length === 0) {
    return {};
  }

  console.log(`🤖 Using AI to classify ${places.length} places...`);
  const results = {};
  const batchSize = 5; // Process 5 at a time to avoid rate limits
  
  for (let i = 0; i < places.length; i += batchSize) {
    const batch = places.slice(i, i + batchSize);
    const batchPromises = batch.map(place => 
      classifyPlaceWithAI(place).then(result => ({ place, result }))
    );
    
    const batchResults = await Promise.all(batchPromises);
    
    for (const { place, result } of batchResults) {
      if (result) {
        results[place.place_id || place.name] = result;
      }
    }
    
    // Rate limiting: wait between batches
    if (i + batchSize < places.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  console.log(`🤖 AI classified ${Object.keys(results).length} places`);
  return results;
}

/* ─────────────────────────────────────────────
   Clean POI Category Classification Rules
───────────────────────────────────────────── */
const CLASSIFICATION_RULES = {
  park: {
    priority: 10,
    types: ['park', 'campground', 'rv_park'],
    keywords: ['park', 'garden', 'green', 'playground', 'recreation', 'square', 'plaza', 'promenade', 'waterfront', 'pier', 'trail', 'commons', 'field'],
    excludeKeywords: ['restaurant', 'bar', 'cafe', 'hotel', 'store', 'shop', 'market', 'pharmacy', 'bank']
  },
  shopping: {
    priority: 9,
    types: ['shopping_mall', 'department_store', 'clothing_store', 'shoe_store', 'jewelry_store', 'electronics_store', 'furniture_store', 'home_goods_store', 'book_store', 'bicycle_store', 'store', 'supermarket', 'grocery_or_supermarket', 'convenience_store', 'drugstore', 'pharmacy', 'florist', 'hardware_store', 'laundry', 'pet_store'],
    keywords: ['store', 'shop', 'market', 'boutique', 'outlet', 'retail'],
    excludeKeywords: []
  },
  entertainment: {
    priority: 8,
    types: ['movie_theater', 'amusement_park'],
    keywords: ['cinema', 'theater', 'theatre', 'movie', 'amusement', 'arcade', 'entertainment'],
    excludeTypes: ['store'],
    excludeKeywords: ['store', 'shop']
  },
  venue: {
    priority: 7,
    types: ['stadium', 'bowling_alley', 'casino'],
    keywords: ['stadium', 'arena', 'venue', 'hall', 'center', 'auditorium', 'amphitheater', 'bowling', 'casino', 'convention'],
    excludeTypes: ['store', 'clothing_store', 'electronics_store', 'book_store', 'shoe_store'],
    excludeKeywords: ['store', 'shop', 'market', 'boutique', 'retail']
  },
  attraction: {
    priority: 6,
    types: ['tourist_attraction', 'museum', 'zoo', 'aquarium', 'art_gallery', 'church', 'hindu_temple', 'mosque', 'synagogue', 'city_hall', 'courthouse', 'embassy'],
    keywords: ['museum', 'gallery', 'monument', 'memorial', 'historic', 'cathedral', 'church', 'temple', 'bridge', 'tower', 'statue'],
    excludeKeywords: []
  },
  cafe: {
    priority: 5,
    types: ['cafe', 'bakery'],
    keywords: ['cafe', 'coffee', 'bakery', 'patisserie', 'espresso'],
    excludeKeywords: []
  },
  bar: {
    priority: 4,
    types: ['bar', 'night_club'],
    keywords: ['bar', 'pub', 'tavern', 'lounge', 'brewery', 'taproom', 'cocktail', 'nightclub'],
    excludeTypes: ['drugstore', 'convenience_store', 'pharmacy', 'health'],
    excludeKeywords: ['cvs', 'duane reade', 'walgreens', 'rite aid']
  },
  restaurant: {
    priority: 3,
    types: ['restaurant', 'meal_takeaway', 'meal_delivery', 'food'],
    keywords: ['restaurant', 'bistro', 'eatery', 'kitchen', 'grill', 'diner', 'pizzeria', 'steakhouse'],
    excludeTypes: ['drugstore', 'convenience_store', 'pharmacy', 'health'],
    excludeKeywords: ['cvs', 'duane reade', 'walgreens', 'rite aid']
  },
  beach: { priority: 2, types: ['natural_feature'], keywords: ['beach', 'shore', 'waterfront', 'marina', 'harbor', 'pier', 'wharf', 'dock'], excludeKeywords: [] },
  library: { priority: 2, types: ['library', 'school', 'university'], keywords: ['library', 'school', 'university', 'college', 'academy', 'institute'], excludeKeywords: [] },
  gym: { priority: 2, types: ['gym', 'spa'], keywords: ['gym', 'fitness', 'yoga', 'pilates', 'crossfit', 'spa', 'wellness'], excludeKeywords: [] },
  misc: { priority: 1, types: [], keywords: [], excludeKeywords: [] }
};

/* ─────────────────────────────────────────────
   Clean category classification function
───────────────────────────────────────────── */
function getBestCategory(place) {
  const placeName = place.name.toLowerCase();
  const placeTypes = place.types || [];
  
  let bestMatch = { category: 'misc', priority: 0, confidence: 0 };
  
  for (const [category, rules] of Object.entries(CLASSIFICATION_RULES)) {
    // Skip if excluded by type or keyword
    if (rules.excludeTypes?.some(type => placeTypes.includes(type))) continue;
    if (rules.excludeKeywords?.some(keyword => placeName.includes(keyword))) continue;
    
    let confidence = 0;
    
    // Check Google types match
    const typeMatches = rules.types?.filter(type => placeTypes.includes(type)).length || 0;
    confidence += typeMatches * 2; // Types are more reliable
    
    // Check keyword matches  
    const keywordMatches = rules.keywords?.filter(keyword => placeName.includes(keyword)).length || 0;
    confidence += keywordMatches;
    
    // Special handling for bars with liquor stores
    if (category === 'bar' && placeTypes.includes('liquor_store') && 
        !placeTypes.some(type => ['drugstore', 'convenience_store', 'store'].includes(type))) {
      confidence += 1;
    }
    
    // Update best match if this is better
    if (confidence > 0 && (rules.priority > bestMatch.priority || 
        (rules.priority === bestMatch.priority && confidence > bestMatch.confidence))) {
      bestMatch = { category, priority: rules.priority, confidence };
    }
  }
  
  return bestMatch.category;
}

/* ─────────────────────────────────────────────
   Simplified validation using the same rules
───────────────────────────────────────────── */
// Helper guards to exclude administrative/over-generic entries
function hasOnlyGenericTypes(types) {
  const placeTypes = types || [];
  if (placeTypes.length === 0) return true;
  const nonGenericTypes = placeTypes.filter(t => !GENERIC_PLACE_TYPES.includes(t));
  return nonGenericTypes.length === 0;
}

function containsExcludedGlobalType(types) {
  const placeTypes = types || [];
  return placeTypes.some(t => EXCLUDED_GLOBAL_TYPES.includes(t));
}

function isGenericName(name) {
  const n = (name || '').trim().toLowerCase();
  return n.length > 0 && GENERIC_BAD_NAMES.includes(n);
}

function isAddressLike(name) {
  const n = (name || '').toLowerCase();
  // Looks like an address if it has a street number and a street designator
  const hasNumber = /\b\d{1,6}\b/.test(n);
  const hasStreetWord = /(street|st\.?|ave\.?|avenue|blvd\.?|boulevard|rd\.?|road|dr\.?|drive|ln\.?|lane|ct\.?|court|pl\.?|place|pkwy\.?|parkway|suite|ste\.?|apt\.?)/.test(n);
  return hasNumber && hasStreetWord;
}

function isGloballyIneligible(place) {
  const placeTypes = place.types || [];
  const placeName = place.name || '';
  if (containsExcludedGlobalType(placeTypes)) return true;
  if (hasOnlyGenericTypes(placeTypes) && (isGenericName(placeName) || isAddressLike(placeName))) return true;
  return false;
}

function validatePlace(place, category) {
  const rules = CLASSIFICATION_RULES[category];
  if (!rules) return false;
  
  const placeName = place.name.toLowerCase();
  const placeTypes = place.types || [];
  
  // Global exclusions: administrative areas, over-generic entries
  if (isGloballyIneligible(place)) return false;

  // Check exclusions first
  if (rules.excludeTypes?.some(type => placeTypes.includes(type))) return false;
  if (rules.excludeKeywords?.some(keyword => placeName.includes(keyword))) return false;
  
  // Must have either matching type or keyword
  const hasMatchingType = rules.types?.some(type => placeTypes.includes(type)) || false;
  const hasMatchingKeyword = rules.keywords?.some(keyword => placeName.includes(keyword)) || false;
  
  // Special case for bars with liquor stores
  if (category === 'bar' && placeTypes.includes('liquor_store') && 
      !placeTypes.some(type => ['drugstore', 'convenience_store', 'store'].includes(type))) {
    return true;
  }
  
  // Disallow misc if the entry is too generic or address-like with no specific signals
  if (category === 'misc') {
    if (hasOnlyGenericTypes(placeTypes) || isGenericName(place.name) || isAddressLike(place.name)) {
      return false;
    }
  }

  return hasMatchingType || hasMatchingKeyword || category === 'misc';
}

/* ─────────────────────────────────────────────
   Filter and enhance places with intelligent categorization (AI-powered)
───────────────────────────────────────────── */
async function processPlaces(rawPlaces, filterCategories = [], useAI = false) {
  let aiClassifications = {};
  
  // Get AI classifications if enabled
  if (useAI && openai) {
    aiClassifications = await batchClassifyWithAI(rawPlaces);
  }

  const processed = rawPlaces.map(place => {
    const placeId = place.place_id || place.name;
    const aiResult = aiClassifications[placeId];
    
    let bestCategory, isValidated, confidence, reasoning;
    
    if (aiResult && aiResult.isValid) {
      // Use AI classification but still validate against our rules
      bestCategory = aiResult.category;
      isValidated = validatePlace(place, bestCategory);
      confidence = aiResult.confidence;
      reasoning = aiResult.reasoning;
    } else {
      // Fallback to rule-based classification
      bestCategory = getBestCategory(place);
      isValidated = validatePlace(place, bestCategory);
      confidence = isValidated ? 0.8 : 0.3; // Rule-based confidence
      reasoning = "Rule-based classification";
    }
    
    return {
      name: place.name,
      description: place.vicinity ?? "",
      latitude: place.geometry.location.lat,
      longitude: place.geometry.location.lng,
      category: bestCategory,
      types: place.types || [],
      isValidated: isValidated,
      confidence: confidence,
      reasoning: reasoning,
      classificationMethod: aiResult ? 'AI' : 'Rules',
      // Add rating if available
      rating: place.rating || null,
      // Add price level if available
      priceLevel: place.price_level || null,
      // Keep original for debugging
      _original: place
    };
  });

  // Apply validation filter
  const validated = processed.filter(place => {
    const isTargetCategory = POI_CATEGORIES.includes(place.category);
    // Global eligibility guard (safety net)
    const eligible = !isGloballyIneligible(place._original || { name: place.name, types: place.types });
    return place.isValidated && isTargetCategory && eligible;
  });

  // Apply category filter if specified
  const filtered = filterCategories.length > 0 
    ? validated.filter(place => filterCategories.includes(place.category))
    : validated;

  // Add stats for debugging
  filtered._stats = {
    totalRaw: rawPlaces.length,
    afterValidation: validated.length,
    afterCategoryFilter: filtered.length,
    excluded: rawPlaces.length - validated.length,
    filteredOut: validated.length - filtered.length,
    aiClassified: Object.keys(aiClassifications).length,
    ruleClassified: rawPlaces.length - Object.keys(aiClassifications).length
  };

  return filtered;
}

/* ─────────────────────────────────────────────
   Parse command line arguments
───────────────────────────────────────────── */
function parseCommandLineArgs() {
  const args = process.argv.slice(2);
  let lat = null;
  let lon = null;
  let radius = RADIUS; // Default radius
  let showDetails = false; // New flag for detailed output
  let filterCategories = []; // New flag for category filtering
  let showJson = false; // Flag to show JSON output
  let useAI = false; // Flag to use AI classification

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
    } else if (args[i] === '--details' || args[i] === '-d') {
      showDetails = true;
    } else if (args[i] === '--categories' && i + 1 < args.length) {
      filterCategories = args[i + 1].split(',').map(cat => cat.trim());
      i++; // Skip next argument since we used it
    } else if (args[i] === '--json') {
      showJson = true;
    } else if (args[i] === '--ai') {
      useAI = true;
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

  return { 
    latitude: lat, 
    longitude: lon, 
    radius: radius, 
    showDetails: showDetails,
    filterCategories: filterCategories,
    showJson: showJson,
    useAI: useAI
  };
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
    // Remove type filter to get ALL nearby places, then filter by our categories
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
async function fetchNearbyPOIs(latitude, longitude, radius, filterCategories = [], useAI = false) {
  let allRawResults = [];
  let nextPageToken = "";

  console.log("🔄 Fetching raw data from Google Places API...");
  
  do {
    const page = await fetchPage({ latitude, longitude, radius, pageToken: nextPageToken });
    allRawResults = allRawResults.concat(page.results);
    nextPageToken = page.next_page_token ?? "";
    if (nextPageToken) {
      // The token needs ~2 seconds before it becomes valid
      await new Promise((r) => setTimeout(r, 2100));
    }
  } while (nextPageToken);

  console.log(`📊 Processing ${allRawResults.length} raw results...`);
  
  if (useAI && !openai) {
    console.warn("⚠️ AI classification requested but OpenAI API key not found. Using rule-based classification.");
  }
  
  // Apply intelligent processing and filtering
  const processedResults = await processPlaces(allRawResults, filterCategories, useAI);
  
  // Show filtering stats
  const stats = processedResults._stats;
  console.log(`✅ Validation: ${stats.totalRaw} → ${stats.afterValidation} (excluded ${stats.excluded} invalid)`);
  if (useAI && stats.aiClassified > 0) {
    console.log(`🤖 AI classified: ${stats.aiClassified}, Rule-based: ${stats.ruleClassified}`);
  }
  if (filterCategories.length > 0) {
    console.log(`🎯 Category filter: ${stats.afterValidation} → ${stats.afterCategoryFilter} (filtered ${stats.filteredOut})`);
  }
  
  return processedResults;
}

/* ─────────────────────────────────────────────
   Display results with intelligent formatting
───────────────────────────────────────────── */
function displayResults(pois, showDetails = false) {
  if (pois.length === 0) {
    console.log("🚫 No validated POIs found matching the criteria");
    return;
  }

  // Group by category for better organization
  const grouped = pois.reduce((acc, poi) => {
    if (!acc[poi.category]) acc[poi.category] = [];
    acc[poi.category].push(poi);
    return acc;
  }, {});

  // Sort categories by count (most common first)
  const sortedCategories = Object.keys(grouped).sort((a, b) => grouped[b].length - grouped[a].length);

  console.log(`\n📋 VALIDATED RESULTS (${pois.length} places):`);
  console.log("═".repeat(60));

  for (const category of sortedCategories) {
    const places = grouped[category];
    const categoryEmoji = getCategoryEmoji(category);
    
    console.log(`\n${categoryEmoji} ${category.toUpperCase()} (${places.length})`);
    console.log("─".repeat(40));

    for (const place of places) {
      console.log(`📍 ${place.name}`);
      console.log(`   📍 ${place.description}`);
      
      if (showDetails) {
        console.log(`   📊 Category: ${place.category}`);
        console.log(`   🏷️  All Types: ${place.types.join(', ')}`);
        console.log(`   ✅ Validated: ${place.isValidated}`);
        if (place.confidence) console.log(`   🎯 Confidence: ${(place.confidence * 100).toFixed(1)}%`);
        if (place.classificationMethod) console.log(`   🔍 Method: ${place.classificationMethod}`);
        if (place.reasoning && place.classificationMethod === 'AI') console.log(`   💭 AI Reasoning: ${place.reasoning}`);
        if (place.rating) console.log(`   ⭐ Rating: ${place.rating}`);
        if (place.priceLevel !== null) console.log(`   💰 Price Level: ${'$'.repeat(place.priceLevel + 1)}`);
        console.log(`   🗺️  Coordinates: ${place.latitude}, ${place.longitude}`);
      }
      console.log("");
    }
  }
}

/* ─────────────────────────────────────────────
   Get emoji for POI category
───────────────────────────────────────────── */
function getCategoryEmoji(category) {
  const emojis = {
    park: '🏞️',
    restaurant: '🍽️',
    attraction: '🎯',
    cafe: '☕',
    bar: '🍺',
    shopping: '🛒',
    library: '📚',
    beach: '🏖️',
    gym: '💪',
    venue: '🏟️',
    entertainment: '🎬',
    misc: '📍'
  };
  
  return emojis[category] || '📍';
}

/* ─────────────────────────────────────────────
   Main execution
───────────────────────────────────────────── */
async function main() {
  try {
    // Check for command line coordinates first
    const cmdArgs = parseCommandLineArgs();
    if (cmdArgs.showJson) {
      JSON_MODE = true;
      // Suppress normal stdout logs so only JSON is emitted
      console.log = (..._args) => {};
      console.warn = (..._args) => {};
      console.error = (..._args) => {};
    }
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
    if (cmdArgs.filterCategories.length > 0) {
      console.log(`🎯 Filtering for categories: ${cmdArgs.filterCategories.join(', ')}`);
    }
    
    const pois = await fetchNearbyPOIs(location.latitude, location.longitude, cmdArgs.radius, cmdArgs.filterCategories, cmdArgs.useAI);
    
    const locationString = location.fullAddress || 
      (location.city && location.region ? `${location.city}, ${location.region}` : 
      `${location.latitude}, ${location.longitude}`);
    
    // Clean up the results for output (remove internal fields)
    const cleanPois = pois.map(poi => {
      const { _original, ...clean } = poi;
      return clean;
    });
    
    if (cmdArgs.showJson) {
      // Emit ONLY valid JSON to stdout
      process.stdout.write(JSON.stringify(cleanPois, null, 2));
    } else {
      // Formatted output
      displayResults(cleanPois, cmdArgs.showDetails);
      
      // Show summary
      console.log(`\n🎯 SUMMARY: Found ${cleanPois.length} validated POIs near ${locationString}`);
      if (!cmdArgs.showDetails) {
        console.log(`💡 Use --details flag for more information about each place`);
      }
      console.log(`💡 Use --json flag for JSON output`);
      console.log(`💡 Use --categories park,restaurant,cafe to filter specific types`);
      console.log(`💡 Use --ai flag for AI-powered classification (requires OpenAI API key)`);
    }
  } catch (error) {
    if (JSON_MODE) {
      // Emit valid JSON even on error
      try {
        process.stdout.write(JSON.stringify([], null, 2));
      } catch (_e) {
        // no-op
      }
    } else {
      console.error("❌ Error:", error.message);
    }
  }
}

// Run the script
main();
