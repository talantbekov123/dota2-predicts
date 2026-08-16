const fs = require('fs');
const path = require('path');

const MATCH_CACHE_PATH = path.join(__dirname, 'matches-cache.json');

let _matchCache = null;

function loadMatchCache() {
  if (_matchCache) return _matchCache;
  if (!fs.existsSync(MATCH_CACHE_PATH)) {
    throw new Error(`Кэш не найден: ${MATCH_CACHE_PATH}. Сначала запустите meta.js`);
  }
  _matchCache = JSON.parse(fs.readFileSync(MATCH_CACHE_PATH, 'utf8'));
  return _matchCache;
}

/** Нормализованный ключ пика (порядок героев не важен). */
function pickKey(heroIds) {
  if (!heroIds || heroIds.length === 0) return null;
  return [...heroIds].map(Number).sort((a, b) => a - b).join(',');
}

/**
 * Возвращает ключи пиков radiant/dire из матча.
 * @returns {{ radiant: string|null, dire: string|null }}
 */
function getMatchPickKeys(match) {
  const radiant = [];
  const dire = [];

  for (const pb of match.picks_bans || []) {
    if (!pb.is_pick) continue;
    if (pb.team === 0) radiant.push(pb.hero_id);
    else if (pb.team === 1) dire.push(pb.hero_id);
  }

  return {
    radiant: pickKey(radiant),
    dire: pickKey(dire),
  };
}

/**
 * Строит словарь винрейтов героев по матчам из кэша.
 * Матчи, где у radiant или dire был точно такой же пик как excludePickIds, пропускаются.
 *
 * @param {number[]} [excludePickIds] - состав, который нужно исключить (для бектеста)
 * @returns {{ winrates: Object, excludedMatches: number }}
 */
function buildHeroWinratesFromCache(excludePickIds = []) {
  const cache = loadMatchCache();
  const excludeKey = pickKey(excludePickIds);
  const stats = {};
  let excludedMatches = 0;

  for (const match of Object.values(cache)) {
    if (excludeKey) {
      const { radiant, dire } = getMatchPickKeys(match);
      if (radiant === excludeKey || dire === excludeKey) {
        excludedMatches += 1;
        continue;
      }
    }

    const radiantWin = match.radiant_win;
    const picksBans = match.picks_bans || [];

    for (const pb of picksBans) {
      if (!pb.is_pick) continue;

      const heroId = pb.hero_id;
      const team = pb.team; // 0 = radiant, 1 = dire
      const won = (team === 0 && radiantWin) || (team === 1 && !radiantWin);

      if (!stats[heroId]) {
        stats[heroId] = { picks: 0, wins: 0 };
      }

      stats[heroId].picks += 1;
      if (won) stats[heroId].wins += 1;
    }
  }

  const winrates = {};
  for (const [heroId, { picks, wins }] of Object.entries(stats)) {
    winrates[heroId] = {
      picks,
      wins,
      winrate: picks > 0 ? Number(((wins / picks) * 100).toFixed(1)) : 0,
    };
  }

  return { winrates, excludedMatches };
}

/**
 * Суммирует винрейты героев для двух составов.
 * Для каждой команды винрейты считаются отдельно: из данных исключаются
 * только матчи с точно таким же пиком этой команды (leave-one-out для бектеста).
 *
 * @param {number[]} team1Ids - массив hero_id первой команды
 * @param {number[]} team2Ids - массив hero_id второй команды
 * @returns {{
 *   team1: { heroes: Array, sumWinrate: number, excludedMatches: number },
 *   team2: { heroes: Array, sumWinrate: number, excludedMatches: number },
 * }}
 */
function sumTeamWinrates(team1Ids = [], team2Ids = []) {
  function sumForTeam(heroIds) {
    const { winrates, excludedMatches } = buildHeroWinratesFromCache(heroIds);

    const heroes = heroIds.map((id) => {
      const data = winrates[id] || winrates[String(id)];
      const picks = data?.picks ?? 0;
      const wins = data?.wins ?? 0;
      const rawWinrate = picks > 0 ? (data?.winrate ?? 0) : 0;
      // Нет пиков или winrate 0 → в сумму 50%, а не 0
      const winrate = picks === 0 || rawWinrate === 0 ? 50 : rawWinrate;

      return { heroId: id, picks, wins, winrate };
    });

    const sumWinrate = Number(
      heroes.reduce((acc, h) => acc + h.winrate, 0).toFixed(1)
    );

    return { heroes, sumWinrate, excludedMatches };
  }

  return {
    team1: sumForTeam(team1Ids),
    team2: sumForTeam(team2Ids),
  };
}

module.exports = {
  sumTeamWinrates,
  buildHeroWinratesFromCache,
  pickKey,
  getMatchPickKeys,
};

// Пример использования
if (require.main === module) {
  const result = sumTeamWinrates([107, 131, 54, 27, 55], [90, 96, 9, 106, 114]);

  console.log('Team 1 sum winrate:', result.team1.sumWinrate, `(исключено матчей: ${result.team1.excludedMatches})`);
  console.table(result.team1.heroes);

  console.log('Team 2 sum winrate:', result.team2.sumWinrate, `(исключено матчей: ${result.team2.excludedMatches})`);
  console.table(result.team2.heroes);
}
