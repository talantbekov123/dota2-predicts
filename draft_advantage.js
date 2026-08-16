/**
 * draft-advantage.js
 *
 * Считает суммарное преимущество одной команды над другой на основе
 * counter-pick winrate из OpenDota API (эндпоинт /heroes/{id}/matchups).
 *
 * Логика:
 *  - Для каждого героя команды A смотрим, как он исторически играет
 *    против каждого героя команды B (winrate этого героя в матчах,
 *    где он оппонировал конкретному герою).
 *  - Разница (winrate - 50%) для пары (a, b) — это "преимущество" a над b.
 *  - Суммируем такие разницы по всем 25 парам (5x5) с обеих сторон
 *    (перспектива A vs B и перспектива B vs A) и усредняем —
 *    так получаем более устойчивую оценку, т.к. выборки у разных
 *    героев разного размера (games_played).
 *
 * Ограничение: OpenDota не даёт готовый публичный эндпоинт синергии
 * героев внутри одной команды, поэтому синергия здесь не считается —
 * только counter-pick составляющая.
 *
 * Запуск: node draft-advantage.js
 * Требования: Node.js 18+ (использует встроенный fetch)
 */

const OPENDOTA_BASE = "https://api.opendota.com/api";

// ==== Составы команд — строки npc_dota_hero_* из OpenDota ====
const team1Names = [
    "npc_dota_hero_dark_seer",
    "npc_dota_hero_undying",
    "npc_dota_hero_naga_siren",
    "npc_dota_hero_furion",
    "npc_dota_hero_earthshaker"
];
const team2Names = [
    "npc_dota_hero_nevermore",
    "npc_dota_hero_rattletrap",
    "npc_dota_hero_winter_wyvern",
    "npc_dota_hero_shredder",
    "npc_dota_hero_kez"
];

