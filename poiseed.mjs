#!/usr/bin/env node
import axios from "axios";
import fs from "fs/promises";
import path from "path";
import process from "process";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

/* ─────────────────────────────────────────────
   Shared Config and Utilities
───────────────────────────────────────────── */
const DEFAULT_RADIUS = 500;
const API_KEY = process.env.GOOGLE_PLACES_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

function normalizeArgs(args) {
  // Normalize leading em/en-dashes to standard "--" to avoid copy/paste issues
  return args.map(a => a.replace(/^[—–]+/, "--"));
}

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
   Geocoding
───────────────────────────────────────────── */
async function geocodeLocale(localeName) {
  const url = "https://maps.googleapis.com/maps/api/geocode/json";
  const { data } = await axios.get(url, {
    params: { address: localeName, key: API_KEY }
  });

  if (data.status !== "OK" || !data.results || data.results.length === 0) {
    throw new Error(`Geocoding failed for "${localeName}": ${data.status} - ${data.error_message || "No results found"}`);
  }

  const result = data.results[0];
  const location = result.geometry.location;
  const viewport = result.geometry.viewport;

  const center = {
    lat: location.lat,
    lon: location.lng
  };

  const bounds = viewport ? {
    northeast: { lat: viewport.northeast.lat, lon: viewport.northeast.lng },
    southwest: { lat: viewport.southwest.lat, lon: viewport.southwest.lng }
  } : null;

  return {
    center,
    bounds,
    formattedAddress: result.formatted_address,
    placeId: result.place_id,
    types: result.types || []
  };
}

/* ─────────────────────────────────────────────
   Grid Sampler
───────────────────────────────────────────── */
class GridSampler {
  constructor(bounds, options = {}) {
    this.bounds = bounds;
    this.centerDensity = options.centerDensity || 400; // meters between points in center
    this.edgeDensity = options.edgeDensity || 800; // meters between points at edges
    this.maxPoints = options.maxPoints || 200;
  }

  metersToLatDelta(meters) {
    return meters / 111320;
  }

  metersToLonDelta(meters, lat) {
    const latRad = (lat * Math.PI) / 180;
    return meters / (111320 * Math.cos(latRad));
  }

  distanceBetweenPoints(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth's radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  generatePoints() {
    const points = [];
    const { northeast, southwest } = this.bounds;
    
    const centerLat = (northeast.lat + southwest.lat) / 2;
    const centerLon = (northeast.lon + southwest.lon) / 2;
    
    const maxDistLat = this.distanceBetweenPoints(centerLat, centerLon, northeast.lat, centerLon);
    const maxDistLon = this.distanceBetweenPoints(centerLat, centerLon, centerLat, northeast.lon);
    const maxDist = Math.max(maxDistLat, maxDistLon);

    // Generate concentric rings from center outward
    // Ring 0 = center point
    points.push({ lat: centerLat, lon: centerLon, priority: 1.0 });

    let ringRadius = this.centerDensity;
    let ringIndex = 1;

    while (ringRadius < maxDist && points.length < this.maxPoints) {
      // Calculate density for this ring (interpolate between center and edge density)
      const distanceRatio = Math.min(ringRadius / maxDist, 1);
      const currentDensity = this.centerDensity + (this.edgeDensity - this.centerDensity) * distanceRatio;
      
      // Calculate number of points in this ring (circumference / density)
      const circumference = 2 * Math.PI * ringRadius;
      const pointsInRing = Math.max(4, Math.floor(circumference / currentDensity));
      
      // Priority decreases with distance from center
      const priority = 1.0 - (distanceRatio * 0.5);

      for (let i = 0; i < pointsInRing && points.length < this.maxPoints; i++) {
        const angle = (2 * Math.PI * i) / pointsInRing;
        const latOffset = this.metersToLatDelta(ringRadius) * Math.cos(angle);
        const lonOffset = this.metersToLonDelta(ringRadius, centerLat) * Math.sin(angle);
        
        const newLat = centerLat + latOffset;
        const newLon = centerLon + lonOffset;

        // Only add if within bounds
        if (newLat >= southwest.lat && newLat <= northeast.lat &&
            newLon >= southwest.lon && newLon <= northeast.lon) {
          points.push({ lat: newLat, lon: newLon, priority });
        }
      }

      // Next ring is further out, with increasing spacing
      ringIndex++;
      ringRadius = this.centerDensity * ringIndex + (this.edgeDensity - this.centerDensity) * (ringIndex / 10);
    }

    // Sort by priority (highest first) so we query center points first
    points.sort((a, b) => b.priority - a.priority);
    
    return points;
  }
}

/* ─────────────────────────────────────────────
   Classification Rules (copied from index.mjs)
───────────────────────────────────────────── */
const POI_CATEGORIES = [
  'park','restaurant','attraction','cafe','bar','shopping','library','beach','gym','venue','entertainment','health','misc'
];

const GENERIC_PLACE_TYPES = [
  'establishment','point_of_interest','locality','political','sublocality','neighborhood','administrative_area_level_1','administrative_area_level_2','country','route','street_address','premise','colloquial_area'
];

const EXCLUDED_GLOBAL_TYPES = [
  'locality','political','country','administrative_area_level_1','administrative_area_level_2','administrative_area_level_3','sublocality','neighborhood','colloquial_area'
];

const GENERIC_BAD_NAMES = ['website', 'home', 'my location', 'new york'];

