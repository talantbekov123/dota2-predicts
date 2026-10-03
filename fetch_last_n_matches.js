const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://api.opendota.com/api';
const MATCH_CACHE_PATH = path.join(__dirname, 'matches-cache.json');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed: ${url} (status ${res.status})`);
  }
  return res.json();
}

function loadMatchCache() {
  try {
    if (!fs.existsSync(MATCH_CACHE_PATH)) return {};
    return JSON.parse(fs.readFileSync(MATCH_CACHE_PATH, 'utf8'));
  } catch {
    console.warn('Не удалось прочитать кэш матчей, начинаем с пустого');
    return {};
  }
}

function saveMatchCache(cache) {
  fs.writeFileSync(MATCH_CACHE_PATH, JSON.stringify(cache), 'utf8');
}

async function getMatch(matchId, cache) {
  const key = String(matchId);
  if (cache[key]) {
    return { match: cache[key], fromCache: true };
  }

  const match = await fetchJson(`${BASE_URL}/matches/${matchId}`);
  cache[key] = match;
  saveMatchCache(cache);
  return { match, fromCache: false };
}

/**
 * По списку leagueId берёт последние n матчей каждой лиги и пишет в matches-cache.json.
 *
 * @param {number|string|Array<number|string>} leagueIds
 * @param {number} [n=20]
 * @param {object} [options]
 * @param {number} [options.delayMs=1000]
 */
async function fetchLastNMatches(leagueIds, n = 20, options = {}) {
  const { delayMs = 1000 } = options;
  const ids = (Array.isArray(leagueIds) ? leagueIds : [leagueIds]).map(Number);

  if (ids.length === 0) {
    throw new Error('Передай хотя бы один leagueId');
  }

  const cache = loadMatchCache();
  const matchIdSet = new Set();

  for (const leagueId of ids) {
    const matches = await fetchJson(`${BASE_URL}/leagues/${leagueId}/matches`);

    // OpenDota обычно отдаёт от новых к старым; на всякий случай сортируем по match_id desc
    const sorted = [...matches].sort((a, b) => b.match_id - a.match_id);
    const latest = sorted.slice(0, n);

    console.log(
      `Лига ${leagueId}: всего ${matches.length}, берём последние ${latest.length}`
    );

    for (const m of latest) matchIdSet.add(m.match_id);
    await delay(delayMs);
  }

  const matchIds = [...matchIdSet];
  console.log(`Всего уникальных матчей к загрузке: ${matchIds.length}`);

  let fetched = 0;
  let cached = 0;

  for (let i = 0; i < matchIds.length; i++) {
    const matchId = matchIds[i];
    try {
      const { fromCache } = await getMatch(matchId, cache);
      if (fromCache) cached += 1;
      else fetched += 1;

      console.log(
        `[${i + 1}/${matchIds.length}] ${matchId} (${fromCache ? 'кэш' : 'API'})`
      );

      if (!fromCache && i < matchIds.length - 1) {
        await delay(delayMs);
      }
    } catch (err) {
      console.error(`Ошибка матча ${matchId}:`, err.message);
      if (i < matchIds.length - 1) await delay(delayMs);
    }
  }

  return {
    leagueIds: ids,
    n,
    matchIds,
    fetched,
    cached,
    cacheSize: Object.keys(cache).length,
  };
}

function parseArgs(argv) {
  const leagueIds = [];
  let n = 20;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-n' || arg === '--n' || arg === '--limit') {
      const value = Number(argv[++i]);
      if (!value || value <= 0) {
        throw new Error(`Некорректный n после ${arg}`);
      }
      n = value;
      continue;
    }
    if (!/^\d+$/.test(arg)) {
      throw new Error(`Неизвестный аргумент: ${arg}`);
    }
    leagueIds.push(Number(arg));
  }

  return { leagueIds, n };
}

function printUsage() {
  console.log(`Usage:
  node fetch_last_n_matches.js <leagueId...> [-n <count>]

Examples:
  node fetch_last_n_matches.js 19785
  node fetch_last_n_matches.js 19785 20009
  node fetch_last_n_matches.js 19785 20009 -n 50`);
}

module.exports = { fetchLastNMatches };

if (require.main === module) {
  (async () => {
    let leagueIds;
    let n;

    try {
      ({ leagueIds, n } = parseArgs(process.argv.slice(2)));
    } catch (err) {
      console.error(err.message);
      printUsage();
      process.exit(1);
    }

    if (leagueIds.length === 0) {
      printUsage();
      process.exit(1);
    }

    const result = await fetchLastNMatches(leagueIds, n);
    console.log('\nГотово:');
    console.log(`лиги: ${result.leagueIds.join(', ')}`);
    console.log(`last n: ${result.n}`);
    console.log(`матчей: ${result.matchIds.length}`);
    console.log(`скачано с API: ${result.fetched}, из кэша: ${result.cached}`);
    console.log(`размер кэша: ${result.cacheSize}`);
  })().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