// Небольшая задержка между запросами, чтобы не упереться в rate limit
const DELAY_MS = 150;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Запрос ${url} завершился со статусом ${res.status}`);
  }
  return res.json();
}

// Загружаем полный список героев (id <-> имя).
// Индексируем и по localized_name ("Sven"), и по внутреннему name ("npc_dota_hero_sven"),
// чтобы resolveHeroId понимал оба формата.
async function loadHeroMap() {
  const heroes = await fetchJson(`${OPENDOTA_BASE}/heroes`);
  const byName = new Map();
  const byId = new Map();
  for (const h of heroes) {
    byName.set(h.localized_name.toLowerCase(), h.id);
    byName.set(h.name.toLowerCase(), h.id); // npc_dota_hero_*
    byId.set(h.id, h.localized_name);
  }
  return { byName, byId };
}

// Находим id героя по имени. Поддерживает:
//  - localized_name ("Sven", "Spirit Breaker")
//  - внутренний name ("npc_dota_hero_sven")
//  - мягкий частичный поиск ("void" -> "faceless void")
function resolveHeroId(name, byName) {
  const key = name.toLowerCase();
  if (byName.has(key)) return byName.get(key);

  // fallback: если передали "npc_dota_hero_spirit_breaker" без точного совпадения
  const stripped = key.replace(/^npc_dota_hero_/, "").replace(/_/g, " ");
  if (byName.has(stripped)) return byName.get(stripped);

  // fallback: частичное совпадение по подстроке
  for (const [heroName, id] of byName.entries()) {
    if (heroName.includes(key) || key.includes(heroName)) {
      return id;
    }
  }
  throw new Error(`Не удалось найти героя с именем "${name}"`);
}

// Получаем matchups конкретного героя
async function getMatchups(heroId) {
  return fetchJson(`${OPENDOTA_BASE}/heroes/${heroId}/matchups`);
}

// Достаём винрейт героя A против героя B из его matchups-списка
function getWinrateVs(matchups, opponentId) {
  const entry = matchups.find((m) => m.hero_id === opponentId);
  if (!entry || entry.games_played === 0) return null;
  return {
    winrate: entry.wins / entry.games_played,
    games: entry.games_played,
  };
}

async function computeDraftAdvantage(team1Names, team2Names) {
  const { byName, byId } = await loadHeroMap();

  const team1Ids = team1Names.map((n) => resolveHeroId(n, byName));
  const team2Ids = team2Names.map((n) => resolveHeroId(n, byName));

  // Кэшируем matchups, чтобы не дёргать API дважды за одного героя
  const matchupsCache = new Map();
  const getCachedMatchups = async (heroId) => {
    if (!matchupsCache.has(heroId)) {
      const data = await getMatchups(heroId);
      matchupsCache.set(heroId, data);
      await sleep(DELAY_MS);
    }
    return matchupsCache.get(heroId);
  };

  let totalAdvantageTeam1 = 0; // положительное = в пользу команды 1
  let pairsCounted = 0;
  const pairDetails = [];

  for (const a of team1Ids) {
    const matchupsA = await getCachedMatchups(a);
    for (const b of team2Ids) {
      const matchupsB = await getCachedMatchups(b);

      const aVsB = getWinrateVs(matchupsA, b); // винрейт A против B
      const bVsA = getWinrateVs(matchupsB, a); // винрейт B против A

      // Берём обе перспективы и усредняем разницу с 50%,
      // чтобы сгладить шум малых выборок
      let pairAdvantage = 0;
      let samples = 0;

      if (aVsB) {
        pairAdvantage += (aVsB.winrate - 0.5);
        samples++;
      }
      if (bVsA) {
        // если B выигрывает у A в X% случаев, то это в пользу B,
        // то есть в пользу команды 1 идёт (0.5 - winrate_bVsA)
        pairAdvantage += (0.5 - bVsA.winrate);
        samples++;
      }

      if (samples > 0) {
        pairAdvantage /= samples;
        totalAdvantageTeam1 += pairAdvantage;
        pairsCounted++;

        pairDetails.push({
          heroA: byId.get(a),
          heroB: byId.get(b),
          advantagePct: (pairAdvantage * 100).toFixed(2),
          samplesGames: (aVsB?.games || 0) + (bVsA?.games || 0),
        });
      }
    }
  }

  return {
    team1Ids,
    team2Ids,
    byId,
    totalAdvantageTeam1,
    pairsCounted,
    pairDetails,
  };
}

function buildReport(result, team1Names, team2Names) {
  const { totalAdvantageTeam1, pairsCounted, pairDetails } = result;
  const avgAdvantage = pairsCounted > 0 ? (totalAdvantageTeam1 / pairsCounted) * 100 : 0;

  let favoredTeam;
  if (avgAdvantage > 1) {
    favoredTeam = "team1";
  } else if (avgAdvantage < -1) {
    favoredTeam = "team2";
  } else {
    favoredTeam = "even";
  }

  return {
    team1: team1Names,
    team2: team2Names,
    pairs: pairDetails.map((p) => ({
      heroA: p.heroA,
      heroB: p.heroB,
      advantagePct: Number(p.advantagePct),
      sampleGames: p.samplesGames,
    })),
    pairsCounted,
    pairsPossible: team1Names.length * team2Names.length,
    avgAdvantagePct: Number(avgAdvantage.toFixed(2)),
    favoredTeam,
  };
}

/**
 * Основная функция: считает draft advantage и возвращает результат в виде JSON-строки.
 * @param {string[]} team1 - имена героев команды 1
 * @param {string[]} team2 - имена героев команды 2
 * @returns {Promise<string>} JSON-строка с отчётом
 */
async function getDraftAdvantageJson(team1, team2) {
  try {
    const result = await computeDraftAdvantage(team1, team2);
    const report = buildReport(result, team1, team2);
    return JSON.stringify(report, null, 2);
  } catch (err) {
    return JSON.stringify({ error: err.message }, null, 2);
  }
}

module.exports = { getDraftAdvantageJson, computeDraftAdvantage, buildReport };

// Пример запуска напрямую: node draft-advantage.js
if (require.main === module) {
  (async () => {
    const json = await getDraftAdvantageJson(team1Names, team2Names);
    console.log(json);
  })();
}