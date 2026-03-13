import dotenv from 'dotenv';
import cors from 'cors';
import express from 'express';
import axios from 'axios';
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');
const dataDir = process.env.DATA_DIR?.trim()
  ? path.resolve(process.env.DATA_DIR.trim())
  : path.join(__dirname, 'data');
const settingsFilePath = path.join(dataDir, 'settings.json');

const app = express();
app.disable('x-powered-by');
const parsedPort = Number(process.env.PORT);
const PORT = Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : 59039;
const APP_VERSION = process.env.npm_package_version || '1.0.0';
const DRAND_LATEST_URL =
  'https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/latest';
const MAX_VISUAL_WHEEL_ITEMS = 25;
const SESSION_COOKIE_NAME = 'randomisarr_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const WATCH_PROVIDER_PRIORITY = ['emby', 'jellyfin', 'plex'];
const WATCH_MODES = new Set(['everything', 'unwatched']);
const WATCH_SOURCES = new Set(['auto', 'none', 'emby', 'jellyfin', 'plex']);
const FRANCHISE_MODES = new Set(['off', 'earliest_unwatched_in_collection']);
const TMDB_API_BASE_URL = 'https://api.themoviedb.org/3';
const CORS_ORIGIN = process.env.CORS_ORIGIN?.trim() ?? '';
const TRUST_PROXY = readBooleanEnv('TRUST_PROXY');
const USE_SECURE_COOKIES =
  process.env.COOKIE_SECURE === undefined
    ? process.env.NODE_ENV === 'production'
    : readBooleanEnv('COOKIE_SECURE');

const sessions = new Map();
const tmdbMovieCache = new Map();
const tmdbCollectionCache = new Map();
let settings = createEmptySettings();

if (TRUST_PROXY) {
  app.set('trust proxy', 1);
}

function createEmptySettings() {
  return {
    auth: {
      username: '',
      passwordHash: '',
      passwordSalt: ''
    },
    radarr: {
      url: '',
      apiKey: ''
    },
    sonarr: {
      url: '',
      apiKey: ''
    },
    providers: {
      emby: {
        url: '',
        apiKey: '',
        userId: ''
      },
      jellyfin: {
        url: '',
        apiKey: '',
        userId: ''
      },
      plex: {
        url: '',
        token: ''
      }
    },
    tmdb: {
      accessToken: ''
    },
    preferences: {
      selectionCount: null,
      watchMode: 'everything',
      watchSource: 'auto',
      franchiseMode: 'off'
    }
  };
}

function readBooleanEnv(name) {
  const rawValue = process.env[name];

  if (rawValue === undefined) {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(rawValue).trim().toLowerCase());
}

function normalizeOptionalNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function normalizeSettingsShape(rawSettings = {}) {
  return {
    auth: {
      username: rawSettings.auth?.username ?? '',
      passwordHash: rawSettings.auth?.passwordHash ?? '',
      passwordSalt: rawSettings.auth?.passwordSalt ?? ''
    },
    radarr: {
      url: rawSettings.radarr?.url ?? '',
      apiKey: rawSettings.radarr?.apiKey ?? ''
    },
    sonarr: {
      url: rawSettings.sonarr?.url ?? '',
      apiKey: rawSettings.sonarr?.apiKey ?? ''
    },
    providers: {
      emby: {
        url: rawSettings.providers?.emby?.url ?? '',
        apiKey: rawSettings.providers?.emby?.apiKey ?? '',
        userId: rawSettings.providers?.emby?.userId ?? ''
      },
      jellyfin: {
        url: rawSettings.providers?.jellyfin?.url ?? '',
        apiKey: rawSettings.providers?.jellyfin?.apiKey ?? '',
        userId: rawSettings.providers?.jellyfin?.userId ?? ''
      },
      plex: {
        url: rawSettings.providers?.plex?.url ?? '',
        token: rawSettings.providers?.plex?.token ?? ''
      }
    },
    tmdb: {
      accessToken: rawSettings.tmdb?.accessToken ?? ''
    },
    preferences: {
      selectionCount: normalizeOptionalNumber(rawSettings.preferences?.selectionCount),
      watchMode: WATCH_MODES.has(rawSettings.preferences?.watchMode)
        ? rawSettings.preferences.watchMode
        : 'everything',
      watchSource: WATCH_SOURCES.has(rawSettings.preferences?.watchSource)
        ? rawSettings.preferences.watchSource
        : 'auto',
      franchiseMode: FRANCHISE_MODES.has(rawSettings.preferences?.franchiseMode)
        ? rawSettings.preferences.franchiseMode
        : 'off'
    }
  };
}

async function loadSettings() {
  try {
    const fileContents = await fs.readFile(settingsFilePath, 'utf8');
    settings = normalizeSettingsShape(JSON.parse(fileContents));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    settings = createEmptySettings();
  }
}

async function saveSettings() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(settingsFilePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function normalizeBaseUrl(url) {
  return url?.trim().replace(/\/+$/, '') ?? '';
}

function parseCookies(cookieHeader = '') {
  return cookieHeader.split(';').reduce((cookies, item) => {
    const [key, ...valueParts] = item.trim().split('=');

    if (!key) {
      return cookies;
    }

    cookies[key] = decodeURIComponent(valueParts.join('='));
    return cookies;
  }, {});
}

function setSessionCookie(res, token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const cookieAttributes = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
    'Priority=High'
  ];

  if (USE_SECURE_COOKIES) {
    cookieAttributes.push('Secure');
  }

  res.setHeader('Set-Cookie', cookieAttributes.join('; '));
}

function clearSessionCookie(res) {
  const cookieAttributes = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    'Max-Age=0',
    'Priority=High'
  ];

  if (USE_SECURE_COOKIES) {
    cookieAttributes.push('Secure');
  }

  res.setHeader('Set-Cookie', cookieAttributes.join('; '));
}

