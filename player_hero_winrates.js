const fs = require('fs');
const path = require('path');

const MATCH_CACHE_PATH = path.join(__dirname, 'matches-cache.json');
const BASE_URL = 'https://api.opendota.com/api';

let _matchCache = null;

function loadMatchCache() {
  if (_matchCache) return _matchCache;
  if (!fs.existsSync(MATCH_CACHE_PATH)) {
    throw new Error(`Кэш не найден: ${MATCH_CACHE_PATH}. Сначала запустите meta.js`);
  }
  _matchCache = JSON.parse(fs.readFileSync(MATCH_CACHE_PATH, 'utf8'));
  return _matchCache;
}

async function loadHeroNames() {
  try {
    const res = await fetch(`${BASE_URL}/heroes`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const heroes = await res.json();
    return Object.fromEntries(heroes.map((h) => [h.id, h.localized_name]));
  } catch {
    return {};
  }
}

/**
 * Индекс: account_id -> hero_id -> { picks, wins }
 * по всем матчам турнира в кэше.
 */
function buildPlayerHeroStats(excludeMatchId = null) {
  const cache = loadMatchCache();
  const stats = {};

  for (const match of Object.values(cache)) {
    if (excludeMatchId != null && Number(match.match_id) === Number(excludeMatchId)) {
      continue;
    }

    for (const player of match.players || []) {
      if (player.account_id == null || !player.hero_id) continue;

      const accountId = player.account_id;
      const heroId = player.hero_id;
      stats[accountId] ??= {};
      stats[accountId][heroId] ??= { picks: 0, wins: 0 };

      stats[accountId][heroId].picks += 1;
      if (player.win) stats[accountId][heroId].wins += 1;
    }
  }

  return stats;
}

function getPlayerHeroStat(stats, accountId, heroId) {
  const entry = stats[accountId]?.[heroId];
  const picks = entry?.picks ?? 0;
  const wins = entry?.wins ?? 0;
  const winrate =
    picks > 0 ? Number(((wins / picks) * 100).toFixed(1)) : null;

  return { picks, wins, winrate };
}

function getMatch(cache, matchId) {
  const match = cache[String(matchId)] || cache[matchId];
  if (!match) {
    throw new Error(`Матч ${matchId} не найден в кэше`);
  }
  return match;
}

function getTeamPicks(match) {
  const radiant = [];
  const dire = [];
  for (const pb of match.picks_bans || []) {
    if (!pb.is_pick) continue;
    if (pb.team === 0) radiant.push(pb.hero_id);
    else if (pb.team === 1) dire.push(pb.hero_id);
  }
  return { radiant, dire };
}

/**
 * Винрейт каждого игрока на герое из указанного матча (по турнирному кэшу).
 *
 * @param {number|string} matchId
 * @param {object} [options]
 * @param {boolean} [options.excludeCurrentMatch=true] - не учитывать этот матч в статистике
 * @param {Object} [options.heroMap] - id -> имя героя
 */
function getMatchPlayerHeroWinrates(matchId, options = {}) {
  const { excludeCurrentMatch = true, heroMap = {} } = options;
  const cache = loadMatchCache();
  const match = getMatch(cache, matchId);
  const stats = buildPlayerHeroStats(excludeCurrentMatch ? matchId : null);
  const { radiant: radiantPicks, dire: direPicks } = getTeamPicks(match);

  function mapPlayers(isRadiant) {
    return (match.players || [])
      .filter((p) => Boolean(p.isRadiant) === isRadiant)
      .sort((a, b) => a.player_slot - b.player_slot)
      .map((p) => {
        const { picks, wins, winrate } = getPlayerHeroStat(
          stats,
          p.account_id,
          p.hero_id
        );
        return {
          accountId: p.account_id,
          player: p.name || p.personaname || `account:${p.account_id}`,
          heroId: p.hero_id,
          hero: heroMap[p.hero_id] || `Hero(${p.hero_id})`,
          picks,
          wins,
          winrate,
        };
      });
  }

  return {
    matchId: match.match_id,
    radiant: {
      teamName: match.radiant_name || 'Radiant',
      picks: radiantPicks,
      players: mapPlayers(true),
    },
    dire: {
      teamName: match.dire_name || 'Dire',
      picks: direPicks,
      players: mapPlayers(false),
    },
  };
}

function printResult(result) {
  console.log(`\nmatch_id: ${result.matchId}`);

  for (const [label, side] of [
    ['Radiant', result.radiant],
    ['Dire', result.dire],
  ]) {
    console.log(`\n${label}: ${side.teamName}  picks=[${side.picks.join(', ')}]`);
    console.table(
      side.players.map((p) => ({
        player: p.player,
        hero: p.hero,
        heroId: p.heroId,
        games: p.picks,
        wins: p.wins,
        winrate: p.winrate == null ? 'n/a' : `${p.winrate}%`,
      }))
    );
  }
}

module.exports = {
  getMatchPlayerHeroWinrates,
  buildPlayerHeroStats,
};

if (require.main === module) {
  (async () => {
    const matchId = Number(process.argv[2]) || 8946337070;
    const heroMap = await loadHeroNames();
    printResult(getMatchPlayerHeroWinrates(matchId, { heroMap }));
  })();
}