const CLASSIFICATION_RULES = {
  park: { priority: 10, types: ['park','campground','rv_park'], keywords: ['park','garden','green','playground','recreation','square','plaza','promenade','waterfront','pier','trail','commons','field'], excludeKeywords: ['restaurant','bar','cafe','hotel','store','shop','market','pharmacy','bank'] },
  shopping: { priority: 9, types: ['shopping_mall','department_store','clothing_store','shoe_store','jewelry_store','electronics_store','furniture_store','home_goods_store','book_store','bicycle_store','store','supermarket','grocery_or_supermarket','convenience_store','drugstore','pharmacy','florist','hardware_store','laundry','pet_store'], keywords: ['store','shop','market','boutique','outlet','retail'], excludeKeywords: [] },
  entertainment: { priority: 8, types: ['movie_theater','amusement_park'], keywords: ['cinema','theater','theatre','movie','amusement','arcade','entertainment'], excludeTypes: ['store'], excludeKeywords: ['store','shop'] },
  venue: { priority: 7, types: ['stadium','bowling_alley','casino'], keywords: ['stadium','arena','venue','hall','center','auditorium','amphitheater','bowling','casino','convention'], excludeTypes: ['store','clothing_store','electronics_store','book_store','shoe_store'], excludeKeywords: ['store','shop','market','boutique','retail'] },
  attraction: { priority: 6, types: ['tourist_attraction','museum','zoo','aquarium','art_gallery','church','hindu_temple','mosque','synagogue','city_hall','courthouse','embassy'], keywords: ['museum','gallery','monument','memorial','historic','cathedral','church','temple','bridge','tower','statue'], excludeKeywords: [] },
  cafe: { priority: 5, types: ['cafe','bakery'], keywords: ['cafe','coffee','bakery','patisserie','espresso'], excludeKeywords: [] },
  bar: { priority: 4, types: ['bar','night_club'], keywords: ['bar','pub','tavern','lounge','brewery','taproom','cocktail','nightclub'], excludeTypes: ['drugstore','convenience_store','pharmacy','health'], excludeKeywords: ['cvs','duane reade','walgreens','rite aid'] },
  restaurant: { priority: 3, types: ['restaurant','meal_takeaway','meal_delivery','food'], keywords: ['restaurant','bistro','eatery','kitchen','grill','diner','pizzeria','steakhouse'], excludeTypes: ['drugstore','convenience_store','pharmacy','health'], excludeKeywords: ['cvs','duane reade','walgreens','rite aid'] },
  beach: { priority: 2, types: ['natural_feature'], keywords: ['beach','shore','waterfront','marina','harbor','pier','wharf','dock'], excludeKeywords: [] },
  library: { priority: 2, types: ['library','school','university'], keywords: ['library','school','university','college','academy','institute'], excludeKeywords: [] },
  gym: { priority: 2, types: ['gym','spa'], keywords: ['gym','fitness','yoga','pilates','crossfit','spa','wellness'], excludeKeywords: [] },
  health: { priority: 2, types: ['doctor','hospital','dentist','pharmacy','physiotherapist','health','dentistry','medical_lab','veterinary_care'], keywords: ['doctor','dr.',' md','hospital','medical','clinic','health','dentist','dental','physician','surgery','care center'], excludeKeywords: [] },
  misc: { priority: 1, types: [], keywords: [], excludeKeywords: [] }
};

function getBestCategory(place) {
  const placeName = (place.name || '').toLowerCase();
  const placeTypes = place.types || [];
  let bestMatch = { category: 'misc', priority: 0, confidence: 0 };
  for (const [category, rules] of Object.entries(CLASSIFICATION_RULES)) {
    if (rules.excludeTypes?.some(type => placeTypes.includes(type))) continue;
    if (rules.excludeKeywords?.some(keyword => placeName.includes(keyword))) continue;
    let confidence = 0;
    const typeMatches = rules.types?.filter(type => placeTypes.includes(type)).length || 0;
    confidence += typeMatches * 2;
    const keywordMatches = rules.keywords?.filter(keyword => placeName.includes(keyword)).length || 0;
    confidence += keywordMatches;
    if (category === 'bar' && placeTypes.includes('liquor_store') && !placeTypes.some(type => ['drugstore','convenience_store','store'].includes(type))) {
      confidence += 1;
    }
    if (confidence > 0 && (rules.priority > bestMatch.priority || (rules.priority === bestMatch.priority && confidence > bestMatch.confidence))) {
      bestMatch = { category, priority: rules.priority, confidence };
    }
  }
  return bestMatch.category;
}

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
  const placeName = (place.name || '').toLowerCase();
  const placeTypes = place.types || [];
  if (isGloballyIneligible(place)) return false;
  if (rules.excludeTypes?.some(type => placeTypes.includes(type))) return false;
  if (rules.excludeKeywords?.some(keyword => placeName.includes(keyword))) return false;
  const hasMatchingType = rules.types?.some(type => placeTypes.includes(type)) || false;
  const hasMatchingKeyword = rules.keywords?.some(keyword => placeName.includes(keyword)) || false;
  if (category === 'bar' && placeTypes.includes('liquor_store') && !placeTypes.some(type => ['drugstore','convenience_store','store'].includes(type))) {
    return true;
  }
  if (category === 'misc') {
    if (hasOnlyGenericTypes(placeTypes) || isGenericName(place.name) || isAddressLike(place.name)) {
      return false;
    }
  }
  return hasMatchingType || hasMatchingKeyword || category === 'misc';
}

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
   AI Classification (from index.mjs)