function purgeExpiredSessions() {
  const now = Date.now();

  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

function getSessionFromRequest(req) {
  purgeExpiredSessions();

  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE_NAME];

  if (!token) {
    return null;
  }

  const session = sessions.get(token);

  if (!session) {
    return null;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { token, ...session };
}

function isAuthConfigured() {
  return Boolean(settings.auth.username && settings.auth.passwordHash && settings.auth.passwordSalt);
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

function setAdminCredentials(username, password) {
  const salt = randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);

  settings.auth = {
    username: username.trim(),
    passwordHash,
    passwordSalt: salt
  };
}

function verifyPassword(password) {
  if (!isAuthConfigured()) {
    return false;
  }

  const expectedHash = Buffer.from(settings.auth.passwordHash, 'hex');
  const receivedHash = Buffer.from(hashPassword(password, settings.auth.passwordSalt), 'hex');

  return (
    expectedHash.length === receivedHash.length && timingSafeEqual(expectedHash, receivedHash)
  );
}

function createSession(username, res) {
  const token = randomBytes(32).toString('hex');

  sessions.set(token, {
    username,
    expiresAt: Date.now() + SESSION_TTL_MS
  });

  setSessionCookie(res, token);
}

function destroySession(req, res) {
  const session = getSessionFromRequest(req);

  if (session) {
    sessions.delete(session.token);
  }

  clearSessionCookie(res);
}

function getRuntimeServiceConfig(serviceName) {
  const serviceSettings = settings[serviceName];
  const envPrefix = serviceName.toUpperCase();

  return {
    url: normalizeBaseUrl(serviceSettings.url || process.env[`${envPrefix}_URL`] || ''),
    apiKey: serviceSettings.apiKey || process.env[`${envPrefix}_API_KEY`] || ''
  };
}

function hasStoredValue(value) {
  return Boolean(String(value || '').trim());
}

function resolveStoredSecret(incomingValue, currentValue, preserveWhenBlank = true) {
  const normalizedIncomingValue = String(incomingValue || '').trim();

  if (normalizedIncomingValue) {
    return normalizedIncomingValue;
  }

  return preserveWhenBlank ? String(currentValue || '').trim() : '';
}

function getClientSettings() {
  const radarrConfig = getRuntimeServiceConfig('radarr');
  const sonarrConfig = getRuntimeServiceConfig('sonarr');

  return {
    auth: {
      username: settings.auth.username
    },
    radarr: {
      url: radarrConfig.url,
      apiKey: '',
      apiKeyConfigured: hasStoredValue(radarrConfig.apiKey),
      configured: Boolean(radarrConfig.url && radarrConfig.apiKey)
    },
    sonarr: {
      url: sonarrConfig.url,
      apiKey: '',
      apiKeyConfigured: hasStoredValue(sonarrConfig.apiKey),
      configured: Boolean(sonarrConfig.url && sonarrConfig.apiKey)
    },
    providers: {
      emby: {
        url: normalizeBaseUrl(settings.providers.emby.url),
        apiKey: '',
        apiKeyConfigured: hasStoredValue(settings.providers.emby.apiKey),
        userId: settings.providers.emby.userId,
        configured: isProviderConfigured('emby')
      },
      jellyfin: {
        url: normalizeBaseUrl(settings.providers.jellyfin.url),
        apiKey: '',
        apiKeyConfigured: hasStoredValue(settings.providers.jellyfin.apiKey),
        userId: settings.providers.jellyfin.userId,
        configured: isProviderConfigured('jellyfin')
      },
      plex: {
        url: normalizeBaseUrl(settings.providers.plex.url),
        token: '',
        tokenConfigured: hasStoredValue(settings.providers.plex.token),
        configured: isProviderConfigured('plex')
      }
    },
    tmdb: {
      accessToken: '',
      accessTokenConfigured: hasStoredValue(settings.tmdb.accessToken)
    },
    preferences: {
      selectionCount: settings.preferences.selectionCount,
      watchMode: settings.preferences.watchMode,
      watchSource: settings.preferences.watchSource,
      franchiseMode: settings.preferences.franchiseMode,
      watchProviderPriority: WATCH_PROVIDER_PRIORITY
    }
  };
}

function validateCredentialInput(username, password) {
  if (!username?.trim()) {
    const error = new Error('Username is required.');
    error.statusCode = 400;
    throw error;
  }

  if (!password || password.length < 8) {
    const error = new Error('Password must be at least 8 characters long.');
    error.statusCode = 400;
    throw error;
  }
}

function validateOptionalHttpUrl(label, value) {
  if (value && !/^https?:\/\//i.test(value.trim())) {
    const error = new Error(`${label} must start with http:// or https://.`);
    error.statusCode = 400;
    throw error;
  }
}

function normalizeSelectionCount(value) {
  if (value === '' || value === null || value === undefined) {
    return null;
  }

  const normalizedValue = Number(value);

  if (!Number.isInteger(normalizedValue) || normalizedValue <= 0) {
    const error = new Error('Selection count must be a whole number greater than 0.');
    error.statusCode = 400;
    throw error;
  }

  return normalizedValue;
}

function normalizeWatchMode(value) {
  if (!value) {
    return 'everything';
  }

  if (!WATCH_MODES.has(value)) {
    const error = new Error('Invalid watch filter option.');
    error.statusCode = 400;
    throw error;
  }

  return value;
}

function normalizeWatchSource(value) {
  if (!value) {
    return 'auto';
  }

  if (!WATCH_SOURCES.has(value)) {
    const error = new Error('Invalid watch provider option.');
    error.statusCode = 400;
    throw error;
  }

  return value;
}

function normalizeFranchiseMode(value) {
  if (!value) {
    return 'off';
  }

  if (!FRANCHISE_MODES.has(value)) {
    const error = new Error('Invalid franchise behavior option.');
    error.statusCode = 400;
    throw error;
  }

  return value;
}

function validateSettingsPayload(payload) {
  validateOptionalHttpUrl('Radarr URL', payload.radarrUrl);
  validateOptionalHttpUrl('Sonarr URL', payload.sonarrUrl);
  validateOptionalHttpUrl('Emby URL', payload.embyUrl);
  validateOptionalHttpUrl('Jellyfin URL', payload.jellyfinUrl);
  validateOptionalHttpUrl('Plex URL', payload.plexUrl);
}

function getPosterUrl(item, serviceBaseUrl) {
  const posterImage = item.images?.find((image) => image.coverType === 'poster');

  if (!posterImage) {
    return null;
  }

  if (posterImage.remoteUrl) {
    return posterImage.remoteUrl;
  }

  if (posterImage.url) {
    return new URL(posterImage.url, `${serviceBaseUrl}/`).toString();
  }

  return null;
}

function mapMovie(movie, radarrBaseUrl) {
  return {
    id: movie.id,
    title: movie.title,
    type: 'movie',
    year: movie.year ?? null,
    posterUrl: getPosterUrl(movie, radarrBaseUrl),
    externalIds: {
      imdb: movie.imdbId ?? '',
      tmdb: movie.tmdbId ? String(movie.tmdbId) : '',
      tvdb: movie.tvdbId ? String(movie.tvdbId) : ''
    }
  };
}

function mapSeries(series, sonarrBaseUrl) {
  return {
    id: series.id,
    title: series.title,
    type: 'show',
    year: series.year ?? null,
    posterUrl: getPosterUrl(series, sonarrBaseUrl),
    externalIds: {
      imdb: series.imdbId ?? '',
      tmdb: series.tmdbId ? String(series.tmdbId) : '',
      tvdb: series.tvdbId ? String(series.tvdbId) : ''
    }
  };
}

function validateServiceConfig(serviceName, url, apiKey) {
  if (!url || !apiKey) {
    const error = new Error(`${serviceName} is not configured.`);
    error.statusCode = 500;
    throw error;
  }
}

function formatUpstreamError(serviceLabel, error, fallbackMessage) {
  const upstreamStatus = error.response?.status;
  const upstreamMessage =
    error.response?.data?.message ||
    error.response?.data?.error ||
    (typeof error.response?.data === 'string' ? error.response.data : '') ||
    error.message ||
    fallbackMessage;

  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return {
      statusCode: 502,
      message: `${serviceLabel} rejected the credentials. ${upstreamMessage}`
    };
  }

  return {
    statusCode:
      error.statusCode || (upstreamStatus >= 400 && upstreamStatus < 600 ? upstreamStatus : 500),
    message: upstreamMessage
  };
}

function isLibrarySourceConfigured(serviceName) {
  const { url, apiKey } = getRuntimeServiceConfig(serviceName);
  return Boolean(url && apiKey);
}

function getConfiguredProviderNames() {
  return WATCH_PROVIDER_PRIORITY.filter(isProviderConfigured);
}

function uniqueBy(items, getKey) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = getKey(item);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

