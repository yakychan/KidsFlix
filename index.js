const express = require('express');
const cors = require('cors');
const axios = require('axios');
const sharp = require('sharp');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =====================================================
// CODIFICACION DE CONFIGURACION EN LA URL
// =====================================================
function encodeConfig(config) {
    return Buffer.from(JSON.stringify(config))
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function decodeConfig(encoded) {
    try {
        var str = encoded.replace(/-/g, '+').replace(/_/g, '/');
        while (str.length % 4) str += '=';
        return JSON.parse(Buffer.from(str, 'base64').toString('utf8'));
    } catch (e) {
        return null;
    }
}

// Middleware para extraer config de la URL
function extractConfig(req, res, next) {
    var configParam = req.params.config;
    if (!configParam) {
        req.userConfig = null;
        return next();
    }
    var config = decodeConfig(configParam);
    if (!config || !config.tmdbKey) {
        return res.status(400).json({ error: 'Configuración inválida. Visita /configure para generar tu URL.' });
    }
    req.userConfig = config;
    next();
}

// =====================================================
// SISTEMA DE FILTRADO INFANTIL
// =====================================================
const ALLOWED_CERTIFICATIONS = {
    'US': ['G', 'PG', 'TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G', 'TV-PG', 'NR'],
    'ES': ['APTA', 'TP', '7', 'A'],
    'GB': ['U', 'PG'],
    'DE': ['0', '6'],
    'FR': ['U', 'TP'],
    'BR': ['L', '10'],
    'MX': ['AA', 'A'],
    'AR': ['ATP', 'SAM 7'],
    'CO': ['TP', '7'],
    'CL': ['TE', 'TE+7']
};

const BLOCKED_GENRE_IDS = [27, 53, 80, 10752, 10768, 10767, 10764, 10763];

const BLOCKED_KEYWORDS = [
    'gore', 'slasher', 'erotic', 'erotica', 'sexual', 'violence',
    'murder', 'serial killer', 'drug', 'drugs', 'narco', 'narcotic',
    'prostitution', 'rape', 'torture', 'blood', 'bloody', 'zombie',
    'horror', 'terror', 'disturbing', 'explicit', 'mature',
    'asesino', 'asesinato', 'violación', 'drogas', 'sangre',
    'demonio', 'demon', 'possessed', 'exorcism', 'hell',
    'gambling', 'mafia', 'cartel', 'trafficking'
];

const BLOCKED_OMDB_RATINGS = ['R', 'NC-17', 'X', 'TV-MA', 'TV-14', 'PG-13', 'MA-17', 'AO'];

const KIDS_GENRES_MOVIE = {
    "Animación": 16, "Familia": 10751, "Aventura": 12,
    "Comedia": 35, "Fantasía": 14, "Musical": 10402
};

const KIDS_GENRES_TV = {
    "Animación": 16, "Familia": 10751, "Comedia": 35,
    "Aventura": 10759, "Fantasía": 10765
};

// =====================================================
// CACHE EN MEMORIA
// =====================================================
var cache = {};
var CACHE_TTL = {
    tmdb: 30 * 60 * 1000,
    omdb: 24 * 60 * 60 * 1000,
    catalog: 15 * 60 * 1000,
    filter: 60 * 60 * 1000
};

function cacheGet(key) {
    var entry = cache[key];
    if (!entry) return null;
    if (Date.now() > entry.expires) { delete cache[key]; return null; }
    return entry.data;
}

function cacheSet(key, data, ttlMs) {
    cache[key] = { data: data, expires: Date.now() + ttlMs };
    var keys = Object.keys(cache);
    if (keys.length > 8000) {
        var now = Date.now();
        for (var i = 0; i < keys.length; i++) {
            if (cache[keys[i]].expires < now) delete cache[keys[i]];
        }
    }
}

setInterval(function () {
    var now = Date.now();
    var keys = Object.keys(cache);
    var cleaned = 0;
    for (var i = 0; i < keys.length; i++) {
        if (cache[keys[i]].expires < now) { delete cache[keys[i]]; cleaned++; }
    }
    if (cleaned > 0) console.log('[CACHE] Limpiadas ' + cleaned + ' entradas');
}, 10 * 60 * 1000);

// =====================================================
// UTILIDADES
// =====================================================
function formatRuntime(m) {
    if (!m || m <= 0) return null;
    var mins = parseInt(m);
    if (isNaN(mins)) return null;
    if (mins >= 60) {
        var h = Math.floor(mins / 60);
        var r = mins % 60;
        return r > 0 ? h + 'h ' + r + 'm' : h + 'h';
    }
    return mins + ' min';
}

// =====================================================
// API CALLS CON KEYS DEL USUARIO
// =====================================================
async function safeTmdb(ep, tmdbKey) {
    var cacheKey = 'tmdb:' + ep;
    var cached = cacheGet(cacheKey);
    if (cached !== null) return cached;
    try {
        var s = ep.includes('?') ? '&' : '?';
        var data = (await axios.get(
            'https://api.themoviedb.org/3/' + ep + s + 'api_key=' + tmdbKey + '&language=es-ES',
            { timeout: 5000 }
        )).data || null;
        if (data) cacheSet(cacheKey, data, CACHE_TTL.tmdb);
        return data;
    } catch (e) { return null; }
}

async function safeTmdbEN(ep, tmdbKey) {
    var cacheKey = 'tmdb_en:' + ep;
    var cached = cacheGet(cacheKey);
    if (cached !== null) return cached;
    try {
        var s = ep.includes('?') ? '&' : '?';
        var data = (await axios.get(
            'https://api.themoviedb.org/3/' + ep + s + 'api_key=' + tmdbKey + '&language=en-US',
            { timeout: 5000 }
        )).data || null;
        if (data) cacheSet(cacheKey, data, CACHE_TTL.tmdb);
        return data;
    } catch (e) { return null; }
}

async function safeOmdb(id, omdbKey) {
    if (!omdbKey) return {};
    var cacheKey = 'omdb:' + id;
    var cached = cacheGet(cacheKey);
    if (cached !== null) return cached;
    try {
        var r = await axios.get('https://www.omdbapi.com/?i=' + id + '&apikey=' + omdbKey, { timeout: 3000 });
        var data = r.data && r.data.Response !== "False" ? r.data : {};
        cacheSet(cacheKey, data, CACHE_TTL.omdb);
        return data;
    } catch (e) {
        return {};
    }
}

// =====================================================
// FILTRADO INFANTIL
// =====================================================
function checkAdultFlag(tmdbItem) {
    if (tmdbItem && tmdbItem.adult === true) return 'blocked';
    return 'safe';
}

function checkGenres(genreIds) {
    if (!genreIds || genreIds.length === 0) return 'unknown';
    for (var i = 0; i < genreIds.length; i++) {
        if (BLOCKED_GENRE_IDS.indexOf(genreIds[i]) !== -1) return 'blocked';
    }
    var kidsGenres = [16, 10751, 10762];
    for (var j = 0; j < genreIds.length; j++) {
        if (kidsGenres.indexOf(genreIds[j]) !== -1) return 'safe';
    }
    return 'unknown';
}

function checkDescription(text) {
    if (!text) return 'unknown';
    var lower = text.toLowerCase();
    for (var i = 0; i < BLOCKED_KEYWORDS.length; i++) {
        if (lower.indexOf(BLOCKED_KEYWORDS[i]) !== -1) return 'blocked';
    }
    return 'unknown';
}

function checkOmdbRating(omdbData) {
    if (!omdbData || !omdbData.Rated) return 'unknown';
    var rated = omdbData.Rated.trim();
    if (BLOCKED_OMDB_RATINGS.indexOf(rated) !== -1) return 'blocked';
    return 'safe';
}

async function checkTmdbCertification(tmdbId, mediaType, tmdbKey) {
    var cacheKey = 'cert:' + mediaType + ':' + tmdbId;
    var cached = cacheGet(cacheKey);
    if (cached !== null) return cached;

    try {
        var endpoint = mediaType === 'movie'
            ? 'movie/' + tmdbId + '/release_dates'
            : 'tv/' + tmdbId + '/content_ratings';

        var data = await safeTmdb(endpoint, tmdbKey);
        if (!data) { cacheSet(cacheKey, 'unknown', CACHE_TTL.filter); return 'unknown'; }

        var results = data.results || [];
        var validCerts = [];
        var result = 'unknown';

        for (var i = 0; i < results.length; i++) {
            var country = results[i].iso_3166_1;
            var allowed = ALLOWED_CERTIFICATIONS[country];
            if (!allowed) continue;

            if (mediaType === 'movie') {
                var relDates = results[i].release_dates || [];
                for (var j = 0; j < relDates.length; j++) {
                    var cert = (relDates[j].certification || '').trim();
                    if (cert && allowed.indexOf(cert) !== -1) validCerts.push(cert);
                }
            } else {
                var rating = (results[i].rating || '').trim();
                if (rating && allowed.indexOf(rating) !== -1) validCerts.push(rating);
            }
        }

        if (validCerts.length > 0) result = 'safe';

        for (var k = 0; k < results.length; k++) {
            if (mediaType === 'movie') {
                var relDates2 = results[k].release_dates || [];
                for (var l = 0; l < relDates2.length; l++) {
                    var cert2 = (relDates2[l].certification || '').trim();
                    if (['R', 'NC-17', 'X', '18', '16', '15', 'MA 15+', 'TV-MA', 'TV-14'].indexOf(cert2) !== -1) {
                        result = 'blocked'; break;
                    }
                }
            } else {
                var rating2 = (results[k].rating || '').trim();
                if (['TV-MA', 'TV-14', 'MA', '18', '16', '15'].indexOf(rating2) !== -1) {
                    result = 'blocked'; break;
                }
            }
            if (result === 'blocked') break;
        }

        cacheSet(cacheKey, result, CACHE_TTL.filter);
        return result;
    } catch (e) { return 'unknown'; }
}

async function isKidsSafe(tmdbItem, tmdbId, mediaType, imdbId, tmdbKey, omdbKey) {
    if (checkAdultFlag(tmdbItem) === 'blocked') return false;

    var genreIds = tmdbItem.genre_ids || (tmdbItem.genres ? tmdbItem.genres.map(function (g) { return g.id; }) : []);
    if (checkGenres(genreIds) === 'blocked') return false;
    if (checkDescription(tmdbItem.overview || '') === 'blocked') return false;

    var certCheck = await checkTmdbCertification(tmdbId, mediaType, tmdbKey);
    if (certCheck === 'blocked') return false;

    if (imdbId && omdbKey) {
        var omdb = await safeOmdb(imdbId, omdbKey);
        if (checkOmdbRating(omdb) === 'blocked') return false;
    }

    var genreCheck = checkGenres(genreIds);
    if (genreCheck === 'safe' || certCheck === 'safe') return true;

    var neutralGenres = [35, 12, 14, 878, 10402, 10749, 36, 99];
    var hasNeutralGenre = false;
    for (var i = 0; i < genreIds.length; i++) {
        if (neutralGenres.indexOf(genreIds[i]) !== -1) { hasNeutralGenre = true; break; }
    }

    if (hasNeutralGenre && certCheck !== 'blocked') {
        if (imdbId && omdbKey) {
            var omdb2 = await safeOmdb(imdbId, omdbKey);
            return checkOmdbRating(omdb2) !== 'blocked';
        }
        return true;
    }

    return false;
}

// =====================================================
// CATALOGO MAP
// =====================================================
var CATALOG_MAP = {
    'kf_trending': { url: 'discover/movie?with_genres=16|10751&sort_by=popularity.desc&certification_country=US&certification.lte=PG', mediaType: 'movie' },
    'kf_popular_movies': { url: 'discover/movie?with_genres=10751&sort_by=popularity.desc&certification_country=US&certification.lte=PG', mediaType: 'movie' },
    'kf_top_movies': { url: 'discover/movie?with_genres=10751&sort_by=vote_average.desc&vote_count.gte=500&certification_country=US&certification.lte=PG', mediaType: 'movie' },
    'kf_animation': { url: 'discover/movie?with_genres=16&sort_by=popularity.desc&certification_country=US&certification.lte=PG', mediaType: 'movie' },
    'kf_adventure': { url: 'discover/movie?with_genres=12,10751&sort_by=popularity.desc&certification_country=US&certification.lte=PG', mediaType: 'movie' },
    'kf_comedy': { url: 'discover/movie?with_genres=35,10751&sort_by=popularity.desc&certification_country=US&certification.lte=PG', mediaType: 'movie' },
    'kf_fantasy': { url: 'discover/movie?with_genres=14,10751&sort_by=popularity.desc&certification_country=US&certification.lte=PG', mediaType: 'movie' },
    'kf_musical': { url: 'discover/movie?with_genres=10402,10751&sort_by=popularity.desc&certification_country=US&certification.lte=PG', mediaType: 'movie' },
    'kf_disney': { url: 'discover/movie?with_companies=2&with_genres=16|10751&sort_by=popularity.desc&certification_country=US&certification.lte=PG', mediaType: 'movie' },
    'kf_pixar': { url: 'discover/movie?with_companies=3&sort_by=popularity.desc&certification_country=US&certification.lte=PG', mediaType: 'movie' },
    'kf_dreamworks': { url: 'discover/movie?with_companies=521&with_genres=16&sort_by=popularity.desc&certification_country=US&certification.lte=PG', mediaType: 'movie' },
    'kf_illumination': { url: 'discover/movie?with_companies=6704&sort_by=popularity.desc&certification_country=US&certification.lte=PG', mediaType: 'movie' },
    'kf_ghibli': { url: 'discover/movie?with_companies=10342&sort_by=popularity.desc', mediaType: 'movie' },
    'kf_new_releases': { url: 'discover/movie?with_genres=16|10751&sort_by=release_date.desc&vote_count.gte=10&certification_country=US&certification.lte=PG', mediaType: 'movie' },
    'kf_classics': { url: 'discover/movie?with_genres=16|10751&sort_by=vote_average.desc&vote_count.gte=200&primary_release_date.lte=2005-12-31&certification_country=US&certification.lte=PG', mediaType: 'movie' },
    'kf_anime_movies': { url: 'discover/movie?with_genres=16&with_original_language=ja&sort_by=popularity.desc&certification_country=US&certification.lte=PG', mediaType: 'movie' },
    'kf_spanish_kids': { url: 'discover/movie?with_genres=16|10751&with_original_language=es&sort_by=popularity.desc', mediaType: 'movie' },
    'kf_docs_kids': { url: 'discover/movie?with_genres=99,10751&sort_by=popularity.desc&certification_country=US&certification.lte=PG', mediaType: 'movie' },
    'kf_trending_series': { url: 'discover/tv?with_genres=10762&sort_by=popularity.desc', mediaType: 'tv' },
    'kf_popular_series': { url: 'discover/tv?with_genres=10762|10751&sort_by=popularity.desc', mediaType: 'tv' },
    'kf_top_series': { url: 'discover/tv?with_genres=10762&sort_by=vote_average.desc&vote_count.gte=100', mediaType: 'tv' },
    'kf_animated_series': { url: 'discover/tv?with_genres=16,10762&sort_by=popularity.desc', mediaType: 'tv' },
    'kf_family_series': { url: 'discover/tv?with_genres=10751&sort_by=popularity.desc', mediaType: 'tv' },
    'kf_adventure_series': { url: 'discover/tv?with_genres=10759,10762&sort_by=popularity.desc', mediaType: 'tv' },
    'kf_comedy_series': { url: 'discover/tv?with_genres=35,10762&sort_by=popularity.desc', mediaType: 'tv' },
    'kf_scifi_series': { url: 'discover/tv?with_genres=10765,10762&sort_by=popularity.desc', mediaType: 'tv' },
    'kf_anime_series': { url: 'discover/tv?with_genres=16&with_original_language=ja&sort_by=popularity.desc', mediaType: 'tv' },
    'kf_spanish_series': { url: 'discover/tv?with_genres=10762|10751|16&with_original_language=es&sort_by=popularity.desc', mediaType: 'tv' },
    'kf_educational': { url: 'discover/tv?with_genres=10762&with_keywords=195051|6075|210342&sort_by=popularity.desc', mediaType: 'tv' },
    'kf_preschool': { url: 'discover/tv?with_genres=10762&sort_by=popularity.desc&first_air_date.gte=2015-01-01', mediaType: 'tv' },
    'kf_classic_series': { url: 'discover/tv?with_genres=10762|16&sort_by=vote_average.desc&vote_count.gte=50&first_air_date.lte=2010-12-31', mediaType: 'tv' },
    'kf_new_series': { url: 'discover/tv?with_genres=10762|10751|16&sort_by=first_air_date.desc&vote_count.gte=5', mediaType: 'tv' }
};

function getCatalogEndpoint(catalogId, page) {
    var entry = CATALOG_MAP[catalogId];
    if (!entry) return null;
    var url = entry.url;
    var separator = url.includes('?') ? '&' : '?';
    url += separator + 'page=' + page;
    return { url: url, mediaType: entry.mediaType };
}

// =====================================================
// TMDB A IMDB CON FILTRADO
// =====================================================
async function tmdbToImdbFiltered(endpoint, mediaType, tmdbKey, omdbKey) {
    try {
        var r = await safeTmdb(endpoint, tmdbKey);
        if (!r || !r.results || r.results.length === 0) return { ids: [], hasMore: false };

        var filtered = [];
        for (var i = 0; i < r.results.length; i++) {
            var item = r.results[i];
            if (item.adult === true) continue;
            var genreIds = item.genre_ids || [];
            var hasBlocked = false;
            for (var g = 0; g < genreIds.length; g++) {
                if (BLOCKED_GENRE_IDS.indexOf(genreIds[g]) !== -1) { hasBlocked = true; break; }
            }
            if (hasBlocked) continue;
            if (checkDescription(item.overview || '') === 'blocked') continue;
            filtered.push(item);
        }

        var exts = await Promise.all(
            filtered.map(function (item) {
                return safeTmdb(mediaType + '/' + item.id + '/external_ids', tmdbKey).catch(function () { return null; });
            })
        );

        var ids = [];
        for (var j = 0; j < filtered.length; j++) {
            var ext = exts[j];
            var imdbId = ext ? ext.imdb_id : null;
            if (!imdbId || !imdbId.startsWith('tt')) continue;
            var safe = await isKidsSafe(filtered[j], filtered[j].id, mediaType, imdbId, tmdbKey, omdbKey);
            if (safe) ids.push(imdbId);
        }

        return { ids: ids, hasMore: r.page < Math.min(r.total_pages || 1, 500) };
    } catch (e) { return { ids: [], hasMore: false }; }
}

// =====================================================
// RATINGS
// =====================================================
async function getRatings(imdbId, tmdbVoteAverage, omdbKey) {
    var omdb = await safeOmdb(imdbId, omdbKey);
    var imdbRating = null, rtScore = null;
    if (omdb.imdbRating && omdb.imdbRating !== 'N/A') imdbRating = omdb.imdbRating;
    else if (tmdbVoteAverage && tmdbVoteAverage > 0) imdbRating = tmdbVoteAverage.toFixed(1);
    if (omdb.Ratings) {
        var rt = omdb.Ratings.find(function (r) { return r.Source === "Rotten Tomatoes"; });
        if (rt) rtScore = rt.Value.replace('%', '');
    }
    return { imdbRating: imdbRating, rtScore: rtScore, omdb: omdb };
}

// =====================================================
// BUILD METAS
// =====================================================
async function buildMetas(imdbIds, type, host, protocol, tmdbKey, omdbKey) {
    var BATCH_SIZE = 5;
    var allMetas = [];
    for (var b = 0; b < imdbIds.length; b += BATCH_SIZE) {
        var batch = imdbIds.slice(b, b + BATCH_SIZE);
        var batchResults = await Promise.all(batch.map(function (imId) {
            return buildSingleMeta(imId, type, host, protocol, tmdbKey, omdbKey);
        }));
        allMetas = allMetas.concat(batchResults);
    }
    return allMetas.filter(Boolean);
}

async function buildSingleMeta(imId, type, host, protocol, tmdbKey, omdbKey) {
    try {
        var f = await safeTmdb('find/' + imId + '?external_source=imdb_id', tmdbKey);
        if (!f) return null;
        var tv = f.tv_results ? f.tv_results[0] : null;
        var mv = f.movie_results ? f.movie_results[0] : null;
        var tmdb = type === 'series' ? (tv || mv) : (mv || tv);
        if (!tmdb) return null;

        var tmdbType = (tv && type === 'series') ? 'tv' : 'movie';
        var safe = await isKidsSafe(tmdb, tmdb.id, tmdbType, imId, tmdbKey, omdbKey);
        if (!safe) return null;

        var ratingsData = await getRatings(imId, tmdb.vote_average, omdbKey);
        var pp = tmdb.poster_path;
        var poster = pp ? 'https://image.tmdb.org/t/p/w500' + pp : null;
        var customPoster = poster;

        if (poster && host) {
            var params = new URLSearchParams();
            params.set('url', poster);
            if (ratingsData.imdbRating) params.set('imdb', ratingsData.imdbRating);
            if (ratingsData.rtScore) params.set('rt', ratingsData.rtScore);
            customPoster = protocol + '://' + host + '/poster/' + imId + '.jpg?' + params.toString();
        }

        return {
            id: imId, type: type,
            name: tmdb.name || tmdb.title,
            poster: customPoster,
            background: tmdb.backdrop_path ? 'https://image.tmdb.org/t/p/original' + tmdb.backdrop_path : null,
            description: tmdb.overview || "",
            releaseInfo: (tmdb.first_air_date || tmdb.release_date || "").substring(0, 4),
            imdbRating: ratingsData.imdbRating,
            genres: []
        };
    } catch (e) { return null; }
}

// =====================================================
// PIXEL FONT
// =====================================================
var DIGIT_PATTERNS = { '0': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'], '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'], '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'], '3': ['01110', '10001', '00001', '00110', '00001', '10001', '01110'], '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'], '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'], '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'], '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'], '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'], '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'], '.': ['000', '000', '000', '000', '000', '000', '010'], '%': ['11001', '11010', '00100', '00100', '00100', '01011', '10011'], ' ': ['0000', '0000', '0000', '0000', '0000', '0000', '0000'], 'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'], 'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'], 'C': ['01110', '10001', '10000', '10000', '10000', '10001', '01110'], 'D': ['11100', '10010', '10001', '10001', '10001', '10010', '11100'], 'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'], 'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'], 'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01110'], 'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'], 'I': ['01110', '00100', '00100', '00100', '00100', '00100', '01110'], 'J': ['00111', '00010', '00010', '00010', '00010', '10010', '01100'], 'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'], 'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'], 'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'], 'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'], 'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'], 'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'], 'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'], 'S': ['01110', '10001', '10000', '01110', '00001', '10001', '01110'], 'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'], 'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'], 'V': ['10001', '10001', '10001', '10001', '01010', '01010', '00100'], 'W': ['10001', '10001', '10001', '10101', '10101', '11011', '10001'], 'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'], 'Y': ['10001', '10001', '01010', '00100', '00100', '00100', '00100'], 'Z': ['11111', '00001', '00010', '00100', '01000', '10000', '11111'] };

function renderPixelText(text, scale, fgColor, bgColor) {
    var charHeight = 7, spacing = 1, padding = 2;
    var charWidths = [], totalWidth = 0;
    for (var i = 0; i < text.length; i++) {
        var p = DIGIT_PATTERNS[text[i]];
        var w = p ? p[0].length : 3;
        charWidths.push(w);
        totalWidth += w;
        if (i < text.length - 1) totalWidth += spacing;
    }
    var imgWidth = (totalWidth + padding * 2) * scale;
    var imgHeight = (charHeight + padding * 2) * scale;
    var pixels = Buffer.alloc(imgWidth * imgHeight * 4);
    for (var idx = 0; idx < imgWidth * imgHeight; idx++) {
        pixels[idx * 4] = bgColor.r; pixels[idx * 4 + 1] = bgColor.g;
        pixels[idx * 4 + 2] = bgColor.b; pixels[idx * 4 + 3] = bgColor.a;
    }
    var cursorX = padding;
    for (var c = 0; c < text.length; c++) {
        var pattern = DIGIT_PATTERNS[text[c]];
        if (!pattern) { cursorX += charWidths[c] + spacing; continue; }
        for (var row = 0; row < charHeight; row++) {
            for (var col = 0; col < pattern[row].length; col++) {
                if (pattern[row][col] === '1') {
                    for (var sy = 0; sy < scale; sy++) {
                        for (var sx = 0; sx < scale; sx++) {
                            var px = (cursorX + col) * scale + sx;
                            var py = (padding + row) * scale + sy;
                            var pi = (py * imgWidth + px) * 4;
                            if (pi >= 0 && pi < pixels.length - 3) {
                                pixels[pi] = fgColor.r; pixels[pi + 1] = fgColor.g;
                                pixels[pi + 2] = fgColor.b; pixels[pi + 3] = fgColor.a;
                            }
                        }
                    }
                }
            }
        }
        cursorX += charWidths[c] + spacing;
    }
    return sharp(pixels, { raw: { width: imgWidth, height: imgHeight, channels: 4 } }).png().toBuffer();
}

// =====================================================
// POSTER CON BADGES
// =====================================================
async function drawPoster(url, ratings, runtime) {
    try {
        var imgRes = await axios({ url: url, responseType: "arraybuffer", timeout: 5000 });
        var imdb = ratings.imdb, rt = ratings.rt;
        var hasImdb = imdb && imdb !== 'null' && imdb !== 'undefined' && imdb !== '' && imdb !== 'N/A';
        var hasRt = rt && rt !== 'null' && rt !== 'undefined' && rt !== '';
        var hasRuntime = runtime && runtime !== 'null' && runtime !== 'undefined' && runtime !== '';
        var composites = [], rightEdge = 488;

        if (hasImdb) {
            var imdbBadge = await renderPixelText(imdb, 5, { r: 0, g: 0, b: 0, a: 255 }, { r: 245, g: 197, b: 24, a: 255 });
            var imdbInfo = await sharp(imdbBadge).metadata();
            composites.push({ input: imdbBadge, top: 10, left: rightEdge - imdbInfo.width });
            rightEdge = rightEdge - imdbInfo.width - 6;
        }

        if (hasRt) {
            var rtBadge = await renderPixelText(rt + '%', 5, { r: 255, g: 255, b: 255, a: 255 }, { r: 220, g: 30, b: 10, a: 255 });
            var rtInfo = await sharp(rtBadge).metadata();
            composites.push({ input: rtBadge, top: 10, left: rightEdge - rtInfo.width });
        }

        var footerBg = await sharp({ create: { width: 500, height: 38, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.85 } } }).png().toBuffer();
        composites.push({ input: footerBg, top: 712, left: 0 });

        if (hasRuntime) {
            var rtmBadge = await renderPixelText(runtime, 3, { r: 200, g: 200, b: 200, a: 255 }, { r: 0, g: 0, b: 0, a: 0 });
            composites.push({ input: rtmBadge, top: 718, left: 10 });
        }

        var brandBadge = await renderPixelText('KIDSFLIX', 3, { r: 50, g: 205, b: 50, a: 255 }, { r: 0, g: 0, b: 0, a: 0 });
        var brandInfo = await sharp(brandBadge).metadata();
        composites.push({ input: brandBadge, top: 718, left: hasRuntime ? 488 - brandInfo.width : Math.floor((500 - brandInfo.width) / 2) });

        return await sharp(imgRes.data).resize(500, 750, { fit: 'cover' }).composite(composites).jpeg({ quality: 85 }).toBuffer();
    } catch (e) { console.log('[POSTER ERROR]', e.message); return null; }
}

// =====================================================
// PAGINA DE CONFIGURACION
// =====================================================
app.get('/', function (req, res) {
    res.redirect('/configure');
});

app.get('/configure', function (req, res) {
    var host = req.headers.host;
    var protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    var baseUrl = protocol + '://' + host;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KidsFlix - Configuración</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            max-width: 650px;
            margin: 0 auto;
        }
        .header {
            text-align: center;
            padding: 30px 0;
        }
        .header .emoji { font-size: 4em; }
        .header h1 { color: white; font-size: 2.5em; margin: 10px 0 5px; }
        .header p { color: rgba(255,255,255,0.85); font-size: 1.1em; }

        .card {
            background: white;
            border-radius: 16px;
            padding: 30px;
            margin-bottom: 20px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        }
        .card h2 {
            color: #333;
            margin-bottom: 20px;
            font-size: 1.3em;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        .form-group label {
            display: block;
            color: #444;
            font-weight: 600;
            margin-bottom: 6px;
            font-size: 0.95em;
        }
        .form-group .hint {
            color: #888;
            font-size: 0.82em;
            margin-bottom: 8px;
        }
        .form-group input {
            width: 100%;
            padding: 12px 16px;
            border: 2px solid #e0e0e0;
            border-radius: 10px;
            font-size: 1em;
            transition: border-color 0.2s;
            outline: none;
        }
        .form-group input:focus {
            border-color: #667eea;
        }
        .form-group input.error {
            border-color: #e74c3c;
        }
        .required { color: #e74c3c; }
        .optional-badge {
            background: #e8f5e9;
            color: #388e3c;
            padding: 2px 8px;
            border-radius: 8px;
            font-size: 0.75em;
            font-weight: 600;
            margin-left: 5px;
        }
        .api-link {
            display: inline-block;
            color: #667eea;
            font-size: 0.85em;
            text-decoration: none;
            margin-top: 4px;
        }
        .api-link:hover { text-decoration: underline; }

        .btn-generate {
            width: 100%;
            padding: 16px;
            background: linear-gradient(135deg, #2ecc71, #27ae60);
            color: white;
            border: none;
            border-radius: 12px;
            font-size: 1.15em;
            font-weight: 700;
            cursor: pointer;
            transition: transform 0.15s, box-shadow 0.15s;
            box-shadow: 0 4px 15px rgba(46,204,113,0.4);
        }
        .btn-generate:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(46,204,113,0.6);
        }
        .btn-generate:disabled {
            background: #ccc;
            cursor: not-allowed;
            transform: none;
            box-shadow: none;
        }

        #result {
            display: none;
            margin-top: 20px;
        }
        .result-card {
            background: #f0fdf4;
            border: 2px solid #86efac;
            border-radius: 12px;
            padding: 24px;
        }
        .result-card h3 {
            color: #166534;
            margin-bottom: 15px;
            font-size: 1.15em;
        }
        .url-box {
            background: white;
            border: 1px solid #d1d5db;
            border-radius: 8px;
            padding: 12px;
            word-break: break-all;
            font-family: 'Courier New', monospace;
            font-size: 0.85em;
            color: #374151;
            margin-bottom: 15px;
            max-height: 80px;
            overflow-y: auto;
        }
        .btn-row {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }
        .btn-action {
            flex: 1;
            min-width: 140px;
            padding: 12px 16px;
            border: none;
            border-radius: 10px;
            font-size: 0.95em;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.15s;
            text-decoration: none;
            text-align: center;
            display: inline-block;
        }
        .btn-action:hover { transform: translateY(-1px); }
        .btn-install {
            background: linear-gradient(135deg, #8b5cf6, #7c3aed);
            color: white;
        }
        .btn-copy {
            background: linear-gradient(135deg, #3b82f6, #2563eb);
            color: white;
        }
        .btn-copy.copied {
            background: linear-gradient(135deg, #10b981, #059669);
        }

        .features-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            margin-top: 15px;
        }
        .feature-item {
            display: flex;
            align-items: center;
            gap: 8px;
            color: #555;
            font-size: 0.9em;
        }

        .error-msg {
            color: #e74c3c;
            font-size: 0.85em;
            margin-top: 4px;
            display: none;
        }

        .testing {
            color: #667eea;
            font-size: 0.85em;
            margin-top: 4px;
            display: none;
        }
        .testing.active { display: block; }

        .status-dot {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            margin-right: 5px;
        }
        .status-dot.green { background: #22c55e; }
        .status-dot.red { background: #ef4444; }
        .status-dot.yellow { background: #eab308; }

        @media (max-width: 500px) {
            .features-grid { grid-template-columns: 1fr; }
            .btn-row { flex-direction: column; }
            .header h1 { font-size: 2em; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="emoji">🧸</div>
            <h1>KidsFlix</h1>
            <p>Contenido infantil seguro para Stremio</p>
        </div>

        <div class="card">
            <h2>🔑 Configura tus API Keys</h2>

            <div class="form-group">
                <label>TMDB API Key <span class="required">*obligatoria</span></label>
                <p class="hint">Necesaria para el catálogo, posters y metadata</p>
                <input type="text" id="tmdbKey" placeholder="ej: a1b2c3d4e5f6g7h8i9j0..." autocomplete="off">
                <a class="api-link" href="https://www.themoviedb.org/settings/api" target="_blank">📎 Obtener key gratis en themoviedb.org</a>
                <p class="error-msg" id="tmdbError"></p>
                <p class="testing" id="tmdbTesting">⏳ Verificando key...</p>
            </div>

            <div class="form-group">
                <label>OMDB API Key <span class="optional-badge">opcional</span></label>
                <p class="hint">Para ratings de IMDb/Rotten Tomatoes y filtrado extra de seguridad</p>
                <input type="text" id="omdbKey" placeholder="ej: ab12cd34..." autocomplete="off">
                <a class="api-link" href="https://www.omdbapi.com/apikey.aspx" target="_blank">📎 Obtener key gratis en omdbapi.com</a>
                <p class="error-msg" id="omdbError"></p>
                <p class="testing" id="omdbTesting">⏳ Verificando key...</p>
            </div>

            <button class="btn-generate" id="btnGenerate" onclick="generateUrl()">
                🚀 Generar URL de instalación
            </button>

            <div id="result">
                <div class="result-card">
                    <h3>✅ ¡Tu addon está listo!</h3>
                    <div class="url-box" id="generatedUrl"></div>
                    <div class="btn-row">
                        <a class="btn-action btn-install" id="btnInstall" href="#">
                            📥 Instalar en Stremio
                        </a>
                        <button class="btn-action btn-copy" id="btnCopy" onclick="copyUrl()">
                            📋 Copiar URL
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <div class="card">
            <h2>🛡️ Seguridad infantil</h2>
            <p style="color:#666;font-size:0.92em;margin-bottom:15px;">
                KidsFlix usa 5 niveles de filtrado para garantizar que solo se muestre contenido apropiado:
            </p>
            <div class="features-grid">
                <div class="feature-item"><span>🔒</span> Flag de contenido adulto</div>
                <div class="feature-item"><span>🎭</span> Filtrado por géneros</div>
                <div class="feature-item"><span>📝</span> Análisis de descripción</div>
                <div class="feature-item"><span>📋</span> Certificaciones TMDB</div>
                <div class="feature-item"><span>⭐</span> Rating OMDB</div>
                <div class="feature-item"><span>🏰</span> Disney, Pixar, Ghibli...</div>
                <div class="feature-item"><span>🎨</span> Animación y familia</div>
                <div class="feature-item"><span>🇪🇸</span> Catálogo en español</div>
            </div>
        </div>

        <div class="card">
            <h2>❓ ¿Cómo obtengo las API keys?</h2>
            <div style="color:#555;font-size:0.92em;line-height:1.7;">
                <p><strong>TMDB (obligatoria):</strong></p>
                <ol style="margin-left:20px;margin-bottom:15px;">
                    <li>Ve a <a href="https://www.themoviedb.org/signup" target="_blank" style="color:#667eea">themoviedb.org</a> y crea una cuenta gratis</li>
                    <li>Ve a Ajustes → API</li>
                    <li>Solicita una API key (tipo: Desarrollador)</li>
                    <li>Copia la "API Key (v3 auth)"</li>
                </ol>
                <p><strong>OMDB (opcional pero recomendada):</strong></p>
                <ol style="margin-left:20px;">
                    <li>Ve a <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" style="color:#667eea">omdbapi.com</a></li>
                    <li>Selecciona "Free" (1,000 requests/día)</li>
                    <li>Ingresa tu email y recibirás la key</li>
                </ol>
            </div>
        </div>

        <p style="text-align:center;color:rgba(255,255,255,0.6);padding:20px;font-size:0.85em;">
            KidsFlix v2.0 — Tus API keys se codifican en la URL y nunca se almacenan en ningún servidor.
        </p>
    </div>

    <script>
        var BASE_URL = '${baseUrl}';

        async function testTmdbKey(key) {
            try {
                var r = await fetch('https://api.themoviedb.org/3/movie/550?api_key=' + key);
                return r.ok;
            } catch (e) { return false; }
        }

        async function testOmdbKey(key) {
            try {
                var r = await fetch('https://www.omdbapi.com/?i=tt0120338&apikey=' + key);
                if (!r.ok) return false;
                var data = await r.json();
                return data.Response !== 'False';
            } catch (e) { return false; }
        }

        async function generateUrl() {
            var tmdbKey = document.getElementById('tmdbKey').value.trim();
            var omdbKey = document.getElementById('omdbKey').value.trim();
            var btn = document.getElementById('btnGenerate');
            var tmdbError = document.getElementById('tmdbError');
            var omdbError = document.getElementById('omdbError');
            var tmdbTesting = document.getElementById('tmdbTesting');
            var omdbTesting = document.getElementById('omdbTesting');

            // Reset
            tmdbError.style.display = 'none';
            omdbError.style.display = 'none';
            document.getElementById('tmdbKey').classList.remove('error');
            document.getElementById('omdbKey').classList.remove('error');
            document.getElementById('result').style.display = 'none';

            if (!tmdbKey) {
                tmdbError.textContent = '⚠️ La API key de TMDB es obligatoria';
                tmdbError.style.display = 'block';
                document.getElementById('tmdbKey').classList.add('error');
                return;
            }

            btn.disabled = true;
            btn.textContent = '⏳ Verificando API keys...';

            // Test TMDB
            tmdbTesting.classList.add('active');
            var tmdbOk = await testTmdbKey(tmdbKey);
            tmdbTesting.classList.remove('active');

            if (!tmdbOk) {
                tmdbError.textContent = '❌ API key de TMDB inválida. Verifica que sea correcta.';
                tmdbError.style.display = 'block';
                document.getElementById('tmdbKey').classList.add('error');
                btn.disabled = false;
                btn.textContent = '🚀 Generar URL de instalación';
                return;
            }

            // Test OMDB si fue proporcionada
            if (omdbKey) {
                omdbTesting.classList.add('active');
                var omdbOk = await testOmdbKey(omdbKey);
                omdbTesting.classList.remove('active');

                if (!omdbOk) {
                    omdbError.textContent = '❌ API key de OMDB inválida. Puedes dejarla vacía y continuar.';
                    omdbError.style.display = 'block';
                    document.getElementById('omdbKey').classList.add('error');
                    btn.disabled = false;
                    btn.textContent = '🚀 Generar URL de instalación';
                    return;
                }
            }

            // Generar config codificada
            var config = { tmdbKey: tmdbKey };
            if (omdbKey) config.omdbKey = omdbKey;

            var encoded = btoa(JSON.stringify(config))
                .replace(/\\+/g, '-')
                .replace(/\\//g, '_')
                .replace(/=+$/, '');

            var manifestUrl = BASE_URL + '/' + encoded + '/manifest.json';
            var stremioUrl = 'stremio://' + manifestUrl.replace(/^https?:\\/\\//, '');

            document.getElementById('generatedUrl').textContent = manifestUrl;
            document.getElementById('btnInstall').href = stremioUrl;
            document.getElementById('result').style.display = 'block';

            btn.disabled = false;
            btn.textContent = '🚀 Generar URL de instalación';

            // Scroll al resultado
            document.getElementById('result').scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        function copyUrl() {
            var url = document.getElementById('generatedUrl').textContent;
            navigator.clipboard.writeText(url).then(function() {
                var btn = document.getElementById('btnCopy');
                btn.classList.add('copied');
                btn.textContent = '✅ ¡Copiada!';
                setTimeout(function() {
                    btn.classList.remove('copied');
                    btn.textContent = '📋 Copiar URL';
                }, 2000);
            });
        }

        // Enter key support
        document.getElementById('tmdbKey').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') document.getElementById('omdbKey').focus();
        });
        document.getElementById('omdbKey').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') generateUrl();
        });
    </script>
</body>
</html>`);
});

// =====================================================
// VALIDAR CONFIGURACION VIA API
// =====================================================
app.get('/validate-keys', async function (req, res) {
    var tmdbKey = req.query.tmdb;
    var omdbKey = req.query.omdb;
    var result = { tmdb: false, omdb: false };

    if (tmdbKey) {
        try {
            var r = await axios.get('https://api.themoviedb.org/3/movie/550?api_key=' + tmdbKey, { timeout: 5000 });
            result.tmdb = r.status === 200;
        } catch (e) { result.tmdb = false; }
    }

    if (omdbKey) {
        try {
            var r2 = await axios.get('https://www.omdbapi.com/?i=tt0120338&apikey=' + omdbKey, { timeout: 5000 });
            result.omdb = r2.data && r2.data.Response !== 'False';
        } catch (e) { result.omdb = false; }
    }

    res.json(result);
});

// =====================================================
// CATALOGO DE STREMIO
// =====================================================
var CATALOGS_DEFINITION = [
    { type: 'movie', id: 'kf_trending', name: '🌟 Populares para niños' },
    { type: 'movie', id: 'kf_popular_movies', name: '⭐ Películas familiares' },
    { type: 'movie', id: 'kf_top_movies', name: '🏆 Mejor valoradas' },
    { type: 'movie', id: 'kf_new_releases', name: '🆕 Nuevos estrenos' },
    { type: 'movie', id: 'kf_animation', name: '🎨 Animación' },
    { type: 'movie', id: 'kf_adventure', name: '🗺️ Aventuras' },
    { type: 'movie', id: 'kf_comedy', name: '😂 Comedias familiares' },
    { type: 'movie', id: 'kf_fantasy', name: '✨ Fantasía' },
    { type: 'movie', id: 'kf_musical', name: '🎵 Musicales' },
    { type: 'movie', id: 'kf_disney', name: '🏰 Disney' },
    { type: 'movie', id: 'kf_pixar', name: '🎯 Pixar' },
    { type: 'movie', id: 'kf_dreamworks', name: '🌙 DreamWorks' },
    { type: 'movie', id: 'kf_illumination', name: '💡 Illumination' },
    { type: 'movie', id: 'kf_ghibli', name: '🍃 Studio Ghibli' },
    { type: 'movie', id: 'kf_anime_movies', name: '🇯🇵 Anime infantil' },
    { type: 'movie', id: 'kf_spanish_kids', name: '🇪🇸 Películas en español' },
    { type: 'movie', id: 'kf_classics', name: '📼 Clásicos infantiles' },
    { type: 'movie', id: 'kf_docs_kids', name: '🔬 Documentales para niños' },
    {
        type: 'movie', id: 'kf_movies', name: '🎬 Buscar películas',
        extra: [{ name: "skip" }, { name: "search" }, { name: "genre", options: Object.keys(KIDS_GENRES_MOVIE) }]
    },
    { type: 'series', id: 'kf_trending_series', name: '🌟 Series populares' },
    { type: 'series', id: 'kf_popular_series', name: '⭐ Series para niños' },
    { type: 'series', id: 'kf_top_series', name: '🏆 Mejor valoradas' },
    { type: 'series', id: 'kf_new_series', name: '🆕 Nuevas series' },
    { type: 'series', id: 'kf_animated_series', name: '🎨 Series animadas' },
    { type: 'series', id: 'kf_family_series', name: '👨‍👩‍👧‍👦 Series familiares' },
    { type: 'series', id: 'kf_adventure_series', name: '🗺️ Aventuras' },
    { type: 'series', id: 'kf_comedy_series', name: '😂 Comedias' },
    { type: 'series', id: 'kf_scifi_series', name: '🚀 Ciencia ficción' },
    { type: 'series', id: 'kf_anime_series', name: '🇯🇵 Anime infantil' },
    { type: 'series', id: 'kf_spanish_series', name: '🇪🇸 Series en español' },
    { type: 'series', id: 'kf_educational', name: '📚 Educativas' },
    { type: 'series', id: 'kf_preschool', name: '🧒 Preescolar' },
    { type: 'series', id: 'kf_classic_series', name: '📼 Clásicos' },
    {
        type: 'series', id: 'kf_series', name: '🔍 Buscar series',
        extra: [{ name: "skip" }, { name: "search" }, { name: "genre", options: Object.keys(KIDS_GENRES_TV) }]
    }
];

// =====================================================
// MANIFEST CON CONFIG
// =====================================================
app.get('/:config/manifest.json', extractConfig, function (req, res) {
    if (!req.userConfig) return res.status(400).json({ error: 'Configuración inválida' });

    res.json({
        id: 'org.kidsflix.stremio',
        version: '2.0.0',
        name: 'KidsFlix',
        description: 'Catálogo infantil seguro. Solo contenido apropiado para niños con filtrado multinivel.',
        logo: 'https://img.icons8.com/color/512/children.png',
        resources: ['catalog', 'meta'],
        types: ['movie', 'series'],
        idPrefixes: ['tt'],
        behaviorHints: { adult: false, p2p: false },
        catalogs: CATALOGS_DEFINITION
    });
});

// =====================================================
// CATALOG CON CONFIG
// =====================================================
app.get('/:config/catalog/:type/:id.json', extractConfig, handleCatalog);
app.get('/:config/catalog/:type/:id/:extra.json', extractConfig, handleCatalog);

async function handleCatalog(req, res) {
    if (!req.userConfig) return res.status(400).json({ error: 'Configuración inválida' });

    var tmdbKey = req.userConfig.tmdbKey;
    var omdbKey = req.userConfig.omdbKey || null;
    var type = req.params.type, id = req.params.id, extra = req.params.extra || '';
    var host = req.headers.host, protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    var skip = 0, search = null, filterValue = null;

    if (extra) {
        var p = new URLSearchParams(extra.replace('.json', ''));
        skip = parseInt(p.get('skip')) || 0;
        search = p.get('search');
        filterValue = p.get('genre');
    }

    var catalogCacheKey = 'cat:' + type + ':' + id + ':' + skip + ':' + (search || '') + ':' + (filterValue || '');
    var cachedCatalog = cacheGet(catalogCacheKey);
    if (cachedCatalog) {
        res.setHeader('Cache-Control', 'public, max-age=1800');
        return res.json(cachedCatalog);
    }

    try {
        var imdbIds = [], page = Math.floor(skip / 20) + 1;

        if (search) {
            var dType = type === 'movie' ? 'movie' : 'tv';
            var r = await safeTmdb('search/' + dType + '?query=' + encodeURIComponent(search) + '&page=' + page, tmdbKey);
            if (r && r.results && r.results.length > 0) {
                var filtered = [];
                for (var si = 0; si < r.results.length; si++) {
                    var item = r.results[si];
                    if (item.adult === true) continue;
                    var genreIds = item.genre_ids || [];
                    var blocked = false;
                    for (var gi = 0; gi < genreIds.length; gi++) {
                        if (BLOCKED_GENRE_IDS.indexOf(genreIds[gi]) !== -1) { blocked = true; break; }
                    }
                    if (blocked) continue;
                    if (checkDescription(item.overview || '') === 'blocked') continue;
                    filtered.push(item);
                }

                var exts = await Promise.all(filtered.map(function (i) {
                    return safeTmdb(dType + '/' + i.id + '/external_ids', tmdbKey).catch(function () { return null; });
                }));

                for (var ei = 0; ei < filtered.length; ei++) {
                    var ext = exts[ei];
                    var imId = ext ? ext.imdb_id : null;
                    if (!imId || !imId.startsWith('tt')) continue;
                    var safe = await isKidsSafe(filtered[ei], filtered[ei].id, dType, imId, tmdbKey, omdbKey);
                    if (safe) imdbIds.push(imId);
                }
            }
        } else if (filterValue) {
            var dType2 = type === 'movie' ? 'movie' : 'tv';
            var url2 = 'discover/' + dType2 + '?sort_by=popularity.desc&page=' + page;
            if (dType2 === 'movie') url2 += '&certification_country=US&certification.lte=PG';
            var gid = type === 'movie' ? KIDS_GENRES_MOVIE[filterValue] : KIDS_GENRES_TV[filterValue];
            if (gid) url2 += '&with_genres=' + gid;
            if (dType2 === 'tv') url2 += (gid ? ',' : '&with_genres=') + '10762';
            var result = await tmdbToImdbFiltered(url2, dType2, tmdbKey, omdbKey);
            imdbIds = result.ids;
        } else {
            var endpoint = getCatalogEndpoint(id, page);
            if (endpoint) {
                var result2 = await tmdbToImdbFiltered(endpoint.url, endpoint.mediaType, tmdbKey, omdbKey);
                imdbIds = result2.ids;
            }
        }

        if (imdbIds.length === 0) return res.json({ metas: [] });

        var metas = await buildMetas(imdbIds, type, host, protocol, tmdbKey, omdbKey);
        var response = { metas: metas };
        cacheSet(catalogCacheKey, response, CACHE_TTL.catalog);
        res.setHeader('Cache-Control', 'public, max-age=1800');
        return res.json(response);
    } catch (e) {
        console.error('[CATALOG ERROR]', e.message);
        return res.json({ metas: [] });
    }
}

// =====================================================
// META CON CONFIG
// =====================================================
app.get('/:config/meta/:type/:id.json', extractConfig, async function (req, res) {
    if (!req.userConfig) return res.status(400).json({ error: 'Configuración inválida' });

    var tmdbKey = req.userConfig.tmdbKey;
    var omdbKey = req.userConfig.omdbKey || null;
    var id = req.params.id.replace('.json', ''), type = req.params.type, start = Date.now();

    var results = await Promise.all([
        safeTmdb('find/' + id + '?external_source=imdb_id', tmdbKey),
        type === 'series' ? axios.get('https://v3-cinemeta.strem.io/meta/series/' + id + '.json', { timeout: 3000 })
            .then(function (r) { return r.data ? r.data.meta : null; }).catch(function () { return null; }) : Promise.resolve(null),
        safeOmdb(id, omdbKey)
    ]);

    var find = results[0], cmData = results[1], omdb = results[2] || {};

    var tmdb = null, tmdbType = 'tv';
    if (find) {
        var tv = find.tv_results ? find.tv_results[0] : null;
        var mv = find.movie_results ? find.movie_results[0] : null;
        if (type === 'series') { tmdb = tv || mv; tmdbType = tv ? 'tv' : 'movie'; }
        else { tmdb = mv || tv; tmdbType = mv ? 'movie' : 'tv'; }
    }

    if (!tmdb) {
        if (cmData) return res.json({ meta: cmData });
        return res.json({ meta: null });
    }

    var safe = await isKidsSafe(tmdb, tmdb.id, tmdbType, id, tmdbKey, omdbKey);
    if (!safe) {
        console.log('[META] BLOQUEADO: ' + (tmdb.name || tmdb.title));
        return res.json({ meta: null });
    }

    var detailResults = await Promise.all([
        safeTmdb(tmdbType + '/' + tmdb.id, tmdbKey),
        safeTmdb(tmdbType + '/' + tmdb.id + '/videos', tmdbKey),
        safeTmdb(tmdbType + '/' + tmdb.id + '/images?include_image_language=es,en,null', tmdbKey)
    ]);

    var det = detailResults[0], videosData = detailResults[1], imagesData = detailResults[2];

    var overview = '';
    if (det && det.overview) overview = det.overview;
    else if (tmdb.overview) overview = tmdb.overview;
    if (!overview) {
        var en = await safeTmdbEN(tmdbType + '/' + tmdb.id, tmdbKey);
        if (en && en.overview) overview = en.overview;
    }

    var rtVal = null;
    if (det) {
        if (det.runtime) rtVal = det.runtime;
        else if (det.episode_run_time && det.episode_run_time.length > 0) rtVal = det.episode_run_time[0];
        else if (det.last_episode_to_air && det.last_episode_to_air.runtime) rtVal = det.last_episode_to_air.runtime;
    }
    var runtime = formatRuntime(rtVal);

    var genres = det && det.genres ? det.genres.map(function (g) { return g.name; }) : [];

    var rating = null;
    if (omdb.imdbRating && omdb.imdbRating !== 'N/A') rating = omdb.imdbRating;
    else if (tmdb.vote_average > 0) rating = tmdb.vote_average.toFixed(1);

    var trailers = [];
    if (videosData && videosData.results) {
        var trailer = videosData.results.find(function (v) { return v.type === 'Trailer' && v.site === 'YouTube'; });
        if (!trailer) trailer = videosData.results.find(function (v) { return v.site === 'YouTube'; });
        if (trailer) trailers.push({ source: trailer.key, type: 'Trailer' });
    }

    var logoPath = null;
    if (imagesData && imagesData.logos && imagesData.logos.length > 0) logoPath = imagesData.logos[0].file_path;

    var name = '';
    if (det) name = det.title || det.name || '';
    if (!name) name = tmdb.name || tmdb.title || '';

    var pp = (det ? det.poster_path : null) || tmdb.poster_path;
    var bd = (det ? det.backdrop_path : null) || tmdb.backdrop_path;
    var date = '';
    if (det) date = det.first_air_date || det.release_date || '';
    if (!date) date = tmdb.first_air_date || tmdb.release_date || '';

    var ageIndicator = '';
    var omdbRated = omdb.Rated || '';
    if (omdbRated && omdbRated !== 'N/A') ageIndicator = '📋 Clasificación: ' + omdbRated + '\n\n';

    var meta = {
        id: id, type: type, name: name,
        poster: pp ? 'https://image.tmdb.org/t/p/w500' + pp : null,
        background: bd ? 'https://image.tmdb.org/t/p/original' + bd : null,
        logo: logoPath ? 'https://image.tmdb.org/t/p/w500' + logoPath : null,
        description: ageIndicator + overview,
        releaseInfo: date ? date.substring(0, 4) : "",
        imdbRating: rating, runtime: runtime, genres: genres
    };

    if (trailers.length > 0) meta.trailers = trailers;

    if (type === 'series') {
        var videos = cmData ? (cmData.videos || []) : [];
        if (videos.length === 0 && tmdbType === 'tv') {
            var show = (det && det.seasons) ? det : await safeTmdb('tv/' + tmdb.id, tmdbKey);
            if (show && show.seasons) {
                for (var si = 0; si < show.seasons.length; si++) {
                    var se = show.seasons[si];
                    if (se.season_number === 0) continue;
                    for (var ei = 1; ei <= se.episode_count; ei++) {
                        videos.push({
                            id: id + ':' + se.season_number + ':' + ei,
                            season: se.season_number, episode: ei,
                            title: 'Episodio ' + ei,
                            released: se.air_date ? new Date(se.air_date).toISOString() : new Date().toISOString()
                        });
                    }
                }
            }
        }

        if (videos.length > 0 && tmdb.id && tmdbType === 'tv') {
            var seasonNums = [], seen = {};
            for (var vi = 0; vi < videos.length; vi++) {
                var sn = videos[vi].season;
                if (sn !== undefined && !seen[sn]) { seen[sn] = true; seasonNums.push(sn); }
            }
            seasonNums = seasonNums.slice(0, 10);
            var seasonData = await Promise.all(seasonNums.map(function (s) {
                return safeTmdb('tv/' + tmdb.id + '/season/' + s, tmdbKey);
            }));
            for (var vi2 = 0; vi2 < videos.length; vi2++) {
                var v = videos[vi2];
                for (var sdi = 0; sdi < seasonData.length; sdi++) {
                    var sd = seasonData[sdi];
                    if (!sd || sd.season_number !== v.season) continue;
                    if (!sd.episodes) continue;
                    for (var epi = 0; epi < sd.episodes.length; epi++) {
                        var ep = sd.episodes[epi];
                        if (ep.episode_number === v.episode) {
                            if (ep.name) v.title = ep.name;
                            if (ep.overview) v.overview = ep.overview;
                            if (ep.still_path) v.thumbnail = 'https://image.tmdb.org/t/p/w400' + ep.still_path;
                            if (ep.air_date) v.released = new Date(ep.air_date).toISOString();
                            break;
                        }
                    }
                    break;
                }
            }
        }
        if (videos.length > 0) meta.videos = videos;
    }

    console.log('[META] ' + (Date.now() - start) + 'ms "' + name + '" ✅');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.json({ meta: meta });
});

// =====================================================
// POSTER (sin config necesaria)
// =====================================================
app.get('/poster/:id.jpg', async function (req, res) {
    var url = req.query.url, imdb = req.query.imdb, rt = req.query.rt, runtime = req.query.runtime;
    if (!url || url === 'undefined') return res.redirect('https://via.placeholder.com/500x750?text=KidsFlix');

    var img = await drawPoster(
        decodeURIComponent(url),
        { imdb: imdb || null, rt: rt || null },
        runtime ? decodeURIComponent(runtime) : null
    );

    if (img) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, s-maxage=604800, immutable');
        return res.send(img);
    }
    res.redirect(decodeURIComponent(url));
});

// =====================================================
// STATUS
// =====================================================
app.get('/status', function (req, res) {
    var keys = Object.keys(cache), now = Date.now(), active = 0;
    for (var i = 0; i < keys.length; i++) {
        if (cache[keys[i]].expires > now) active++;
    }
    res.json({
        name: 'KidsFlix',
        version: '2.0.0',
        mode: 'per-user-config',
        cacheEntries: keys.length,
        activeEntries: active,
        filtering: {
            levels: 5,
            blockedGenres: BLOCKED_GENRE_IDS.length,
            blockedKeywords: BLOCKED_KEYWORDS.length,
            certificationCountries: Object.keys(ALLOWED_CERTIFICATIONS).length
        }
    });
});

// =====================================================
// TEST DE FILTRADO
// =====================================================
app.get('/:config/test-filter/:imdbId', extractConfig, async function (req, res) {
    if (!req.userConfig) return res.status(400).json({ error: 'Configuración inválida' });

    var tmdbKey = req.userConfig.tmdbKey;
    var omdbKey = req.userConfig.omdbKey || null;
    var imdbId = req.params.imdbId;
    var start = Date.now();

    try {
        var find = await safeTmdb('find/' + imdbId + '?external_source=imdb_id', tmdbKey);
        if (!find) return res.json({ error: 'No encontrado en TMDB' });

        var tv = find.tv_results ? find.tv_results[0] : null;
        var mv = find.movie_results ? find.movie_results[0] : null;
        var tmdb = mv || tv;
        var mediaType = mv ? 'movie' : 'tv';

        if (!tmdb) return res.json({ error: 'Sin resultados' });

        var omdb = await safeOmdb(imdbId, omdbKey);
        var genreIds = tmdb.genre_ids || [];
        var certCheck = await checkTmdbCertification(tmdb.id, mediaType, tmdbKey);
        var finalResult = await isKidsSafe(tmdb, tmdb.id, mediaType, imdbId, tmdbKey, omdbKey);

        res.json({
            time: (Date.now() - start) + 'ms',
            title: tmdb.title || tmdb.name,
            mediaType: mediaType,
            genreIds: genreIds,
            omdbRated: omdb.Rated || 'N/A',
            checks: {
                adultFlag: checkAdultFlag(tmdb),
                genres: checkGenres(genreIds),
                description: checkDescription(tmdb.overview || ''),
                certification: certCheck,
                omdbRating: checkOmdbRating(omdb),
                result: finalResult ? '✅ SEGURO' : '❌ BLOQUEADO'
            }
        });
    } catch (e) { res.json({ error: e.message }); }
});

// =====================================================
// INICIAR SERVIDOR
// =====================================================
var PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
    console.log('🧸 KidsFlix v2.0 con panel de configuración');
    console.log('🌐 http://localhost:' + PORT + '/configure');
    console.log('🛡️ 5 niveles de filtrado activos');
});

module.exports = app;