───────────────────────────────────────────── */
async function classifyPlaceWithAI(place) {
  if (!openai) return null;
  const startTime = Date.now();
  log(`🔄 AI-START: Classifying "${place.name}"...`);
  try {
    const prompt = `\nAnalyze this place and classify it into the most appropriate category.\n\nPlace Details:\n- Name: "${place.name}"\n- Description/Address: "${place.vicinity || 'N/A'}"\n- Google Types: ${(place.types || []).join(', ')}\n- Rating: ${place.rating || 'N/A'}\n\nAvailable Categories: ${POI_CATEGORIES.join(', ')}\n\nCategory Definitions:\n- park: Outdoor recreational spaces (parks, gardens, playgrounds)\n- restaurant: Food, drinks, dining (restaurants, diners, food trucks)\n- attraction: Tourist sites, museums, landmarks, public squares, religious sites\n- cafe: Coffee shops, casual dining, bakeries\n- bar: Bars, pubs, nightlife, breweries\n- shopping: Retail stores, malls, supermarkets, pharmacies\n- library: Educational/community spaces (libraries, schools, universities)\n- beach: Waterfront recreation (beaches, piers, marinas)\n- gym: Fitness centers, sports facilities, spas\n- venue: Venues, events, concerts, stadiums, halls, convention centers\n- entertainment: Entertainment, shows, movies, theaters, amusement parks\n- misc: Everything that doesn't fit elsewhere\n\nConsider:\n1. What is the PRIMARY purpose/function of this place?\n2. What would a person most likely visit this place for?\n3. If a place has multiple functions, choose based on its MAIN purpose (follow provided hints)\n\nCRITICAL: Respond with ONLY a valid JSON object. Do NOT use markdown or code fences.\n\nRequired JSON format:\n{\n  "category": "most_appropriate_category",\n  "confidence": 0.95,\n  "reasoning": "Brief explanation of why this category was chosen",\n  "isValid": true,\n  "alternativeCategory": "second_best_option_or_null"\n}\n\nRules:\n- The category MUST be one from the available categories list\n- Set isValid to false if this doesn't seem like a legitimate business/place\n- Do NOT wrap the JSON in markdown\n`;
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a place classification assistant. Always respond with valid JSON only, never use markdown formatting or code blocks." },
        { role: "user", content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 200
    });
    let responseContent = response.choices[0].message.content.trim();
    if (responseContent.startsWith('```')) {
      responseContent = responseContent.replace(/```json\s*/, '').replace(/```\s*$/, '');
    }
    responseContent = responseContent.trim();
    let result;
    try {
      result = JSON.parse(responseContent);
    } catch (_e) {
      const elapsed = Date.now() - startTime;
      logWarn(`⚠️ AI returned invalid JSON for ${place.name}. Response: ${responseContent.substring(0, 100)}... (${elapsed}ms)`);
      return null;
    }
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

async function batchClassifyWithAI(places) {
  if (!openai || places.length === 0) return {};
  log(`🤖 Using AI to classify ${places.length} places...`);
  const results = {};
  const batchSize = 10;
  for (let i = 0; i < places.length; i += batchSize) {
    const batch = places.slice(i, i + batchSize);
    const batchPromises = batch.map((place) => {
      const randomDelay = Math.floor(Math.random() * 100) + 50;
      return new Promise(resolve => setTimeout(resolve, randomDelay))
        .then(() => classifyPlaceWithAI(place))
        .then(result => ({ place, result }));
    });
    const batchResults = await Promise.all(batchPromises);
    for (const { place, result } of batchResults) {
      if (result) results[place.place_id || place.name] = result;
    }
    if (i + batchSize < places.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  log(`🤖 AI classified ${Object.keys(results).length} places`);
  return results;
}

/* ─────────────────────────────────────────────
   Fetch + Process (from index.mjs)
───────────────────────────────────────────── */
async function getCurrentLocation() {
  try {
    log("🌍 Getting your current location...");
    const { data } = await axios.get("http://ipapi.co/json/");
    if (!data) throw new Error("No data received from location service");
    if (!data.latitude || !data.longitude) throw new Error(`Invalid coordinates received: lat=${data.latitude}, lon=${data.longitude}`);
    if (data.latitude < -90 || data.latitude > 90) throw new Error(`Invalid latitude: ${data.latitude}`);
    if (data.longitude < -180 || data.longitude > 180) throw new Error(`Invalid longitude: ${data.longitude}`);
    const parts = [];
    if (data.city) parts.push(data.city);
    if (data.region) parts.push(data.region);
    if (data.postal) parts.push(data.postal);
    if (data.country_name) parts.push(data.country_name);
    const fullAddress = parts.join(", ");
    log(`📍 Found location: ${fullAddress}`);
    log(`📐 Coordinates: ${data.latitude}, ${data.longitude}`);
    log(`⚠️  IP-based location detection can be inaccurate (±1-2km)`);
    return { success: true, latitude: data.latitude, longitude: data.longitude, city: data.city, region: data.region, country: data.country_name, postal: data.postal, fullAddress };
  } catch (error) {
    logError(`❌ Location detection failed: ${error.message}`);
    return { success: false, error: error.message, latitude: null, longitude: null, city: null, region: null, country: null, postal: null, fullAddress: null };
  }
}

async function fetchPage({ latitude, longitude, radius, pageToken = "" } = {}) {
  const url = "https://maps.googleapis.com/maps/api/place/nearbysearch/json";
  const params = { location: `${latitude},${longitude}`, radius, key: API_KEY, pagetoken: pageToken };
  const { data } = await axios.get(url, { params });
  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    throw new Error(`Places API error: ${data.status} - ${data.error_message ?? ""}`);
  }
  return data;
}

async function fetchNearbyPOIs(latitude, longitude, radius, filterCategories = [], useAI = false, options = {}) {
  const quiet = options.quiet || false;
  let allRawResults = [];
  let nextPageToken = "";
  if (!quiet) log(`🔄 Fetching raw data from Google Places API... categories=[${filterCategories.join(', ')}]`);
  do {
    const page = await fetchPage({ latitude, longitude, radius, pageToken: nextPageToken });
    allRawResults = allRawResults.concat(page.results);
    nextPageToken = page.next_page_token ?? "";
    if (nextPageToken) await new Promise(r => setTimeout(r, 2100));
  } while (nextPageToken);
  if (!quiet) log(`📊 Fetched ${allRawResults.length} raw results from Google Places API`);
  if (useAI && !openai && !quiet) logWarn("⚠️ AI classification requested but OpenAI API key not found. Using rule-based classification.");
  const processedResults = await processPlaces(allRawResults, filterCategories, useAI, { quiet });
  const stats = processedResults._stats;
  if (!quiet) log(`📈 SUMMARY: ${stats.totalRaw} raw → ${stats.final} final (${stats.preFilterExcluded} pre-filtered, ${stats.validationExcluded} validation failed, ${stats.categoryFilterExcluded} category filtered)`);
  return processedResults;
}

function getCategoryEmoji(category) {
  const emojis = { park: '🏞️', restaurant: '🍽️', attraction: '🎯', cafe: '☕', bar: '🍺', shopping: '🛒', library: '📚', beach: '🏖️', gym: '💪', venue: '🏟️', entertainment: '🎬', health: '🏥', misc: '📍' };
  return emojis[category] || '📍';
}

function displayResults(pois, showDetails = false) {
  if (pois.length === 0) {
    log("🚫 No validated POIs found matching the criteria");
    return;
  }
  const grouped = pois.reduce((acc, poi) => { if (!acc[poi.category]) acc[poi.category] = []; acc[poi.category].push(poi); return acc; }, {});
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

async function processPlaces(rawPlaces, filterCategories = [], useAI = false, options = {}) {
  const quiet = options.quiet || false;
  if (!quiet) log(`📊 Processing ${rawPlaces.length} raw places...`);
  if (!quiet) log(`🔍 STEP 1: Pre-filtering globally ineligible entries...`);
  const preFiltered = rawPlaces.filter(place => {
    if (isGloballyIneligible(place)) {
      if (!quiet) {
        const reason = explainGlobalIneligible(place);
        log(`🚫 PRE-FILTER: excluded "${place.name}" – ${reason}`);
      }
      return false;
    }
    return true;
  });
  if (!quiet) log(`✅ Pre-filter: ${rawPlaces.length} → ${preFiltered.length} (excluded ${rawPlaces.length - preFiltered.length})`);
  if (!quiet) log(`🔍 STEP 2: Applying rule-based classification...`);
  const classified = preFiltered.map(place => ({
    name: place.name,
    description: place.vicinity ?? "",
    latitude: place.geometry.location.lat,
    longitude: place.geometry.location.lng,
    category: getBestCategory(place),
    types: place.types || [],
    rating: place.rating || null,
    priceLevel: place.price_level || null,
    _original: place
  }));
  if (!quiet) classified.forEach(p => log(`📊 CLASSIFY: "${p.name}" → ${p.category} (rule-based)`));
  if (!quiet) log(`🔍 STEP 3: Validating category assignments...`);
  const validated = classified.filter(place => {
    const isValid = validatePlace(place._original, place.category);
    if (!isValid) {
      if (!quiet) {
        const reason = explainValidationFailure(place._original, place.category);
        log(`🚫 VALIDATE: excluded "${place.name}" [${place.category}] – ${reason}`);
      }
      return false;
    }
    return true;
  });
  if (!quiet) log(`✅ Validation: ${classified.length} → ${validated.length} (excluded ${classified.length - validated.length})`);
  let categoryFiltered = validated;
  if (filterCategories.length > 0) {
    if (!quiet) log(`🔍 STEP 4: Applying category filter [${filterCategories.join(', ')}]...`);
    categoryFiltered = validated.filter(place => {
      const keep = filterCategories.includes(place.category);
      if (!keep && !quiet) log(`🚫 CATEGORY: excluded "${place.name}" – category filter (category=${place.category}, allowed=${filterCategories.join(', ')})`);
      return keep;
    });
    if (!quiet) log(`✅ Category filter: ${validated.length} → ${categoryFiltered.length} (excluded ${validated.length - categoryFiltered.length})`);
  }
  let aiEnhanced = categoryFiltered;
  if (useAI && openai && categoryFiltered.length > 0) {
    if (!quiet) log(`🔍 STEP 5: Applying AI classification to ${categoryFiltered.length} category-filtered entries...`);
    const aiClassifications = await batchClassifyWithAI(categoryFiltered.map(p => p._original));
    aiEnhanced = categoryFiltered.map(place => {
      const placeId = place._original.place_id || place.name;
      const aiResult = aiClassifications[placeId];
      if (aiResult && aiResult.isValid) {
        const aiCategory = aiResult.category;
        const aiValid = validatePlace(place._original, aiCategory);
        const allowed = filterCategories.length === 0 || filterCategories.includes(aiCategory);
        if (aiValid && allowed) {
          if (!quiet) log(`🤖 AI-CLASSIFY: "${place.name}" → ${aiCategory} (confidence: ${(aiResult.confidence * 100).toFixed(0)}%)`);
          return { ...place, category: aiCategory, confidence: aiResult.confidence, reasoning: aiResult.reasoning, classificationMethod: 'AI', isValidated: true };
        } else if (!allowed && !quiet) {
          log(`⚠️  AI-CLASSIFY: "${place.name}" AI suggested ${aiCategory} but not in allowed categories, keeping ${place.category}`);
        } else if (!quiet) {
          log(`⚠️  AI-CLASSIFY: "${place.name}" AI suggested ${aiCategory} but failed validation, keeping ${place.category}`);
        }
      }
      return { ...place, confidence: 0.8, reasoning: "Rule-based classification", classificationMethod: 'Rules', isValidated: true };
    });
  } else {
    aiEnhanced = categoryFiltered.map(place => ({ ...place, confidence: 0.8, reasoning: "Rule-based classification", classificationMethod: 'Rules', isValidated: true }));
  }
  const filtered = aiEnhanced;
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
  metersToLatDelta(meters) { return meters / 111320; }
  metersToLonDelta(meters, lat) { const latRad = (lat * Math.PI) / 180; return meters / (111320 * Math.cos(latRad)); }
  next() {
    if (this.stepIndex === 0) { this.stepIndex++; return { lat: this.currentLat, lon: this.currentLon, step: 0 }; }
    const latDelta = this.metersToLatDelta(this.stepMeters);
    const lonDelta = this.metersToLonDelta(this.stepMeters, this.currentLat);
    if (this.direction === 0) this.currentLon += lonDelta; // E
    else if (this.direction === 1) this.currentLat += latDelta; // N
    else if (this.direction === 2) this.currentLon -= lonDelta; // W
    else if (this.direction === 3) this.currentLat -= latDelta; // S
    this.stepsTakenInCurrentLeg++;
    if (this.stepsTakenInCurrentLeg >= this.stepsInCurrentLeg) {
      this.stepsTakenInCurrentLeg = 0;
      this.direction = (this.direction + 1) % 4;
      this.legsCompleted++;
      if (this.legsCompleted % 2 === 0) this.stepsInCurrentLeg++;
    }
    this.stepIndex++;
    return { lat: this.currentLat, lon: this.currentLon, step: this.stepIndex };
  }
}

function getPOIKey(poi) {
  if (poi._original && poi._original.place_id) return `pid:${poi._original.place_id}`;
  const latRounded = poi.latitude.toFixed(5);
  const lonRounded = poi.longitude.toFixed(5);
  return `name:${poi.name}|${latRounded},${lonRounded}`;
}

async function collectPOIsUntilTarget(startLat, startLon, radius, target, step, maxSteps, filterCategories, useAI) {
  log(`🎯 Target mode: collecting ${target} unique POIs...`);
  log(`📍 Starting at: ${startLat.toFixed(6)}, ${startLon.toFixed(6)}`);
  log(`🔄 Search radius: ${radius}m, step: ${step}m, max steps: ${maxSteps}`);
  const uniquePOIs = new Map();
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
        if (!uniquePOIs.has(key)) { uniquePOIs.set(key, poi); newCount++; }
      }
      log(`✅ Step ${stepCount}: +${newCount} new, ${uniquePOIs.size}/${target} total unique POIs`);
      if (uniquePOIs.size >= target) {
        log(`🎉 Target reached! Collected ${uniquePOIs.size} unique POIs in ${stepCount} steps.`);
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    } catch (error) {
      logError(`❌ Step ${stepCount} failed: ${error.message}`);
    }
  }
  if (uniquePOIs.size < target) log(`⚠️  Stopped after ${stepCount} steps with ${uniquePOIs.size}/${target} POIs (maxSteps reached)`);
  return Array.from(uniquePOIs.values());
}

/* ─────────────────────────────────────────────
   Ingestion (from ingest_pois.mjs)
───────────────────────────────────────────── */
function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
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
  return { name, description, latitude, longitude, category, is_active: true };
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
  try { json = JSON.parse(raw); } catch (e) { throw new Error(`Failed to parse JSON at ${absolutePath}: ${e.message}`); }
  let items = [];
  if (Array.isArray(json)) items = json;
  else if (json && typeof json === "object") {
    if (Array.isArray(json.results)) items = json.results;
    else if (Array.isArray(json.data)) items = json.data;
    else items = Object.values(json).flatMap(v => (Array.isArray(v) ? v : []));
  }
  if (!Array.isArray(items) || items.length === 0) throw new Error("Input JSON does not contain an array of POIs");
  const mapped = items.map(mapToPayload);
  const valid = mapped.filter(isValidPayload);
  const skipped = mapped.length - valid.length;
  console.log(`📦 Loaded ${items.length} items → ${valid.length} valid payloads (${skipped} skipped)`);
  return valid;
}