async function fetchRadarrMovies() {
  const { url, apiKey } = getRuntimeServiceConfig('radarr');

  validateServiceConfig('Radarr', url, apiKey);

  const response = await axios.get(`${url}/api/v3/movie`, {
    headers: {
      'X-Api-Key': apiKey
    },
    timeout: 10000
  });

  return response.data.filter((movie) => movie.hasFile).map((movie) => mapMovie(movie, url));
}

async function fetchSonarrShows() {
  const { url, apiKey } = getRuntimeServiceConfig('sonarr');

  validateServiceConfig('Sonarr', url, apiKey);

  const response = await axios.get(`${url}/api/v3/series`, {
    headers: {
      'X-Api-Key': apiKey
    },
    timeout: 10000
  });

  return response.data.filter((series) => series.hasFile).map((series) => mapSeries(series, url));
}

function cryptoShuffle(items) {
  const shuffled = [...items];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = randomInt(index + 1);
    [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
  }

  return shuffled;
}

function buildVisualWheelSubset(pool, winnerIndex, maxVisualItems = MAX_VISUAL_WHEEL_ITEMS) {
  const winner = pool[winnerIndex];

  if (!winner) {
    const error = new Error('Unable to build the visual wheel subset for the selected winner.');
    error.statusCode = 500;
    throw error;
  }

  if (pool.length <= maxVisualItems) {
    return {
      items: pool,
      visualWinningIndex: winnerIndex
    };
  }

  const decoys = pool.filter((_, index) => index !== winnerIndex);
  const visualItems = cryptoShuffle(decoys).slice(0, maxVisualItems - 1);
  visualItems.push(winner);

  const shuffledVisualItems = cryptoShuffle(visualItems);
  const visualWinningIndex = shuffledVisualItems.findIndex((item) => item.id === winner.id);

  return {
    items: shuffledVisualItems,
    visualWinningIndex
  };
}

async function fetchLatestDrandBeacon() {
  const response = await axios.get(DRAND_LATEST_URL, {
    timeout: 10000
  });

  const randomness = response.data?.randomness;

  if (!randomness || !/^[a-f0-9]{64}$/i.test(randomness)) {
    const error = new Error('Invalid randomness received from drand.');
    error.statusCode = 502;
    throw error;
  }

  return randomness;
}

function normalizeExternalId(value) {
  return value ? String(value).trim().toLowerCase() : '';
}

function createMatchKey(type, provider, value) {
  const normalizedValue = normalizeExternalId(value);
  return normalizedValue ? `${type}:${provider}:${normalizedValue}` : null;
}

function createTitleYearKey(type, title, year) {
  const normalizedTitle = title?.trim().toLowerCase();

  if (!normalizedTitle) {
    return null;
  }

  return `${type}:title:${normalizedTitle}:${year ?? 'unknown'}`;
}

function getMatchKeys(item) {
  const keys = new Set();

  for (const [provider, value] of Object.entries(item.externalIds ?? {})) {
    const key = createMatchKey(item.type, provider, value);

    if (key) {
      keys.add(key);
    }
  }

  const titleYearKey = createTitleYearKey(item.type, item.title, item.year);

  if (titleYearKey) {
    keys.add(titleYearKey);
  }

  return keys;
}

function addProviderItemToMatchSet(matchSet, item) {
  const type =
    item.type === 'movie' || item.type === 'Movie'
      ? 'movie'
      : item.type === 'show' || item.type === 'Series' || item.type === 'series'
        ? 'show'
        : null;

  if (!type) {
    return;
  }

  const mappedItem = {
    type,
    title: item.title,
    year: item.year,
    externalIds: item.externalIds ?? {}
  };

  for (const key of getMatchKeys(mappedItem)) {
    matchSet.add(key);
  }
}

function isProviderConfigured(providerName) {
  if (providerName === 'plex') {
    return Boolean(
      normalizeBaseUrl(settings.providers.plex.url) && settings.providers.plex.token.trim()
    );
  }

  const provider = settings.providers[providerName];
  return Boolean(
    normalizeBaseUrl(provider.url) && provider.apiKey.trim() && provider.userId.trim()
  );
}

function isTmdbConfigured() {
  return Boolean(settings.tmdb.accessToken.trim());
}

