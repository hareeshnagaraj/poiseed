import axios from "axios";
import fs from "fs/promises";
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
  'health',      // Medical facilities, doctors, hospitals, clinics
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
   Logging utility with timestamps
───────────────────────────────────────────── */
function getTimestamp() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').substring(0, 23);
}

function log(...args) {
  console.log(`[${getTimestamp()}]`, ...args);
}

function logError(...args) {
  console.error(`[${getTimestamp()}]`, ...args);
}

function logWarn(...args) {
  console.warn(`[${getTimestamp()}]`, ...args);
}

/* ─────────────────────────────────────────────
   AI-powered place classification
───────────────────────────────────────────── */
async function classifyPlaceWithAI(place) {
  if (!openai) {
    return null; // Fallback to rule-based if no OpenAI key
  }

  const startTime = Date.now();
  log(`🔄 AI-START: Classifying "${place.name}"...`);

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
      const elapsed = Date.now() - startTime;
      logWarn(`⚠️ AI returned invalid JSON for ${place.name}. Response: ${responseContent.substring(0, 100)}... (${elapsed}ms)`);
      return null;
    }
    
    // Validate the response structure
    if (!result || typeof result !== 'object') {
      const elapsed = Date.now() - startTime;
      logWarn(`⚠️ AI returned invalid response structure for ${place.name} (${elapsed}ms)`);
      return null;
    }
    
    if (!POI_CATEGORIES.includes(result.category)) {
      const elapsed = Date.now() - startTime;
      logWarn(`⚠️ AI returned invalid category: ${result.category} for ${place.name} (${elapsed}ms)`);
      return null;
    }

    const elapsed = Date.now() - startTime;
    log(`✅ AI-DONE: "${place.name}" → ${result.category} (${elapsed}ms)`);
    return result;
  } catch (error) {
    const elapsed = Date.now() - startTime;
    logWarn(`⚠️ AI classification failed for ${place.name}: ${error.message} (${elapsed}ms)`);
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

  log(`🤖 Using AI to classify ${places.length} places...`);
  const results = {};
  const batchSize = 10; // Process 10 at a time
  
  for (let i = 0; i < places.length; i += batchSize) {
    const batch = places.slice(i, i + batchSize);
    
    // Add random delay before each request in the batch to offset API throttling
    const batchPromises = batch.map((place, index) => {
      const randomDelay = Math.floor(Math.random() * 100) + 50; // 50-150ms random delay
      return new Promise(resolve => setTimeout(resolve, randomDelay))
        .then(() => classifyPlaceWithAI(place))
        .then(result => ({ place, result }));
    });
    
    const batchResults = await Promise.all(batchPromises);
    
    for (const { place, result } of batchResults) {
      if (result) {
        results[place.place_id || place.name] = result;
      }
    }
    
    // Rate limiting: wait between batches
    if (i + batchSize < places.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  log(`🤖 AI classified ${Object.keys(results).length} places`);
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
  health: { 
    priority: 2, 
    types: ['doctor', 'hospital', 'dentist', 'pharmacy', 'physiotherapist', 'health', 'dentistry', 'medical_lab', 'veterinary_care'], 
    keywords: ['doctor', 'dr.', ' md', 'hospital', 'medical', 'clinic', 'health', 'dentist', 'dental', 'physician', 'surgery', 'care center'], 
    excludeKeywords: [] 
  },
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

// Explain why a place is globally ineligible
function explainGlobalIneligible(place) {
  const placeTypes = place.types || [];
  if (containsExcludedGlobalType(placeTypes)) {
    const offending = placeTypes.filter(t => EXCLUDED_GLOBAL_TYPES.includes(t));
    return `contains excluded global types: ${offending.join(', ')}`;
  }
  const placeName = place.name || '';
  const genericTypes = hasOnlyGenericTypes(placeTypes);
  const genericName = isGenericName(placeName);
  const addressLike = isAddressLike(placeName);
  if (genericTypes && (genericName || addressLike)) {
    const reasons = [];
    reasons.push('only generic Google types');
    if (genericName) reasons.push('generic name');
    if (addressLike) reasons.push('address-like name');
    return reasons.join(', ');
  }
  return 'globally ineligible';
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

// Explain why validation failed for a specific category
function explainValidationFailure(place, category) {
  const rules = CLASSIFICATION_RULES[category];
  if (!rules) return `unknown category: ${category}`;
  if (isGloballyIneligible(place)) {
    return explainGlobalIneligible(place);
  }
  const placeName = (place.name || '').toLowerCase();
  const placeTypes = place.types || [];
  if (rules.excludeTypes?.some(type => placeTypes.includes(type))) {
    const offending = rules.excludeTypes.filter(t => placeTypes.includes(t));
    return `has excluded types for ${category}: ${offending.join(', ')}`;
  }
  if (rules.excludeKeywords?.some(keyword => placeName.includes(keyword))) {
    const offending = rules.excludeKeywords.filter(k => placeName.includes(k));
    return `has excluded keywords for ${category}: ${offending.join(', ')}`;
  }
  const hasMatchingType = rules.types?.some(type => placeTypes.includes(type)) || false;
  const hasMatchingKeyword = rules.keywords?.some(keyword => placeName.includes(keyword)) || false;
  if (category === 'misc') {
    if (hasOnlyGenericTypes(placeTypes) || isGenericName(place.name) || isAddressLike(place.name)) {
      return 'misc disallowed for generic/address-like entries without specific signals';
    }
  }
  if (!hasMatchingType && !hasMatchingKeyword && category !== 'misc') {
    return `no matching type/keyword for ${category}`;
  }
  return 'failed validation';
}

/* ─────────────────────────────────────────────
   Filter and enhance places with intelligent categorization (AI-powered)
   Now with optimized flow: pre-filter → classify → validate → AI (optional) → category filter
───────────────────────────────────────────── */
async function processPlaces(rawPlaces, filterCategories = [], useAI = false) {
  log(`📊 Processing ${rawPlaces.length} raw places...`);
  
  // STEP 1: Pre-filter - Remove globally ineligible entries first
  log(`🔍 STEP 1: Pre-filtering globally ineligible entries...`);
  const preFiltered = rawPlaces.filter(place => {
    if (isGloballyIneligible(place)) {
      const reason = explainGlobalIneligible(place);
      log(`🚫 PRE-FILTER: excluded "${place.name}" – ${reason}`);
      return false;
    }
    return true;
  });
  log(`✅ Pre-filter: ${rawPlaces.length} → ${preFiltered.length} (excluded ${rawPlaces.length - preFiltered.length})`);

  // STEP 2: Rule-based classification for all remaining places
  log(`🔍 STEP 2: Applying rule-based classification...`);
  const classified = preFiltered.map(place => {
    const bestCategory = getBestCategory(place);
    log(`📊 CLASSIFY: "${place.name}" → ${bestCategory} (rule-based)`);
    return {
      name: place.name,
      description: place.vicinity ?? "",
      latitude: place.geometry.location.lat,
      longitude: place.geometry.location.lng,
      category: bestCategory,
      types: place.types || [],
      rating: place.rating || null,
      priceLevel: place.price_level || null,
      _original: place
    };
  });

  // STEP 3: Local validation - Check if category assignments are valid
  log(`🔍 STEP 3: Validating category assignments...`);
  const validated = classified.filter(place => {
    const isValid = validatePlace(place._original, place.category);
    if (!isValid) {
      const reason = explainValidationFailure(place._original, place.category);
      log(`🚫 VALIDATE: excluded "${place.name}" [${place.category}] – ${reason}`);
      return false;
    }
    return true;
  });
  log(`✅ Validation: ${classified.length} → ${validated.length} (excluded ${classified.length - validated.length})`);

  // STEP 4: Apply category filter if specified (BEFORE AI to save API calls)
  let categoryFiltered = validated;
  if (filterCategories.length > 0) {
    log(`🔍 STEP 4: Applying category filter [${filterCategories.join(', ')}]...`);
    categoryFiltered = validated.filter(place => {
      const keep = filterCategories.includes(place.category);
      if (!keep) {
        log(`🚫 CATEGORY: excluded "${place.name}" – category filter (category=${place.category}, allowed=${filterCategories.join(', ')})`);
      }
      return keep;
    });
    log(`✅ Category filter: ${validated.length} → ${categoryFiltered.length} (excluded ${validated.length - categoryFiltered.length})`);
  }

  // STEP 5: AI classification (optional) - Only for category-filtered entries
  let aiEnhanced = categoryFiltered;
  if (useAI && openai && categoryFiltered.length > 0) {
    log(`🔍 STEP 5: Applying AI classification to ${categoryFiltered.length} category-filtered entries...`);
    const aiClassifications = await batchClassifyWithAI(categoryFiltered.map(p => p._original));
    
    aiEnhanced = categoryFiltered.map(place => {
      const placeId = place._original.place_id || place.name;
      const aiResult = aiClassifications[placeId];
      
      if (aiResult && aiResult.isValid) {
        // AI provided a better classification
        const aiCategory = aiResult.category;
        const aiValid = validatePlace(place._original, aiCategory);
        
        // Also check if AI category matches filter
        const categoryAllowed = filterCategories.length === 0 || filterCategories.includes(aiCategory);
        
        if (aiValid && categoryAllowed) {
          log(`🤖 AI-CLASSIFY: "${place.name}" → ${aiCategory} (confidence: ${(aiResult.confidence * 100).toFixed(0)}%)`);
          return {
            ...place,
            category: aiCategory,
            confidence: aiResult.confidence,
            reasoning: aiResult.reasoning,
            classificationMethod: 'AI',
            isValidated: true
          };
        } else if (!categoryAllowed) {
          log(`⚠️  AI-CLASSIFY: "${place.name}" AI suggested ${aiCategory} but not in allowed categories, keeping ${place.category}`);
        } else {
          log(`⚠️  AI-CLASSIFY: "${place.name}" AI suggested ${aiCategory} but failed validation, keeping ${place.category}`);
        }
      }
      
      // Keep rule-based classification
      return {
        ...place,
        confidence: 0.8,
        reasoning: "Rule-based classification",
        classificationMethod: 'Rules',
        isValidated: true
      };
    });
  } else {
    // No AI, just add metadata to category-filtered entries
    aiEnhanced = categoryFiltered.map(place => ({
      ...place,
      confidence: 0.8,
      reasoning: "Rule-based classification",
      classificationMethod: 'Rules',
      isValidated: true
    }));
  }

  let filtered = aiEnhanced;

  // Add stats for debugging
  filtered._stats = {
    totalRaw: rawPlaces.length,
    afterPreFilter: preFiltered.length,
    afterClassification: classified.length,
    afterValidation: validated.length,
    afterCategoryFilter: categoryFiltered.length,
    afterAI: aiEnhanced.length,
    final: filtered.length,
    preFilterExcluded: rawPlaces.length - preFiltered.length,
    validationExcluded: classified.length - validated.length,
    categoryFilterExcluded: validated.length - categoryFiltered.length
  };

  return filtered;
}

/* ─────────────────────────────────────────────
   Parse command line arguments
───────────────────────────────────────────── */
function parseCommandLineArgs() {
  const args = process.argv.slice(2).map(arg => {
    // Normalize em-dashes and en-dashes to regular dashes (common copy-paste issue)
    return arg.replace(/^[—–]+/, '--');
  });
  let lat = null;
  let lon = null;
  let radius = RADIUS; // Default radius
  let showDetails = false; // New flag for detailed output
  let filterCategories = []; // New flag for category filtering
  let showJson = false; // Flag to show JSON output
  let useAI = false; // Flag to use AI classification
  let target = null; // Target number of POIs to collect
  let step = null; // Step size in meters between queries
  let maxSteps = 200; // Maximum steps to prevent infinite loops
  let outFile = null; // Optional output file for JSON

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lat' && i + 1 < args.length) {
      lat = parseFloat(args[i + 1]);
      i++;
    } else if (args[i] === '--lon' && i + 1 < args.length) {
      lon = parseFloat(args[i + 1]);
      i++;
    } else if (args[i] === '--radius' && i + 1 < args.length) {
      radius = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--details' || args[i] === '-d') {
      showDetails = true;
    } else if (args[i] === '--categories' && i + 1 < args.length) {
      filterCategories = args[i + 1].split(',').map(cat => cat.trim());
      i++;
    } else if (args[i] === '--json') {
      showJson = true;
    } else if (args[i] === '--ai') {
      useAI = true;
    } else if (args[i] === '--target' && i + 1 < args.length) {
      target = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--step' && i + 1 < args.length) {
      step = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--maxSteps' && i + 1 < args.length) {
      maxSteps = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--out' && i + 1 < args.length) {
      outFile = args[i + 1];
      i++;
    }
  }

  // Validate coordinates if provided
  if ((lat !== null && lon === null) || (lat === null && lon !== null)) {
    logError("❌ Error: Both --lat and --lon must be provided together");
    process.exit(1);
  }

  if (lat !== null && (lat < -90 || lat > 90)) {
    logError("❌ Error: Latitude must be between -90 and 90");
    process.exit(1);
  }

  if (lon !== null && (lon < -180 || lon > 180)) {
    logError("❌ Error: Longitude must be between -180 and 180");
    process.exit(1);
  }

  if (radius < 1 || radius > 50000) {
    logError("❌ Error: Radius must be between 1 and 50000 meters");
    process.exit(1);
  }

  if (target !== null && target < 1) {
    logError("❌ Error: Target must be at least 1");
    process.exit(1);
  }

  if (step !== null && (step < 1 || step > 50000)) {
    logError("❌ Error: Step must be between 1 and 50000 meters");
    process.exit(1);
  }

  if (maxSteps < 1) {
    logError("❌ Error: maxSteps must be at least 1");
    process.exit(1);
  }

  // Default step to 80% of radius if not specified
  if (step === null) {
    step = Math.floor(radius * 0.8);
  }

  return { 
    latitude: lat, 
    longitude: lon, 
    radius: radius, 
    showDetails: showDetails,
    filterCategories: filterCategories,
    showJson: showJson,
    useAI: useAI,
    target: target,
    step: step,
    maxSteps: maxSteps,
    outFile: outFile
  };
}

/* ─────────────────────────────────────────────
   Get current location based on IP
───────────────────────────────────────────── */
async function getCurrentLocation() {
  try {
    log("🌍 Getting your current location...");
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
    
    log(`📍 Found location: ${fullAddress}`);
    log(`📐 Coordinates: ${data.latitude}, ${data.longitude}`);
    
    // Warning about IP geolocation accuracy
    log(`⚠️  IP-based location detection can be inaccurate (±1-2km)`);
    log(`💡 For precise results, use: node index.mjs --lat ${data.latitude} --lon ${data.longitude}`);
    
    // If we have more detailed address info, show it
    if (data.postal || data.region_code || data.timezone) {
      log(`📮 Additional details:`);
      if (data.postal) log(`   Postal Code: ${data.postal}`);
      if (data.region_code) log(`   Region Code: ${data.region_code}`);
      if (data.timezone) log(`   Timezone: ${data.timezone}`);
      if (data.org) log(`   ISP: ${data.org}`);
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
    logError(`❌ Location detection failed: ${error.message}`);
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

  log(`🔄 Fetching raw data from Google Places API... categories=[${filterCategories.join(', ')}]`);
  
  do {
    const page = await fetchPage({ latitude, longitude, radius, pageToken: nextPageToken });
    allRawResults = allRawResults.concat(page.results);
    nextPageToken = page.next_page_token ?? "";
    if (nextPageToken) {
      // The token needs ~2 seconds before it becomes valid
      await new Promise((r) => setTimeout(r, 2100));
    }
  } while (nextPageToken);

  log(`📊 Fetched ${allRawResults.length} raw results from Google Places API`);
  
  if (useAI && !openai) {
    logWarn("⚠️ AI classification requested but OpenAI API key not found. Using rule-based classification.");
  }
  
  // Apply intelligent processing and filtering
  const processedResults = await processPlaces(allRawResults, filterCategories, useAI);
  
  // Show filtering stats summary
  const stats = processedResults._stats;
  log(`📈 SUMMARY: ${stats.totalRaw} raw → ${stats.final} final (${stats.preFilterExcluded} pre-filtered, ${stats.validationExcluded} validation failed, ${stats.categoryFilterExcluded} category filtered)`);
  
  return processedResults;
}

/* ─────────────────────────────────────────────
   Display results with intelligent formatting
───────────────────────────────────────────── */
function displayResults(pois, showDetails = false) {
  if (pois.length === 0) {
    log("🚫 No validated POIs found matching the criteria");
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

  log(`\n📋 VALIDATED RESULTS (${pois.length} places):`);
  log("═".repeat(60));

  for (const category of sortedCategories) {
    const places = grouped[category];
    const categoryEmoji = getCategoryEmoji(category);
    
    log(`\n${categoryEmoji} ${category.toUpperCase()} (${places.length})`);
    log("─".repeat(40));

    for (const place of places) {
      log(`📍 ${place.name}`);
      log(`   📍 ${place.description}`);
      
      if (showDetails) {
        log(`   📊 Category: ${place.category}`);
        log(`   🏷️  All Types: ${place.types.join(', ')}`);
        log(`   ✅ Validated: ${place.isValidated}`);
        if (place.confidence) log(`   🎯 Confidence: ${(place.confidence * 100).toFixed(1)}%`);
        if (place.classificationMethod) log(`   🔍 Method: ${place.classificationMethod}`);
        if (place.reasoning && place.classificationMethod === 'AI') log(`   💭 AI Reasoning: ${place.reasoning}`);
        if (place.rating) log(`   ⭐ Rating: ${place.rating}`);
        if (place.priceLevel !== null) log(`   💰 Price Level: ${'$'.repeat(place.priceLevel + 1)}`);
        log(`   🗺️  Coordinates: ${place.latitude}, ${place.longitude}`);
      }
      log("");
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
    health: '🏥',
    misc: '📍'
  };
  
  return emojis[category] || '📍';
}

/* ─────────────────────────────────────────────
   Spiral coordinate walker for expanding coverage
───────────────────────────────────────────── */
class SpiralWalker {
  constructor(startLat, startLon, stepMeters) {
    this.startLat = startLat;
    this.startLon = startLon;
    this.stepMeters = stepMeters;
    this.currentLat = startLat;
    this.currentLon = startLon;
    this.stepIndex = 0;
    this.direction = 0; // 0=E, 1=N, 2=W, 3=S
    this.stepsInCurrentLeg = 1;
    this.stepsTakenInCurrentLeg = 0;
    this.legsCompleted = 0;
  }

  // Convert meters to degree offset at current latitude
  metersToLatDelta(meters) {
    return meters / 111320; // 1 degree latitude ≈ 111.32 km
  }

  metersToLonDelta(meters, lat) {
    const latRad = (lat * Math.PI) / 180;
    return meters / (111320 * Math.cos(latRad));
  }

  next() {
    if (this.stepIndex === 0) {
      this.stepIndex++;
      return { lat: this.currentLat, lon: this.currentLon, step: 0 };
    }

    const latDelta = this.metersToLatDelta(this.stepMeters);
    const lonDelta = this.metersToLonDelta(this.stepMeters, this.currentLat);

    // Move in current direction
    if (this.direction === 0) {
      this.currentLon += lonDelta; // East
    } else if (this.direction === 1) {
      this.currentLat += latDelta; // North
    } else if (this.direction === 2) {
      this.currentLon -= lonDelta; // West
    } else if (this.direction === 3) {
      this.currentLat -= latDelta; // South
    }

    this.stepsTakenInCurrentLeg++;

    if (this.stepsTakenInCurrentLeg >= this.stepsInCurrentLeg) {
      this.stepsTakenInCurrentLeg = 0;
      this.direction = (this.direction + 1) % 4;
      this.legsCompleted++;
      
      // Increase leg length every 2 legs (after completing a turn)
      if (this.legsCompleted % 2 === 0) {
        this.stepsInCurrentLeg++;
      }
    }

    this.stepIndex++;
    return { lat: this.currentLat, lon: this.currentLon, step: this.stepIndex };
  }
}

/* ─────────────────────────────────────────────
   Deduplication utilities
───────────────────────────────────────────── */
function getPOIKey(poi) {
  // Prefer place_id from original Google data
  if (poi._original && poi._original.place_id) {
    return `pid:${poi._original.place_id}`;
  }
  // Fallback: name + rounded coordinates
  const latRounded = poi.latitude.toFixed(5);
  const lonRounded = poi.longitude.toFixed(5);
  return `name:${poi.name}|${latRounded},${lonRounded}`;
}

/* ─────────────────────────────────────────────
   Collect POIs until target is reached using spiral search
───────────────────────────────────────────── */
async function collectPOIsUntilTarget(startLat, startLon, radius, target, step, maxSteps, filterCategories, useAI) {
  log(`🎯 Target mode: collecting ${target} unique POIs...`);
  log(`📍 Starting at: ${startLat.toFixed(6)}, ${startLon.toFixed(6)}`);
  log(`🔄 Search radius: ${radius}m, step: ${step}m, max steps: ${maxSteps}`);
  
  const uniquePOIs = new Map(); // key -> poi object
  const walker = new SpiralWalker(startLat, startLon, step);
  let stepCount = 0;

  while (uniquePOIs.size < target && stepCount < maxSteps) {
    const coord = walker.next();
    stepCount++;

    log(`\n📍 Step ${stepCount}/${maxSteps}: querying (${coord.lat.toFixed(6)}, ${coord.lon.toFixed(6)})...`);
    
    try {
      const pois = await fetchNearbyPOIs(coord.lat, coord.lon, radius, filterCategories, useAI);
      
      let newCount = 0;
      for (const poi of pois) {
        const key = getPOIKey(poi);
        if (!uniquePOIs.has(key)) {
          uniquePOIs.set(key, poi);
          newCount++;
        }
      }
      
      log(`✅ Step ${stepCount}: +${newCount} new, ${uniquePOIs.size}/${target} total unique POIs`);
      
      if (uniquePOIs.size >= target) {
        log(`🎉 Target reached! Collected ${uniquePOIs.size} unique POIs in ${stepCount} steps.`);
        break;
      }
      
      // Small delay between steps
      await new Promise(r => setTimeout(r, 500));
    } catch (error) {
      logError(`❌ Step ${stepCount} failed: ${error.message}`);
    }
  }

  if (uniquePOIs.size < target) {
    log(`⚠️  Stopped after ${stepCount} steps with ${uniquePOIs.size}/${target} POIs (maxSteps reached)`);
  }

  return Array.from(uniquePOIs.values());
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
      // In JSON mode with --out file: keep logs visible and write JSON to file
      // In JSON mode without --out: redirect logs to stderr, write JSON to stdout
      if (!cmdArgs.outFile) {
        console.log = (...args) => { try { process.stderr.write(args.join(' ') + "\n"); } catch (_) {} };
        console.warn = (...args) => { try { process.stderr.write(args.join(' ') + "\n"); } catch (_) {} };
        console.error = (...args) => { try { process.stderr.write(args.join(' ') + "\n"); } catch (_) {} };
      }
    }
    let location;

    if (cmdArgs.latitude !== null && cmdArgs.longitude !== null) {
      log("📍 Using coordinates from command line:");
      log(`📐 Coordinates: ${cmdArgs.latitude}, ${cmdArgs.longitude}`);
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
        logError("🚨 CRITICAL ERROR: Unable to determine your location!");
        logError("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        logError("❌ Location detection failed and no coordinates were provided via command line.");
        logError("❌ This could be due to:");
        logError("   • VPN or proxy blocking location services");
        logError("   • Network connectivity issues");
        logError("   • Location service API being unavailable");
        logError("");
        logError("💡 SOLUTIONS:");
        logError("   • Provide coordinates manually: node index.mjs --lat 40.7829 --lon -73.9654");
        logError("   • Try disabling VPN/proxy if you're using one");
        logError("   • Check your internet connection");
        logError("");
        logError("⚠️  PROCEEDING WITH FALLBACK: Using NYC coordinates (40.727233, -73.984592)");
        logError("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        logError("");
        
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
    
    // Fetch POIs: either target mode (spiral search) or single query
    let pois;
    if (cmdArgs.target !== null) {
      // Target mode: collect POIs until target is reached
      pois = await collectPOIsUntilTarget(
        location.latitude,
        location.longitude,
        cmdArgs.radius,
        cmdArgs.target,
        cmdArgs.step,
        cmdArgs.maxSteps,
        cmdArgs.filterCategories,
        cmdArgs.useAI
      );
    } else {
      // Single query mode
      log(`🔍 Searching for POIs within ${cmdArgs.radius}m...`);
      if (cmdArgs.filterCategories.length > 0) {
        log(`🎯 Filtering for categories: ${cmdArgs.filterCategories.join(', ')}`);
      }
      pois = await fetchNearbyPOIs(location.latitude, location.longitude, cmdArgs.radius, cmdArgs.filterCategories, cmdArgs.useAI);
    }
    
    const locationString = location.fullAddress || 
      (location.city && location.region ? `${location.city}, ${location.region}` : 
      `${location.latitude}, ${location.longitude}`);
    
    // Clean up the results for output (remove internal fields)
    const cleanPois = pois.map(poi => {
      const { _original, ...clean } = poi;
      return clean;
    });
    
    if (cmdArgs.showJson) {
      if (cmdArgs.outFile) {
        // Write JSON to file
        await fs.writeFile(cmdArgs.outFile, JSON.stringify(cleanPois, null, 2), 'utf8');
        log(`\n📝 Wrote ${cleanPois.length} POIs to ${cmdArgs.outFile}`);
      } else {
        // Emit ONLY valid JSON to stdout
        process.stdout.write(JSON.stringify(cleanPois, null, 2));
      }
    } else {
      // Formatted output
      displayResults(cleanPois, cmdArgs.showDetails);
      
      // Show summary
      log(`\n🎯 SUMMARY: Found ${cleanPois.length} validated POIs near ${locationString}`);
      if (!cmdArgs.showDetails) {
        log(`💡 Use --details flag for more information about each place`);
      }
      log(`💡 Use --json flag for JSON output`);
      log(`💡 Use --out <file> to write JSON to file`);
      log(`💡 Use --target <n> to collect a specific number of POIs`);
      log(`💡 Use --categories park,restaurant,cafe to filter specific types`);
      log(`💡 Use --ai flag for AI-powered classification (requires OpenAI API key)`);
    }
  } catch (error) {
    if (JSON_MODE) {
      try {
        const empty = JSON.stringify([], null, 2);
        const cmdArgs = parseCommandLineArgs();
        if (cmdArgs.outFile) {
          await fs.writeFile(cmdArgs.outFile, empty, 'utf8');
          log(`📝 Wrote 0 POIs to ${cmdArgs.outFile}`);
        } else {
          process.stdout.write(empty);
        }
      } catch (_e) {}
    } else {
      logError("❌ Error:", error.message);
    }
  }
}

// Run the script
main();