async function postBatch(baseUrl, adminToken, batch) {
  const url = `${baseUrl.replace(/\/$/, "")}/api/admin/pois/bulk`;
  const headers = { "Content-Type": "application/json", "x-admin-token": adminToken };
  const { data } = await axios.post(url, batch, { headers, timeout: 30000 });
  return data;
}

/* ─────────────────────────────────────────────
   Streaming Ingestion
───────────────────────────────────────────── */
class StreamingIngester {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || process.env.BASE_URL || "http://localhost:3000";
    this.adminToken = options.adminToken || process.env.ADMIN_TOKEN;
    this.batchSize = options.batchSize || 100;
    this.dryRun = options.dryRun || false;
    
    this.buffer = [];
    this.seenPlaceIds = new Set();
    this.totalIngested = 0;
    this.totalSkipped = 0;
    this.batchesCompleted = 0;
    this.pendingIngestion = null;
  }

  addPOI(poi) {
    const key = getPOIKey(poi);
    if (this.seenPlaceIds.has(key)) return false;
    
    this.seenPlaceIds.add(key);
    const payload = mapToPayload(poi);
    
    if (!isValidPayload(payload)) return false;
    
    this.buffer.push(payload);
    return true;
  }

  addPOIs(pois) {
    let added = 0;
    for (const poi of pois) {
      if (this.addPOI(poi)) added++;
    }
    return added;
  }

  shouldFlush() {
    return this.buffer.length >= this.batchSize;
  }

  async flush() {
    if (this.buffer.length === 0) return { created: 0, skipped: 0 };
    
    const batch = this.buffer.splice(0, this.batchSize);
    
    if (this.dryRun) {
      log(`🧪 Dry-run: would ingest ${batch.length} POIs`);
      return { created: batch.length, skipped: 0 };
    }

    if (!this.adminToken) {
      logWarn("⚠️ No ADMIN_TOKEN - skipping ingestion");
      return { created: 0, skipped: batch.length };
    }

    try {
      const res = await postBatch(this.baseUrl, this.adminToken, batch);
      const created = Number(res?.createdCount || 0);
      const skipped = Number(res?.skippedCount || 0);
      this.totalIngested += created;
      this.totalSkipped += skipped;
      this.batchesCompleted++;
      return { created, skipped };
    } catch (err) {
      logError(`❌ Batch ingestion failed: ${err.message}`);
      // Put items back in buffer for retry
      this.buffer.unshift(...batch);
      return { created: 0, skipped: 0, error: err.message };
    }
  }

  async flushIfReady() {
    if (!this.shouldFlush()) return null;
    
    // Wait for any pending ingestion to complete first
    if (this.pendingIngestion) {
      await this.pendingIngestion;
    }
    
    // Start new ingestion (non-blocking)
    this.pendingIngestion = this.flush().then(result => {
      this.pendingIngestion = null;
      return result;
    });
    
    return this.pendingIngestion;
  }

  async flushAll() {
    // Wait for pending ingestion
    if (this.pendingIngestion) {
      await this.pendingIngestion;
    }
    
    // Flush remaining buffer
    const results = [];
    while (this.buffer.length > 0) {
      const result = await this.flush();
      results.push(result);
    }
    return results;
  }

  getStats() {
    return {
      uniquePOIs: this.seenPlaceIds.size,
      buffered: this.buffer.length,
      ingested: this.totalIngested,
      skipped: this.totalSkipped,
      batches: this.batchesCompleted
    };
  }
}