function getTmdbRequestConfig() {
  const accessToken = settings.tmdb.accessToken.trim();

  if (!accessToken) {
    const error = new Error('TMDb is not configured.');
    error.statusCode = 400;
    throw error;
  }

  return {
    headers: {
      accept: 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    timeout: 10000
  };
}

async function fetchTmdbMovieDetails(tmdbMovieId) {
  const normalizedId = String(tmdbMovieId || '').trim();

  if (!normalizedId) {
    return null;
  }

  if (tmdbMovieCache.has(normalizedId)) {
    return tmdbMovieCache.get(normalizedId);
  }

  const response = await axios.get(
    `${TMDB_API_BASE_URL}/movie/${encodeURIComponent(normalizedId)}`,
    getTmdbRequestConfig()
  );
  const details = response.data ?? null;
  tmdbMovieCache.set(normalizedId, details);
  return details;
}

async function fetchTmdbCollectionDetails(collectionId) {
  const normalizedId = String(collectionId || '').trim();

  if (!normalizedId) {
    return null;
  }

  if (tmdbCollectionCache.has(normalizedId)) {
    return tmdbCollectionCache.get(normalizedId);
  }

  const response = await axios.get(
    `${TMDB_API_BASE_URL}/collection/${encodeURIComponent(normalizedId)}`,
    getTmdbRequestConfig()
  );
  const details = response.data ?? null;
  tmdbCollectionCache.set(normalizedId, details);
  return details;
}

function sortMoviesByReleaseDate(items) {
  return [...items].sort((left, right) => {
    const leftDate = left.releaseDate || `${left.year ?? 9999}-12-31`;
    const rightDate = right.releaseDate || `${right.year ?? 9999}-12-31`;

    if (leftDate !== rightDate) {
      return leftDate.localeCompare(rightDate);
    }

    return (left.title || '').localeCompare(right.title || '');
  });
}

function isItemUnwatched(item, matchSet) {
  if (!matchSet) {
    return false;
  }

  for (const key of getMatchKeys(item)) {
    if (matchSet.has(key)) {
      return true;
    }
  }

  return false;
}

async function resolveOptionalUnwatchedMatchSet() {
  const candidates = getConfiguredProviderNames();

  if (candidates.length === 0) {
    return {
      providerUsed: null,
      matchSet: null,
      warning: null
    };
  }

  const failures = [];

  for (const providerName of candidates) {
    try {
      const matchSet =
        providerName === 'plex'
          ? await fetchPlexUnwatchedItems()
          : await fetchMediaBrowserUnwatchedItems(providerName);

      return {
        providerUsed: providerName,
        matchSet,
        warning: null
      };
    } catch (error) {
      failures.push(`${providerName}: ${error.message}`);
    }
  }

  return {
    providerUsed: null,
    matchSet: null,
    warning: `Unable to load unwatched items for franchise ordering. ${failures.join(' | ')}`
  };
}

function buildFranchisePool({
  library,
  librarySourceUsed,
  watchMode,
  matchSet
}) {
  if (watchMode === 'unwatched' && librarySourceUsed !== 'arr') {
    return library.filter((item) => item.type === 'movie');
  }

  if (watchMode === 'unwatched' && matchSet) {
    return library.filter((item) => item.type === 'movie' && isItemUnwatched(item, matchSet));
  }

  if (!matchSet) {
    return [];
  }

  return library.filter((item) => item.type === 'movie' && isItemUnwatched(item, matchSet));
}

async function resolveFranchiseWinner({
  winner,
  actualPool,
  library,
  librarySourceUsed,
  watchMode,
  matchSet
}) {
  if (
    settings.preferences.franchiseMode !== 'earliest_unwatched_in_collection' ||
    !winner ||
    winner.type !== 'movie'
  ) {
    return {
      winner,
      winningPool: actualPool,
      franchise: {
        applied: false,
        reason: 'disabled'
      },
      warning: null
    };
  }

  if (!isTmdbConfigured()) {
    return {
      winner,
      winningPool: actualPool,
      franchise: {
        applied: false,
        reason: 'tmdb_not_configured'
      },
      warning: 'TMDb is not configured, so franchise ordering was skipped.'
    };
  }

  const winnerTmdbId = winner.externalIds?.tmdb ? String(winner.externalIds.tmdb) : '';

  if (!winnerTmdbId) {
    return {
      winner,
      winningPool: actualPool,
      franchise: {
        applied: false,
        reason: 'missing_tmdb_id'
      },
      warning: null
    };
  }

  const movieDetails = await fetchTmdbMovieDetails(winnerTmdbId);
  const collectionId = movieDetails?.belongs_to_collection?.id;

  if (!collectionId) {
    return {
      winner,
      winningPool: actualPool,
      franchise: {
        applied: false,
        reason: 'not_in_collection'
      },
      warning: null
    };
  }

  const franchisePool = buildFranchisePool({
    library,
    librarySourceUsed,
    watchMode,
    matchSet
  });

  if (franchisePool.length === 0) {
    return {
      winner,
      winningPool: actualPool,
      franchise: {
        applied: false,
        reason: 'no_unwatched_pool'
      },
      warning:
        watchMode === 'everything'
          ? 'Franchise ordering was skipped because unwatched status was unavailable for the selected libraries.'
          : null
    };
  }

  const collectionDetails = await fetchTmdbCollectionDetails(collectionId);
  const orderedParts = sortMoviesByReleaseDate(
    (collectionDetails?.parts ?? []).map((part) => ({
      tmdbId: String(part.id),
      releaseDate: part.release_date || '',
      year: part.release_date ? Number.parseInt(part.release_date.slice(0, 4), 10) : null,
      title: part.title || ''
    }))
  );

  const libraryMoviesByTmdbId = new Map(
    franchisePool
      .filter((item) => item.externalIds?.tmdb)
      .map((item) => [String(item.externalIds.tmdb), item])
  );

  const earliestUnwatchedInCollection = orderedParts
    .map((part) => libraryMoviesByTmdbId.get(part.tmdbId))
    .find(Boolean);

  if (!earliestUnwatchedInCollection) {
    return {
      winner,
      winningPool: actualPool,
      franchise: {
        applied: false,
        reason: 'collection_not_in_library'
      },
      warning: null
    };
  }

  if (earliestUnwatchedInCollection.id === winner.id) {
    return {
      winner,
      winningPool: actualPool,
      franchise: {
        applied: false,
        reason: 'winner_already_earliest'
      },
      warning: null
    };
  }

  const winningPool = actualPool.some((item) => item.id === earliestUnwatchedInCollection.id)
    ? actualPool
    : uniqueBy([...actualPool, earliestUnwatchedInCollection], (item) => item.id);

  return {
    winner: earliestUnwatchedInCollection,
    winningPool,
    franchise: {
      applied: true,
      reason: 'earliest_unwatched_in_collection',
      originalWinnerTitle: winner.title,
      resolvedWinnerTitle: earliestUnwatchedInCollection.title,
      collectionName: collectionDetails?.name || movieDetails?.belongs_to_collection?.name || ''
    },
    warning: null
  };
}

function resolveWatchProviderCandidates() {
  const { watchMode, watchSource } = settings.preferences;

  if (watchMode !== 'unwatched' || watchSource === 'none') {
    return [];
  }

  if (watchSource === 'auto') {
    return WATCH_PROVIDER_PRIORITY.filter(isProviderConfigured);
  }

  return isProviderConfigured(watchSource) ? [watchSource] : [];
}

async function fetchMediaBrowserUnwatchedItems(providerName) {
  const provider = settings.providers[providerName];
  const url = normalizeBaseUrl(provider.url);
  const apiKey = provider.apiKey.trim();
  const userId = await resolveMediaBrowserUserId(providerName, provider);

  if (!url || !apiKey || !userId) {
    const error = new Error(`${providerName} watch-state settings are incomplete.`);
    error.statusCode = 400;
    throw error;
  }

  const response = await axios.get(`${url}/Users/${userId}/Items`, {
    params: {
      Recursive: true,
      IncludeItemTypes: 'Movie,Series',
      Fields: 'ProviderIds,ProductionYear',
      Filters: 'IsUnplayed',
      api_key: apiKey
    },
    timeout: 10000
  });

  const items = response.data?.Items ?? [];
  const matchSet = new Set();

  for (const item of items) {
    addProviderItemToMatchSet(matchSet, {
      type: item.Type,
      title: item.Name,
      year: item.ProductionYear ?? null,
      externalIds: {
        imdb: item.ProviderIds?.Imdb ?? '',
        tmdb: item.ProviderIds?.Tmdb ?? '',
        tvdb: item.ProviderIds?.Tvdb ?? ''
      }
    });
  }

  return matchSet;
}

async function testMediaBrowserProviderConnection(providerName, providerOverride = null) {
  const provider = providerOverride ?? settings.providers[providerName];
  const url = normalizeBaseUrl(provider.url);
  const apiKey = provider.apiKey.trim();
  const userId = await resolveMediaBrowserUserId(providerName, provider);

  if (!url || !apiKey || !userId) {
    const error = new Error(`${providerName} URL, API key, and user ID are required.`);
    error.statusCode = 400;
    throw error;
  }

  const response = await axios.get(`${url}/Users/${userId}/Items`, {
    params: {
      Recursive: true,
      IncludeItemTypes: 'Movie,Series',
      Fields: 'ProviderIds,ProductionYear',
      Limit: 1,
      api_key: apiKey
    },
    timeout: 10000
  });

  return {
    totalRecords: response.data?.TotalRecordCount ?? 0
  };
}

async function testPlexConnection(providerOverride = null) {
  const provider = providerOverride ?? settings.providers.plex;
  const url = normalizeBaseUrl(provider.url);
  const token = provider.token.trim();

  if (!url || !token) {
    const error = new Error('Plex URL and token are required.');
    error.statusCode = 400;
    throw error;
  }

  const response = await axios.get(`${url}/library/sections`, {
    headers: {
      Accept: 'application/json'
    },
    params: {
      'X-Plex-Token': token
    },
    timeout: 10000
  });

  const sections = response.data?.MediaContainer?.Directory ?? [];
  const watchableSections = sections.filter(
    (section) => section.type === 'movie' || section.type === 'show'
  );

  return {
    totalSections: sections.length,
    watchableSections: watchableSections.length
  };
}

function buildMediaBrowserPosterUrl(baseUrl, itemId, apiKey, hasPrimaryImage = true) {
  if (!hasPrimaryImage) {
    return null;
  }

  return `${normalizeBaseUrl(baseUrl)}/Items/${itemId}/Images/Primary?maxHeight=600&quality=90&api_key=${encodeURIComponent(apiKey)}`;
}

async function resolveMediaBrowserUserId(providerName, providerOverride = null) {
  const provider = providerOverride ?? settings.providers[providerName];
  const url = normalizeBaseUrl(provider.url);
  const apiKey = provider.apiKey.trim();
  const userIdOrName = provider.userId.trim();

  if (!url || !apiKey || !userIdOrName) {
    return '';
  }

  const response = await axios.get(`${url}/Users/Query`, {
    params: {
      Limit: 200,
      api_key: apiKey
    },
    timeout: 10000
  });

  const users = response.data?.Items ?? [];
  const exactIdMatch = users.find((user) => user.Id === userIdOrName);

  if (exactIdMatch) {
    return exactIdMatch.Id;
  }

  const exactNameMatch = users.find(
    (user) => String(user.Name || '').toLowerCase() === userIdOrName.toLowerCase()
  );

  if (exactNameMatch) {
    return exactNameMatch.Id;
  }

  const error = new Error(
    `${providerName} user "${userIdOrName}" was not found. Use the Emby username or the actual user ID.`
  );
  error.statusCode = 400;
  throw error;
}

function mapMediaBrowserItem(item, baseUrl, apiKey) {
  const type =
    item.Type === 'Movie' || item.Type === 'movie'
      ? 'movie'
      : item.Type === 'Series' || item.Type === 'series'
        ? 'show'
        : null;

  if (!type) {
    return null;
  }

  return {
    id: item.Id,
    title: item.Name,
    type,
    year: item.ProductionYear ?? null,
    posterUrl: buildMediaBrowserPosterUrl(baseUrl, item.Id, apiKey, Boolean(item.ImageTags?.Primary)),
    externalIds: {
      imdb: item.ProviderIds?.Imdb ?? '',
      tmdb: item.ProviderIds?.Tmdb ?? '',
      tvdb: item.ProviderIds?.Tvdb ?? ''
    }
  };
}

async function fetchMediaBrowserLibraryItems(
  providerName,
  { includeMovies, includeShows, unwatchedOnly, selectedLibraryIds = [] }
) {
  const provider = settings.providers[providerName];
  const url = normalizeBaseUrl(provider.url);
  const apiKey = provider.apiKey.trim();
  const userId = await resolveMediaBrowserUserId(providerName, provider);
  const includeItemTypes = [includeMovies ? 'Movie' : null, includeShows ? 'Series' : null]
    .filter(Boolean)
    .join(',');

  if (!url || !apiKey || !userId) {
    const error = new Error(`${providerName} is not configured for library access.`);
    error.statusCode = 400;
    throw error;
  }

  const libraryIds = selectedLibraryIds.length > 0 ? selectedLibraryIds : [null];
  const collectedItems = [];

  for (const libraryId of libraryIds) {
    const response = await axios.get(`${url}/Users/${userId}/Items`, {
      params: {
        Recursive: true,
        IncludeItemTypes: includeItemTypes,
        Fields: 'ProviderIds,ProductionYear,ImageTags',
        ...(libraryId ? { ParentId: libraryId } : {}),
        ...(unwatchedOnly ? { Filters: 'IsUnplayed' } : {}),
        api_key: apiKey
      },
      timeout: 10000
    });

    collectedItems.push(
      ...(response.data?.Items ?? [])
        .map((item) => mapMediaBrowserItem(item, url, apiKey))
        .filter(Boolean)
    );
  }

  return uniqueBy(collectedItems, (item) => item.id);
}

function isSelectableMediaBrowserView(view) {
  const collectionType = String(view.CollectionType || '').toLowerCase();

  if (!collectionType) {
    return true;
  }

  return !['music', 'books', 'games', 'playlists', 'photos', 'livetv'].includes(collectionType);
}

function getMediaTypesForMediaBrowserView(view) {
  const collectionType = String(view.CollectionType || '').toLowerCase();

  if (collectionType === 'movies') {
    return ['movie'];
  }

  if (collectionType === 'tvshows') {
    return ['show'];
  }

  return ['movie', 'show'];
}

async function fetchMediaBrowserLibraries(providerName) {
  const provider = settings.providers[providerName];
  const url = normalizeBaseUrl(provider.url);
  const apiKey = provider.apiKey.trim();
  const userId = await resolveMediaBrowserUserId(providerName, provider);

  if (!url || !apiKey || !userId) {
    const error = new Error(`${providerName} is not configured for library access.`);
    error.statusCode = 400;
    throw error;
  }

  const response = await axios.get(`${url}/Users/${userId}/Views`, {
    params: {
      api_key: apiKey
    },
    timeout: 10000
  });

  return (response.data?.Items ?? [])
    .filter(isSelectableMediaBrowserView)
    .map((view) => ({
      id: String(view.Id),
      name: view.Name,
      provider: providerName,
      mediaTypes: getMediaTypesForMediaBrowserView(view)
    }));
}

function extractPlexGuidIds(guidEntries = []) {
  const externalIds = {
    imdb: '',
    tmdb: '',
    tvdb: ''
  };

  for (const entry of guidEntries) {
    const rawId = typeof entry === 'string' ? entry : entry?.id;

    if (!rawId) {
      continue;
    }

    const [provider, value] = rawId.split('://');

    if (provider === 'imdb') {
      externalIds.imdb = value ?? '';
    }

    if (provider === 'tmdb') {
      externalIds.tmdb = value ?? '';
    }

    if (provider === 'tvdb') {
      externalIds.tvdb = value ?? '';
    }
  }

  return externalIds;
}

async function fetchPlexUnwatchedItems() {
  const provider = settings.providers.plex;
  const url = normalizeBaseUrl(provider.url);
  const token = provider.token.trim();

  if (!url || !token) {
    const error = new Error('Plex watch-state settings are incomplete.');
    error.statusCode = 400;
    throw error;
  }

  const commonRequestOptions = {
    headers: {
      Accept: 'application/json'
    },
    params: {
      'X-Plex-Token': token
    },
    timeout: 10000
  };

  const sectionsResponse = await axios.get(`${url}/library/sections`, commonRequestOptions);
  const sections = sectionsResponse.data?.MediaContainer?.Directory ?? [];
  const watchableSections = sections.filter(
    (section) => section.type === 'movie' || section.type === 'show'
  );
  const matchSet = new Set();

  for (const section of watchableSections) {
    const itemsResponse = await axios.get(`${url}/library/sections/${section.key}/all`, {
      ...commonRequestOptions,
      params: {
        ...commonRequestOptions.params,
        includeGuids: 1,
        unwatched: 1
      }
    });

    const items = itemsResponse.data?.MediaContainer?.Metadata ?? [];

    for (const item of items) {
      addProviderItemToMatchSet(matchSet, {
        type: item.type,
        title: item.title,
        year: item.year ?? null,
        externalIds: extractPlexGuidIds(item.Guid)
      });
    }
  }

  return matchSet;
}

function mapPlexItem(item, baseUrl, token) {
  const type =
    item.type === 'movie' ? 'movie' : item.type === 'show' ? 'show' : null;

  if (!type) {
    return null;
  }

  return {
    id: item.ratingKey,
    title: item.title,
    type,
    year: item.year ?? null,
    posterUrl: item.thumb
      ? `${normalizeBaseUrl(baseUrl)}${item.thumb}${item.thumb.includes('?') ? '&' : '?'}X-Plex-Token=${encodeURIComponent(token)}`
      : null,
    externalIds: extractPlexGuidIds(item.Guid)
  };
}

async function fetchPlexLibraryItems({ includeMovies, includeShows, unwatchedOnly, selectedLibraryIds = [] }) {
  const provider = settings.providers.plex;
  const url = normalizeBaseUrl(provider.url);
  const token = provider.token.trim();

  if (!url || !token) {
    const error = new Error('Plex is not configured for library access.');
    error.statusCode = 400;
    throw error;
  }

  const commonRequestOptions = {
    headers: {
      Accept: 'application/json'
    },
    params: {
      'X-Plex-Token': token
    },
    timeout: 10000
  };

  const sectionsResponse = await axios.get(`${url}/library/sections`, commonRequestOptions);
  const sections = sectionsResponse.data?.MediaContainer?.Directory ?? [];
  const selectedTypes = new Set([
    includeMovies ? 'movie' : null,
    includeShows ? 'show' : null
  ].filter(Boolean));
  const watchableSections = sections.filter((section) => {
    if (!selectedTypes.has(section.type)) {
      return false;
    }

    if (selectedLibraryIds.length === 0) {
      return true;
    }

    return selectedLibraryIds.includes(String(section.key));
  });
  const items = [];

  for (const section of watchableSections) {
    const itemsResponse = await axios.get(`${url}/library/sections/${section.key}/all`, {
      ...commonRequestOptions,
      params: {
        ...commonRequestOptions.params,
        includeGuids: 1,
        ...(unwatchedOnly ? { unwatched: 1 } : {})
      }
    });

    for (const item of itemsResponse.data?.MediaContainer?.Metadata ?? []) {
      const mappedItem = mapPlexItem(item, url, token);

      if (mappedItem) {
        items.push(mappedItem);
      }
    }
  }

  return uniqueBy(items, (item) => item.id);
}

async function fetchPlexLibraries() {
  const provider = settings.providers.plex;
  const url = normalizeBaseUrl(provider.url);
  const token = provider.token.trim();

  if (!url || !token) {
    const error = new Error('Plex is not configured for library access.');
    error.statusCode = 400;
    throw error;
  }

  const response = await axios.get(`${url}/library/sections`, {
    headers: {
      Accept: 'application/json'
    },
    params: {
      'X-Plex-Token': token
    },
    timeout: 10000
  });

  return (response.data?.MediaContainer?.Directory ?? [])
    .filter((section) => section.type === 'movie' || section.type === 'show')
    .map((section) => ({
      id: String(section.key),
      name: section.title,
      provider: 'plex',
      mediaTypes: [section.type === 'movie' ? 'movie' : 'show']
    }));
}

async function fetchProviderLibrary(providerName, options) {
  if (providerName === 'plex') {
    return fetchPlexLibraryItems(options);
  }

  return fetchMediaBrowserLibraryItems(providerName, options);
}

async function fetchProviderLibraries(providerName) {
  if (providerName === 'plex') {
    return fetchPlexLibraries();
  }

  return fetchMediaBrowserLibraries(providerName);
}

function normalizeSelectedLibraryIds(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

async function fetchPrimaryLibrary({
  includeMovies,
  includeShows,
  watchMode,
  selectedLibraryIds = [],
  selectedLibraryProvider = null
}) {
  const providerCandidates = getConfiguredProviderNames();
  const providerFailures = [];

  for (const providerName of providerCandidates) {
    try {
      const items = await fetchProviderLibrary(providerName, {
        includeMovies,
        includeShows,
        unwatchedOnly: watchMode === 'unwatched',
        selectedLibraryIds:
          selectedLibraryProvider && selectedLibraryProvider !== providerName ? [] : selectedLibraryIds
      });

      return {
        items,
        librarySourceUsed: providerName,
        warnings: providerFailures
      };
    } catch (error) {
      providerFailures.push(`${providerName}: ${error.message}`);
    }
  }

  const mediaSources = [];
  const warnings = [...providerFailures];

  if (includeMovies) {
    if (isLibrarySourceConfigured('radarr')) {
      mediaSources.push({
        label: 'Radarr',
        promise: fetchRadarrMovies()
      });
    } else {
      warnings.push('Movies were selected, but Radarr is not configured.');
    }
  }

  if (includeShows) {
    if (isLibrarySourceConfigured('sonarr')) {
      mediaSources.push({
        label: 'Sonarr',
        promise: fetchSonarrShows()
      });
    } else {
      warnings.push('TV shows were selected, but Sonarr is not configured.');
    }
  }

  if (mediaSources.length === 0) {
    return {
      items: [],
      librarySourceUsed: null,
      warnings
    };
  }

  const libraryResults = await Promise.allSettled(mediaSources.map((source) => source.promise));
  const library = [];

  libraryResults.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      library.push(...result.value);
      return;
    }

    warnings.push(`${mediaSources[index].label}: ${result.reason.message}`);
  });

  return {
    items: library,
    librarySourceUsed: library.length > 0 ? 'arr' : null,
    warnings
  };
}

