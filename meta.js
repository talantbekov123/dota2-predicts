const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://api.opendota.com/api';
const MATCH_CACHE_PATH = path.join(__dirname, 'matches-cache.json');

// Небольшая пауза между запросами, чтобы не упереться в rate limit (60 req/min на free-тарифе)
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

/**
 * Берёт матч из файла-кэша или запрашивает API и сохраняет результат.
 * @returns {Promise<{ match: object, fromCache: boolean }>}
 */
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
 * Считает винрейт героев по матчам одной или нескольких лиг.
 * Все матчи пишутся в общий matches-cache.json.
 *
 * @param {number|string|Array<number|string>} leagueIds - ID турнира или массив ID
 * @param {object} [options]
 * @param {number} [options.delayMs=1000] - пауза между запросами к /matches/{id}
 * @param {boolean} [options.withNames=true] - подтягивать ли имена героев
 * @returns {Promise<Object>} объект { [hero_id]: { name, picks, wins, winrate } }
 */
async function getTournamentHeroWinrates(leagueIds, options = {}) {
  const { delayMs = 1000, withNames = true } = options;
  const ids = (Array.isArray(leagueIds) ? leagueIds : [leagueIds]).map(Number);

  if (ids.length === 0) {
    throw new Error('Передай хотя бы один leagueId');
  }

  // 1. Собираем match_id по всем лигам (уникальные)
  const matchIdSet = new Set();
  for (const leagueId of ids) {
    const matches = await fetchJson(`${BASE_URL}/leagues/${leagueId}/matches`);
    console.log(`Лига ${leagueId}: найдено матчей ${matches.length}`);
    for (const m of matches) matchIdSet.add(m.match_id);
    await delay(delayMs);
  }

  const matchIds = [...matchIdSet];
  console.log(`Всего уникальных матчей: ${matchIds.length}`);

  // 2. Опционально получаем словарь hero_id -> имя
  let heroMap = {};
  if (withNames) {
    const heroes = await fetchJson(`${BASE_URL}/heroes`);
    heroMap = Object.fromEntries(heroes.map(h => [h.id, h.localized_name]));
  }

  // 3. Собираем статистику по каждому матчу (один общий кэш на все лиги)
  const cache = loadMatchCache();
  const stats = {}; // { hero_id: { picks, wins } }

  for (let i = 0; i < matchIds.length; i++) {
    const matchId = matchIds[i];

    try {
      const { match, fromCache } = await getMatch(matchId, cache);
      const radiantWin = match.radiant_win;
      const picksBans = match.picks_bans || [];

      for (const pb of picksBans) {
        if (!pb.is_pick) continue; // нас интересуют только пики, не баны

        const heroId = pb.hero_id;
        const team = pb.team; // 0 = radiant, 1 = dire
        const won = (team === 0 && radiantWin) || (team === 1 && !radiantWin);

        if (!stats[heroId]) {
          stats[heroId] = { picks: 0, wins: 0 };
        }

        stats[heroId].picks += 1;
        if (won) stats[heroId].wins += 1;
      }

      const source = fromCache ? 'кэш' : 'API';
      console.log(`[${i + 1}/${matchIds.length}] Обработан матч ${matchId} (${source})`);

      // Пауза только после реального запроса к API
      if (!fromCache && i < matchIds.length - 1) {
        await delay(delayMs);
      }
    } catch (err) {
      console.error(`Ошибка при обработке матча ${matchId}:`, err.message);
      if (i < matchIds.length - 1) {
        await delay(delayMs);
      }
    }
  }

  // 4. Формируем финальный объект с винрейтом
  const result = {};
  for (const [heroId, { picks, wins }] of Object.entries(stats)) {
    result[heroId] = {
      name: heroMap[heroId] || `Unknown(${heroId})`,
      picks,
      wins,
      winrate: picks > 0 ? Number(((wins / picks) * 100).toFixed(1)) : 0,
    };
  }

  return result;
}

// Пример использования
(async () => {
  // Заполни массив нужными лигами — кэш общий для всех
  const leagueIds = [
    19785, // EWC 2026
    20009, // 1win essence
    19719, // International 2026
  ];

  const winrates = await getTournamentHeroWinrates(leagueIds);

  // Сортируем по числу пиков для удобного вывода
  const sorted = Object.values(winrates).sort((a, b) => b.picks - a.picks);

  console.table(sorted);

  // Или просто вывести весь объект
  // console.log(JSON.stringify(winrates, null, 2));
})();