/* ─────────────────────────────────────────────
   Unified CLI Parsing
───────────────────────────────────────────── */
function parseFetchFlags(argv) {
  const args = normalizeArgs(argv);
  let lat = null, lon = null, radius = DEFAULT_RADIUS, showDetails = false, filterCategories = [], showJson = false, useAI = false, target = null, step = null, maxSteps = 200, outFile = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lat' && i + 1 < args.length) { lat = parseFloat(args[++i]); }
    else if (args[i] === '--lon' && i + 1 < args.length) { lon = parseFloat(args[++i]); }
    else if (args[i] === '--radius' && i + 1 < args.length) { radius = parseInt(args[++i]); }
    else if (args[i] === '--details' || args[i] === '-d') { showDetails = true; }
    else if (args[i] === '--categories' && i + 1 < args.length) { filterCategories = args[++i].split(',').map(c => c.trim()); }
    else if (args[i] === '--json') { showJson = true; }
    else if (args[i] === '--ai') { useAI = true; }
    else if (args[i] === '--target' && i + 1 < args.length) { target = parseInt(args[++i]); }
    else if (args[i] === '--step' && i + 1 < args.length) { step = parseInt(args[++i]); }
    else if (args[i] === '--maxSteps' && i + 1 < args.length) { maxSteps = parseInt(args[++i]); }
    else if (args[i] === '--out' && i + 1 < args.length) { outFile = args[++i]; }
  }
  if ((lat !== null && lon === null) || (lat === null && lon !== null)) throw new Error("Both --lat and --lon must be provided together");
  if (lat !== null && (lat < -90 || lat > 90)) throw new Error("Latitude must be between -90 and 90");
  if (lon !== null && (lon < -180 || lon > 180)) throw new Error("Longitude must be between -180 and 180");
  if (radius < 1 || radius > 50000) throw new Error("Radius must be between 1 and 50000 meters");
  if (target !== null && target < 1) throw new Error("Target must be at least 1");
  if (step !== null && (step < 1 || step > 50000)) throw new Error("Step must be between 1 and 50000 meters");
  if (maxSteps < 1) throw new Error("maxSteps must be at least 1");
  if (step === null) step = Math.floor(radius * 0.8);
  return { latitude: lat, longitude: lon, radius, showDetails, filterCategories, showJson, useAI, target, step, maxSteps, outFile };
}