async function fetchAvailableLibraries() {
  const providerCandidates = getConfiguredProviderNames();
  const warnings = [];

  for (const providerName of providerCandidates) {
    try {
      const libraries = await fetchProviderLibraries(providerName);

      return {
        providerUsed: providerName,
        libraries
      };
    } catch (error) {
      warnings.push(`${providerName}: ${error.message}`);
    }
  }

  return {
    providerUsed: null,
    libraries: [],
    warnings
  };
}

async function fetchUnwatchedMatchSet(watchMode = settings.preferences.watchMode) {
  if (watchMode !== 'unwatched') {
    return {
      providerUsed: null,
      matchSet: null
    };
  }

  const candidates = resolveWatchProviderCandidates();

  if (candidates.length === 0) {
    const error = new Error(
      'Unwatched filtering requires a configured watch-state provider. Configure Emby, Jellyfin, or Plex in Settings.'
    );
    error.statusCode = 400;
    throw error;
  }

  const failures = [];

  for (const providerName of candidates) {
    try {
      const matchSet =
        providerName === 'plex'
          ? await fetchPlexUnwatchedItems()
          : await fetchMediaBrowserUnwatchedItems(providerName);

      return {
        providerUsed: providerName,
        matchSet
      };
    } catch (error) {
      failures.push(`${providerName}: ${error.message}`);
    }
  }

  const error = new Error(`Unable to load unwatched items. ${failures.join(' | ')}`);
  error.statusCode = 502;
  throw error;
}

function filterLibraryByMatchSet(library, matchSet) {
  return library.filter((item) => {
    for (const key of getMatchKeys(item)) {
      if (matchSet.has(key)) {
        return true;
      }
    }

    return false;
  });
}

function requireApiAuth(req, res, next) {
  if (!isAuthConfigured()) {
    return res.status(403).json({
      error: 'Complete initial setup before using the API.',
      requiresSetup: true
    });
  }

  const session = getSessionFromRequest(req);

  if (!session) {
    return res.status(401).json({
      error: 'Authentication required.',
      requiresLogin: true
    });
  }

  req.session = session;
  return next();
}

function redirectToEntryPage(_req, res) {
  const destination = isAuthConfigured() ? '/login.html' : '/login.html?setup=1';
  return res.redirect(destination);
}

function setProviderTestStatusMessage(providerName, result) {
  if (providerName === 'plex') {
    return `Plex connection succeeded. Libraries found: ${result.watchableSections} watchable of ${result.totalSections} total.`;
  }

  const providerLabel = providerName === 'emby' ? 'Emby' : 'Jellyfin';
  return `${providerLabel} connection succeeded. Visible media items: ${result.totalRecords}.`;
}

async function handleProviderTestRequest(req, res, providerNameOverride = null) {
  try {
    const providerName = String(providerNameOverride ?? req.params.providerName ?? '').toLowerCase();

    if (!['emby', 'jellyfin', 'plex'].includes(providerName)) {
      return res.status(404).json({
        error: 'Unknown provider.'
      });
    }

    if (providerName === 'plex') {
      const { plexUrl = '', plexToken = '' } = req.body;

      validateOptionalHttpUrl('Plex URL', plexUrl);

      const result = await testPlexConnection({
        url: plexUrl,
        token: plexToken
      });

      return res.json({
        ok: true,
        message: setProviderTestStatusMessage(providerName, result)
      });
    }

    const providerLabel = providerName === 'emby' ? 'Emby' : 'Jellyfin';
    const { [`${providerName}Url`]: providerUrl = '', [`${providerName}ApiKey`]: providerApiKey = '', [`${providerName}UserId`]: providerUserId = '' } =
      req.body;

    validateOptionalHttpUrl(`${providerLabel} URL`, providerUrl);

    const result = await testMediaBrowserProviderConnection(providerName, {
      url: providerUrl,
      apiKey: providerApiKey,
      userId: providerUserId
    });

    return res.json({
      ok: true,
      message: setProviderTestStatusMessage(providerName, result)
    });
  } catch (error) {
    const providerName = String(providerNameOverride ?? req.params.providerName ?? 'provider').toLowerCase();
    const providerLabel =
      providerName === 'emby'
        ? 'Emby'
        : providerName === 'jellyfin'
          ? 'Jellyfin'
          : providerName === 'plex'
            ? 'Plex'
            : 'Provider';
    const { statusCode, message } = formatUpstreamError(
      providerLabel,
      error,
      `Unable to verify ${providerLabel} settings.`
    );

    return res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({
      error: message
    });
  }
}