function parseIngestFlags(argv) {
  const args = normalizeArgs(argv);
  let filePath = "tmp1.json";
  let baseUrl = process.env.BASE_URL || "http://localhost:3000";
  let batchSize = 100;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && i + 1 < args.length) { filePath = args[++i]; }
    else if (args[i] === '--baseUrl' && i + 1 < args.length) { baseUrl = args[++i]; }
    else if (args[i] === '--batch' && i + 1 < args.length) { batchSize = Math.max(1, parseInt(args[++i])); }
    else if (args[i] === '--dry-run') { dryRun = true; }
  }
  return { filePath, baseUrl, batchSize, dryRun };
}

function parseAutoFlags(argv) {
  const args = normalizeArgs(argv);
  // Split flags between fetch and ingest groups; support delete-file/no-ingest
  const fetchArgs = [];
  let baseUrl = process.env.BASE_URL || "http://localhost:3000";
  let batchSize = 100;
  let dryRun = false;
  let deleteFile = false;
  let noIngest = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--baseUrl' && i + 1 < args.length) { baseUrl = args[++i]; }
    else if (a === '--batch' && i + 1 < args.length) { batchSize = parseInt(args[++i]); }
    else if (a === '--dry-run') { dryRun = true; }
    else if (a === '--delete-file') { deleteFile = true; }
    else if (a === '--no-ingest') { noIngest = true; }
    else {
      fetchArgs.push(a);
      if (a.startsWith('--') && i + 1 < args.length && !args[i + 1].startsWith('--')) { fetchArgs.push(args[++i]); }
    }
  }
  return { fetchArgs, baseUrl, batchSize, dryRun, deleteFile, noIngest };
}

function parseSeedFlags(argv) {
  const args = normalizeArgs(argv);
  let locale = null;
  let radius = 400;
  let categories = [];
  let useAI = false;
  let batchSize = 100;
  let dryRun = false;
  let maxPoints = 200;
  let target = null;
  let baseUrl = process.env.BASE_URL || "http://localhost:3000";
  let outFile = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--locale' && i + 1 < args.length) { locale = args[++i]; }
    else if (a === '--radius' && i + 1 < args.length) { radius = parseInt(args[++i]); }
    else if (a === '--categories' && i + 1 < args.length) { categories = args[++i].split(',').map(c => c.trim()); }
    else if (a === '--ai') { useAI = true; }
    else if (a === '--batch' && i + 1 < args.length) { batchSize = parseInt(args[++i]); }
    else if (a === '--dry-run') { dryRun = true; }
    else if (a === '--max-points' && i + 1 < args.length) { maxPoints = parseInt(args[++i]); }
    else if (a === '--target' && i + 1 < args.length) { target = parseInt(args[++i]); }
    else if (a === '--baseUrl' && i + 1 < args.length) { baseUrl = args[++i]; }
    else if (a === '--out' && i + 1 < args.length) { outFile = args[++i]; }
  }

  if (!locale) throw new Error("--locale is required for seed command");
  if (radius < 1 || radius > 50000) throw new Error("Radius must be between 1 and 50000 meters");
  if (maxPoints < 1 || maxPoints > 1000) throw new Error("max-points must be between 1 and 1000");
  if (target !== null && target < 1) throw new Error("target must be at least 1");
  if (batchSize < 1) throw new Error("batch size must be at least 1");

  return { locale, radius, categories, useAI, batchSize, dryRun, maxPoints, target, baseUrl, outFile };
}

/* ─────────────────────────────────────────────
   Mode Runners
───────────────────────────────────────────── */
async function runFetchCli(argv) {
  let JSON_MODE = false;
  try {
    const args = parseFetchFlags(argv);
    if (args.showJson && !args.outFile) {
      JSON_MODE = true;
      console.log = (...a) => { try { process.stderr.write(a.join(' ') + "\n"); } catch (_) {} };
      console.warn = (...a) => { try { process.stderr.write(a.join(' ') + "\n"); } catch (_) {} };
      console.error = (...a) => { try { process.stderr.write(a.join(' ') + "\n"); } catch (_) {} };
    }
    let location;
    if (args.latitude !== null && args.longitude !== null) {
      log("📍 Using coordinates from command line:");
      log(`📐 Coordinates: ${args.latitude}, ${args.longitude}`);
      location = { latitude: args.latitude, longitude: args.longitude, city: "Custom Location", region: "", country: "", fullAddress: `${args.latitude}, ${args.longitude}` };
    } else {
      const loc = await getCurrentLocation();
      if (!loc.success) {
        logError("🚨 CRITICAL ERROR: Unable to determine your location!");
        logError("⚠️  PROCEEDING WITH FALLBACK: Using NYC coordinates (40.727233, -73.984592)");
        location = { latitude: 40.727233, longitude: -73.984592, city: "New York", region: "NY", country: "United States", postal: "10003", fullAddress: "New York, NY, 10003, United States (FALLBACK)" };
      } else {
        location = loc;
      }
    }
    let pois;
    if (args.target !== null) {
      pois = await collectPOIsUntilTarget(location.latitude, location.longitude, args.radius, args.target, args.step, args.maxSteps, args.filterCategories, args.useAI);
    } else {
      log(`🔍 Searching for POIs within ${args.radius}m...`);
      if (args.filterCategories.length > 0) log(`🎯 Filtering for categories: ${args.filterCategories.join(', ')}`);
      pois = await fetchNearbyPOIs(location.latitude, location.longitude, args.radius, args.filterCategories, args.useAI);
    }
    const locationString = location.fullAddress || (location.city && location.region ? `${location.city}, ${location.region}` : `${location.latitude}, ${location.longitude}`);
    const cleanPois = pois.map(poi => { const { _original, ...clean } = poi; return clean; });
    if (args.showJson) {
      if (args.outFile) {
        await fs.writeFile(args.outFile, JSON.stringify(cleanPois, null, 2), 'utf8');
        log(`\n📝 Wrote ${cleanPois.length} POIs to ${args.outFile}`);
      } else {
        process.stdout.write(JSON.stringify(cleanPois, null, 2));
      }
    } else {
      displayResults(cleanPois, args.showDetails);
      log(`\n🎯 SUMMARY: Found ${cleanPois.length} validated POIs near ${locationString}`);
      if (!args.showDetails) log(`💡 Use --details flag for more information about each place`);
      log(`💡 Use --json flag for JSON output`);
      log(`💡 Use --out <file> to write JSON to file`);
      log(`💡 Use --target <n> to collect a specific number of POIs`);
      log(`💡 Use --categories park,restaurant,cafe to filter specific types`);
      log(`💡 Use --ai flag for AI-powered classification (requires OpenAI API key)`);
    }
    return 0;
  } catch (error) {
    if (JSON_MODE) {
      try {
        const empty = JSON.stringify([], null, 2);
        process.stdout.write(empty);
      } catch (_e) {}
    } else {
      logError("❌ Error:", error.message);
    }
    return 1;
  }
}