if (CORS_ORIGIN) {
  app.use(
    cors({
      origin: CORS_ORIGIN,
      credentials: true
    })
  );
}

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use(express.json());
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/', (req, res) => {
  const session = getSessionFromRequest(req);

  if (!isAuthConfigured() || !session) {
    return redirectToEntryPage(req, res);
  }

  return res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/index.html', (req, res) => {
  const session = getSessionFromRequest(req);

  if (!isAuthConfigured() || !session) {
    return redirectToEntryPage(req, res);
  }

  return res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/settings.html', (req, res) => {
  const session = getSessionFromRequest(req);

  if (!isAuthConfigured() || !session) {
    return redirectToEntryPage(req, res);
  }

  return res.sendFile(path.join(publicDir, 'settings.html'));
});

app.get('/login.html', (_req, res) => {
  res.sendFile(path.join(publicDir, 'login.html'));
});

app.get('/api/auth/status', (req, res) => {
  const session = getSessionFromRequest(req);

  res.json({
    authenticated: Boolean(session),
    adminConfigured: isAuthConfigured(),
    username: session?.username ?? null
  });
});

app.post('/api/auth/setup', async (req, res) => {
  if (isAuthConfigured()) {
    return res.status(409).json({
      error: 'Admin account already configured.'
    });
  }

  try {
    const {
      username,
      password,
      radarrUrl = '',
      radarrApiKey = '',
      sonarrUrl = '',
      sonarrApiKey = '',
      selectionCount = ''
    } = req.body;

    validateCredentialInput(username, password);
    validateSettingsPayload({
      radarrUrl,
      sonarrUrl
    });

    setAdminCredentials(username, password);
    settings.radarr = {
      url: normalizeBaseUrl(radarrUrl),
      apiKey: radarrApiKey.trim()
    };
    settings.sonarr = {
      url: normalizeBaseUrl(sonarrUrl),
      apiKey: sonarrApiKey.trim()
    };
    settings.preferences.selectionCount = normalizeSelectionCount(selectionCount);

    await saveSettings();
    createSession(settings.auth.username, res);

    return res.status(201).json({
      ok: true,
      username: settings.auth.username
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Unable to complete setup.'
    });
  }
});

app.post('/api/auth/login', (req, res) => {
  if (!isAuthConfigured()) {
    return res.status(403).json({
      error: 'Initial setup is required.',
      requiresSetup: true
    });
  }

  const { username = '', password = '' } = req.body;
  const normalizedUsername = username.trim();

  if (normalizedUsername !== settings.auth.username || !verifyPassword(password)) {
    return res.status(401).json({
      error: 'Invalid username or password.'
    });
  }

  createSession(normalizedUsername, res);

  return res.json({
    ok: true,
    username: normalizedUsername
  });
});

app.post('/api/auth/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/health') {
    return next();
  }

  return requireApiAuth(req, res, next);
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    authConfigured: isAuthConfigured()
  });
});

app.get('/api/settings', (_req, res) => {
  res.json({
    settings: getClientSettings()
  });
});

app.get('/api/libraries', async (_req, res) => {
  try {
    const { providerUsed, libraries, warnings = [] } = await fetchAvailableLibraries();

    return res.json({
      providerUsed,
      libraries,
      warnings
    });
  } catch (error) {
    const { statusCode, message } = formatUpstreamError(
      'Library provider',
      error,
      'Unable to load provider libraries.'
    );

    return res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({
      error: message
    });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const {
      radarrUrl = '',
      radarrApiKey = '',
      sonarrUrl = '',
      sonarrApiKey = '',
      embyUrl = '',
      embyApiKey = '',
      embyUserId = '',
      jellyfinUrl = '',
      jellyfinApiKey = '',
      jellyfinUserId = '',
      plexUrl = '',
      plexToken = '',
      tmdbAccessToken = '',
      selectionCount = settings.preferences.selectionCount,
      watchMode = settings.preferences.watchMode,
      watchSource = settings.preferences.watchSource,
      franchiseMode = settings.preferences.franchiseMode,
      username = settings.auth.username,
      newPassword = ''
    } = req.body;
    const normalizedRadarrUrl = normalizeBaseUrl(radarrUrl);
    const normalizedSonarrUrl = normalizeBaseUrl(sonarrUrl);
    const normalizedEmbyUrl = normalizeBaseUrl(embyUrl);
    const normalizedJellyfinUrl = normalizeBaseUrl(jellyfinUrl);
    const normalizedPlexUrl = normalizeBaseUrl(plexUrl);
    const normalizedEmbyUserId = embyUserId.trim();
    const normalizedJellyfinUserId = jellyfinUserId.trim();
    const normalizedUsername = username.trim();

    validateSettingsPayload({
      radarrUrl: normalizedRadarrUrl,
      sonarrUrl: normalizedSonarrUrl,
      embyUrl: normalizedEmbyUrl,
      jellyfinUrl: normalizedJellyfinUrl,
      plexUrl: normalizedPlexUrl
    });

    settings.radarr = {
      url: normalizedRadarrUrl,
      apiKey: resolveStoredSecret(radarrApiKey, settings.radarr.apiKey, Boolean(normalizedRadarrUrl))
    };
    settings.sonarr = {
      url: normalizedSonarrUrl,
      apiKey: resolveStoredSecret(sonarrApiKey, settings.sonarr.apiKey, Boolean(normalizedSonarrUrl))
    };
    settings.providers = {
      emby: {
        url: normalizedEmbyUrl,
        apiKey: resolveStoredSecret(embyApiKey, settings.providers.emby.apiKey, Boolean(normalizedEmbyUrl)),
        userId: normalizedEmbyUserId
      },
      jellyfin: {
        url: normalizedJellyfinUrl,
        apiKey: resolveStoredSecret(
          jellyfinApiKey,
          settings.providers.jellyfin.apiKey,
          Boolean(normalizedJellyfinUrl)
        ),
        userId: normalizedJellyfinUserId
      },
      plex: {
        url: normalizedPlexUrl,
        token: resolveStoredSecret(plexToken, settings.providers.plex.token, Boolean(normalizedPlexUrl))
      }
    };
    settings.tmdb = {
      accessToken: resolveStoredSecret(tmdbAccessToken, settings.tmdb.accessToken, true)
    };
    settings.preferences = {
      selectionCount: normalizeSelectionCount(selectionCount),
      watchMode: normalizeWatchMode(watchMode),
      watchSource: normalizeWatchSource(watchSource),
      franchiseMode: normalizeFranchiseMode(franchiseMode)
    };

    if (normalizedUsername !== settings.auth.username) {
      if (!normalizedUsername) {
        return res.status(400).json({
          error: 'Username cannot be empty.'
        });
      }

      settings.auth.username = normalizedUsername;
    }

    if (newPassword) {
      validateCredentialInput(settings.auth.username, newPassword);
      setAdminCredentials(settings.auth.username, newPassword);
    }

    await saveSettings();

    return res.json({
      ok: true,
      settings: getClientSettings()
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Unable to save settings.'
    });
  }
});

app.post('/api/providers/test/emby', async (req, res) => handleProviderTestRequest(req, res, 'emby'));
app.post('/api/providers/test/:providerName', handleProviderTestRequest);

app.get('/api/spin', async (req, res) => {
  const includeMovies = req.query.includeMovies !== 'false';
  const includeShows = req.query.includeShows !== 'false';
  const requestedWatchMode = req.query.watchMode;
  const selectedLibraryIds = normalizeSelectedLibraryIds(req.query.selectedLibraries);
  const selectedLibraryProvider = req.query.selectedLibraryProvider
    ? String(req.query.selectedLibraryProvider)
    : null;

  if (!includeMovies && !includeShows) {
    return res.status(400).json({
      error: 'At least one media type must be selected.'
    });
  }

  try {
    const effectiveWatchMode = requestedWatchMode
      ? normalizeWatchMode(requestedWatchMode)
      : settings.preferences.watchMode;
    const { items: library, librarySourceUsed, warnings } = await fetchPrimaryLibrary({
      includeMovies,
      includeShows,
      watchMode: effectiveWatchMode,
      selectedLibraryIds,
      selectedLibraryProvider
    });

    if (library.length === 0) {
      return res.status(400).json({
        error: warnings.length
          ? `No library data could be loaded. ${warnings.join(' | ')}`
          : 'No matching media with files was found in the selected libraries.',
        available: 0,
        warnings
      });
    }

    const { providerUsed, matchSet } =
      librarySourceUsed && librarySourceUsed !== 'arr' && effectiveWatchMode === 'unwatched'
        ? { providerUsed: librarySourceUsed, matchSet: null }
        : await fetchUnwatchedMatchSet(effectiveWatchMode);
    const eligibleLibrary = matchSet ? filterLibraryByMatchSet(library, matchSet) : library;

    if (eligibleLibrary.length === 0) {
      return res.status(400).json({
        error: 'No matching unwatched media was found for the current watch-state settings.',
        available: 0
      });
    }

    const configuredSelectionCount = settings.preferences.selectionCount;
    const actualPool =
      configuredSelectionCount === null
        ? eligibleLibrary
        : cryptoShuffle(eligibleLibrary).slice(0, configuredSelectionCount);

    if (actualPool.length === 0) {
      return res.status(400).json({
        error: 'No media was available after applying the current selection count.',
        available: 0
      });
    }

    const randomness = await fetchLatestDrandBeacon();
    const bigIntRandomness = BigInt(`0x${randomness}`);
    const winningIndex = Number(bigIntRandomness % BigInt(actualPool.length));
    const initiallySelectedWinner = actualPool[winningIndex];

    let franchiseMatchSet = matchSet;

    if (settings.preferences.franchiseMode === 'earliest_unwatched_in_collection') {
      const needsOptionalUnwatchedData = effectiveWatchMode !== 'unwatched' && !franchiseMatchSet;

      if (needsOptionalUnwatchedData) {
        const optionalUnwatched = await resolveOptionalUnwatchedMatchSet();

        if (optionalUnwatched.matchSet) {
          franchiseMatchSet = optionalUnwatched.matchSet;
        }

        if (optionalUnwatched.warning) {
          warnings.push(optionalUnwatched.warning);
        }
      }
    }

    let franchiseResolution;

    try {
      franchiseResolution = await resolveFranchiseWinner({
        winner: initiallySelectedWinner,
        actualPool,
        library,
        librarySourceUsed,
        watchMode: effectiveWatchMode,
        matchSet: franchiseMatchSet
      });
    } catch (error) {
      warnings.push(`Franchise ordering was skipped. ${error.message}`);
      franchiseResolution = {
        winner: initiallySelectedWinner,
        winningPool: actualPool,
        franchise: {
          applied: false,
          reason: 'lookup_failed'
        },
        warning: null
      };
    }
    const finalWinner = franchiseResolution.winner;
    const finalWinningIndex = franchiseResolution.winningPool.findIndex(
      (item) => item.id === finalWinner.id
    );

    if (franchiseResolution.warning) {
      warnings.push(franchiseResolution.warning);
    }

    const visualWheel = buildVisualWheelSubset(franchiseResolution.winningPool, finalWinningIndex);

    if (actualPool.length > MAX_VISUAL_WHEEL_ITEMS) {
      warnings.push(
        `The wheel is rendering ${MAX_VISUAL_WHEEL_ITEMS} items for performance, but the winner was selected from all ${actualPool.length} eligible titles.`
      );
    }

    return res.json({
      beacon: {
        randomness
      },
      filter: {
        watchMode: effectiveWatchMode,
        watchProviderUsed: providerUsed,
        librarySourceUsed
      },
      items: visualWheel.items,
      totalPoolSize: actualPool.length,
      wheelSize: visualWheel.items.length,
      winningIndex: visualWheel.visualWinningIndex,
      winning_index: visualWheel.visualWinningIndex,
      actualWinningIndex: winningIndex,
      winner: finalWinner,
      franchise: franchiseResolution.franchise,
      warnings
    });
  } catch (error) {
    const serviceLabel =
      requestedWatchMode === 'unwatched' || settings.preferences.watchMode === 'unwatched' || getConfiguredProviderNames().length > 0
        ? 'Library provider'
        : 'Server';
    const { statusCode, message } = formatUpstreamError(
      serviceLabel,
      error,
      'Unexpected server error.'
    );

    return res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({
      error: message
    });
  }
});

app.use(express.static(publicDir, { index: false }));

async function startServer() {
  await loadSettings();

  app.listen(PORT, '0.0.0.0', function onListen() {
    const { port } = this.address();
    console.log(`Randomisarr server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start Randomisarr:', error);
  process.exit(1);
});