async function runIngestCli(argv) {
  const { filePath, baseUrl, batchSize, dryRun } = parseIngestFlags(argv);
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    console.error("❌ ADMIN_TOKEN env var is required");
    return 1;
  }
  console.log(`🔗 Target: ${baseUrl}  |  File: ${filePath}  |  Batch: ${batchSize}${dryRun ? "  |  DRY-RUN" : ""}`);
  console.log(`🔑 Admin token: ${adminToken.substring(0, 8)}...${adminToken.substring(adminToken.length - 4)} (${adminToken.length} chars)`);
  try {
    const payloads = await readPois(filePath);
    const batches = chunkArray(payloads, batchSize);
    let totalCreated = 0; let totalSkipped = 0; let totalBatches = 0;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`🚀 Posting batch ${i + 1}/${batches.length} (${batch.length} items)...`);
      if (dryRun) { console.log("   🧪 Dry-run: skipping POST"); totalBatches++; continue; }
      try {
        const res = await postBatch(baseUrl, adminToken, batch);
        const created = Number(res?.createdCount || 0);
        const skipped = Number(res?.skippedCount || 0);
        totalCreated += created; totalSkipped += skipped; totalBatches++;
        console.log(`   ✅ created=${created}, skipped=${skipped}`);
      } catch (err) {
        console.error(`   ❌ Batch ${i + 1} failed: ${err.message}`);
        await new Promise(r => setTimeout(r, 1000));
      }
      await new Promise(r => setTimeout(r, 200));
    }
    console.log(`\n🎯 Done. Batches: ${totalBatches}, Created: ${totalCreated}, Skipped: ${totalSkipped}`);
    return 0;
  } catch (e) {
    console.error(`❌ Ingest failed: ${e.message}`);
    return 1;
  }
}

async function runAutoCli(argv) {
  const { fetchArgs, baseUrl, batchSize, dryRun, deleteFile, noIngest } = parseAutoFlags(argv);
  const filename = `auto-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5)}.json`;
  const outputPath = path.join(process.cwd(), filename);
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║         AUTO-FETCH AND INGEST POI WORKFLOW                    ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log(`📁 Output file: ${filename}`);
  console.log(`🔗 Target API: ${baseUrl}`);
  if (noIngest) console.log(`⚠️  Ingestion disabled (--no-ingest)`);
  console.log("");
  // 1) Run fetch in JSON mode to file (in-process)
  const fetchExit = await runFetchCli([...fetchArgs, '--json', '--out', filename]);
  if (fetchExit !== 0) return fetchExit;
  // Ensure file exists
  try { await fs.access(outputPath); } catch { throw new Error(`Failed to create output file: ${filename}`); }
  const stats = await fs.stat(outputPath);
  const content = await fs.readFile(outputPath, "utf8");
  const pois = JSON.parse(content);
  console.log(`\n✅ Successfully fetched ${pois.length} POIs (${(stats.size / 1024).toFixed(1)} KB)`);
  if (pois.length === 0) {
    console.log("⚠️  No POIs to ingest, exiting.");
    if (deleteFile) { await fs.unlink(outputPath); console.log(`🗑️  Deleted empty file: ${filename}`); } else { console.log(`📁 Keeping file: ${filename}`); }
    return 0;
  }
  if (!noIngest) {
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📤 STEP 2: Ingesting POIs to server");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    const ingestExit = await runIngestCli(["--file", filename, "--baseUrl", baseUrl, "--batch", String(batchSize), ...(dryRun ? ["--dry-run"] : [])]);
    if (ingestExit !== 0) return ingestExit;
    console.log("\n✅ Ingestion complete!");
  }
  if (deleteFile && !noIngest) { console.log(`\n🗑️  Cleaning up: deleting ${filename}...`); await fs.unlink(outputPath); console.log("✅ Cleanup complete"); } else { console.log(`\n📁 Keeping file: ${filename}`); }
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                    ✨ WORKFLOW COMPLETE ✨                     ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  return 0;
}

async function runSeedCli(argv) {
  try {
    const { locale, radius, categories, useAI, batchSize, dryRun, maxPoints, target, baseUrl, outFile } = parseSeedFlags(argv);
    
    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║              LOCALE-BASED POI SEEDING                          ║");
    console.log("╚════════════════════════════════════════════════════════════════╝");
    console.log("");
    console.log("📋 CONFIGURATION");
    console.log("─".repeat(60));
    console.log(`  --locale       ${locale}`);
    console.log(`  --radius       ${radius}m`);
    console.log(`  --max-points   ${maxPoints}`);
    console.log(`  --target       ${target !== null ? target + ' POIs' : '(unlimited)'}`);
    console.log(`  --categories   ${categories.length > 0 ? categories.join(', ') : '(all)'}`);
    console.log(`  --ai           ${useAI ? 'enabled' : 'disabled'}`);
    console.log(`  --batch        ${batchSize}`);
    console.log(`  --baseUrl      ${baseUrl}`);
    console.log(`  --dry-run      ${dryRun ? 'YES' : 'no'}`);
    console.log(`  --out          ${outFile || '(none)'}`);
    console.log("");

    // Step 1: Geocode the locale
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📍 STEP 1: Geocoding locale");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    const geo = await geocodeLocale(locale);
    console.log(`✅ Found: ${geo.formattedAddress}`);
    console.log(`📐 Center: ${geo.center.lat.toFixed(6)}, ${geo.center.lon.toFixed(6)}`);
    
    if (!geo.bounds) {
      throw new Error("Geocoding did not return viewport bounds - cannot determine area coverage");
    }
    
    console.log(`🗺️  Bounds: SW(${geo.bounds.southwest.lat.toFixed(4)}, ${geo.bounds.southwest.lon.toFixed(4)}) → NE(${geo.bounds.northeast.lat.toFixed(4)}, ${geo.bounds.northeast.lon.toFixed(4)})`);
    console.log("");

    // Step 2: Generate grid points
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📍 STEP 2: Generating smart grid");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    const sampler = new GridSampler(geo.bounds, {
      centerDensity: radius,
      edgeDensity: radius * 2,
      maxPoints
    });
    const gridPoints = sampler.generatePoints();
    console.log(`✅ Generated ${gridPoints.length} query points (higher density in center)`);
    console.log("");

    // Step 3: Initialize streaming ingester
    const ingester = new StreamingIngester({
      baseUrl,
      batchSize,
      dryRun
    });

    // Step 4: Query each grid point and stream ingest
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📍 STEP 3: Fetching POIs from grid (streaming)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("");

    const allPOIs = [];
    
    for (let i = 0; i < gridPoints.length; i++) {
      const point = gridPoints[i];
      const progress = Math.floor(((i + 1) / gridPoints.length) * 100);

      // Check if we've reached target
      if (target !== null && allPOIs.length >= target) {
        console.log(`\n🎉 Target reached! Collected ${allPOIs.length} unique POIs after ${i} grid points.`);
        console.log(`⏭️  Skipping remaining ${gridPoints.length - i} grid points.`);
        break;
      }

      try {
        // Fetch with quiet mode to suppress verbose classification logging
        const pois = await fetchNearbyPOIs(point.lat, point.lon, radius, categories, useAI, { quiet: true });
        
        // Count new POIs added
        let newCount = 0;
        for (const poi of pois) {
          const key = getPOIKey(poi);
          if (!allPOIs.some(p => getPOIKey(p) === key)) {
            allPOIs.push(poi);
            newCount++;
          }
        }
        
        // Add to ingester buffer (deduplicates automatically)
        ingester.addPOIs(pois);
        
        // Brief log per grid point with target progress if set
        const stats = pois._stats || {};
        const targetInfo = target !== null ? `, ${allPOIs.length}/${target} target` : '';
        console.log(`[${progress.toString().padStart(3)}%] Point ${(i + 1).toString().padStart(3)}/${gridPoints.length} @ (${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}) → ${stats.totalRaw || 0} raw, ${pois.length} valid, +${newCount} new (total: ${allPOIs.length}${targetInfo})`);
        
        // Stream ingest if buffer is ready
        const flushResult = await ingester.flushIfReady();
        if (flushResult && (flushResult.created > 0 || dryRun)) {
          console.log(`     📤 Batch ${ingester.batchesCompleted}: ${dryRun ? 'would ingest' : 'ingested'} ${flushResult.created} POIs`);
        }

        // Small delay between queries to avoid rate limiting
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        console.log(`[${progress.toString().padStart(3)}%] Point ${(i + 1).toString().padStart(3)}/${gridPoints.length} ⚠️  ${err.message}`);
      }
    }
    console.log("");

    // Step 5: Flush remaining buffer
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📍 STEP 4: Finalizing");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    await ingester.flushAll();
    console.log(`✅ Flushed remaining ${ingester.buffer.length === 0 ? 'buffer' : ingester.buffer.length + ' items'}`);
    console.log("");

    // Step 6: Validated POIs breakdown by category
    const stats = ingester.getStats();
    const cleanPois = allPOIs.map(poi => {
      const { _original, ...clean } = poi;
      return clean;
    });
    
    // Group by category
    const byCategory = cleanPois.reduce((acc, poi) => {
      if (!acc[poi.category]) acc[poi.category] = [];
      acc[poi.category].push(poi);
      return acc;
    }, {});
    
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("✅ VALIDATED POIs BY CATEGORY");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    
    const sortedCategories = Object.keys(byCategory).sort((a, b) => byCategory[b].length - byCategory[a].length);
    for (const category of sortedCategories) {
      const places = byCategory[category];
      const emoji = getCategoryEmoji(category);
      console.log(`\n${emoji} ${category.toUpperCase()} (${places.length})`);
      console.log("─".repeat(50));
      // Show first 5 places per category
      const shown = places.slice(0, 5);
      for (const place of shown) {
        console.log(`   • ${place.name}`);
        if (place.description) console.log(`     ${place.description}`);
      }
      if (places.length > 5) {
        console.log(`   ... and ${places.length - 5} more`);
      }
    }

    // Step 7: Summary
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📊 SEEDING SUMMARY");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`🌍 Location: ${geo.formattedAddress}`);
    console.log(`📍 Grid points queried: ${gridPoints.length}`);
    console.log(`🔍 Unique POIs found: ${cleanPois.length}`);
    console.log(`📤 Batches completed: ${stats.batches}`);
    console.log(`✅ POIs ingested: ${stats.ingested}`);
    console.log(`⏭️  POIs skipped: ${stats.skipped}`);

    // Step 8: Write to file if requested
    if (outFile) {
      await fs.writeFile(outFile, JSON.stringify(cleanPois, null, 2), 'utf8');
      console.log(`📝 Wrote ${cleanPois.length} POIs to ${outFile}`);
    }

    console.log("\n╔════════════════════════════════════════════════════════════════╗");
    console.log("║                    ✨ SEEDING COMPLETE ✨                       ║");
    console.log("╚════════════════════════════════════════════════════════════════╝");

    return 0;
  } catch (error) {
    logError(`❌ Seed failed: ${error.message}`);
    return 1;
  }
}

/* ─────────────────────────────────────────────
   Entrypoint
───────────────────────────────────────────── */
async function main() {
  const argv = process.argv.slice(2);
  const args = normalizeArgs(argv);
  const first = args[0];
  let exitCode = 0;
  if (first === 'fetch') {
    exitCode = await runFetchCli(args.slice(1));
  } else if (first === 'ingest') {
    exitCode = await runIngestCli(args.slice(1));
  } else if (first === 'auto') {
    exitCode = await runAutoCli(args.slice(1));
  } else if (first === 'seed') {
    exitCode = await runSeedCli(args.slice(1));
  } else {
    // Compatibility: if flags look like ingest, run ingest; else run auto
    const looksIngest = args.includes('--file') || args.includes('--baseUrl');
    if (looksIngest) exitCode = await runIngestCli(args);
    else exitCode = await runAutoCli(args);
  }
  process.exit(exitCode);
}

main();





