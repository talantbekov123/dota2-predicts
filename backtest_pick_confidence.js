const fs = require('fs');
const path = require('path');
const { buildPlayerHeroStats } = require('./player_hero_winrates');
const { heroConfidenceScore } = require('./hero_confidence_score');

const MATCH_CACHE_PATH = path.join(__dirname, 'matches-cache.json');
const BASE_URL = 'https://api.opendota.com/api';

/** Веса: комфорт игрока важнее турнирной меты */
const PLAYER_WEIGHT = 0.65;
const META_WEIGHT = 0.35;

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

function getMatch(cache, matchId) {
  const match = cache[String(matchId)] || cache[matchId];
  if (!match) {
    throw new Error(`Матч ${matchId} не найден в кэше. Сначала допиши лигу в meta.js и запусти node meta.js`);
  }
  return match;
}

/**
 * Турнирная мета героев по кэшу, с исключением одного матча (leave-one-out).
 * @returns {{ winrates: Object, totalPicks: number, matchesUsed: number }}
 */
function buildHeroMetaStats(excludeMatchId) {
  const cache = loadMatchCache();
  const stats = {};
  let totalPicks = 0;
  let matchesUsed = 0;

  for (const match of Object.values(cache)) {
    if (excludeMatchId != null && Number(match.match_id) === Number(excludeMatchId)) {
      continue;
    }
    matchesUsed += 1;

    const radiantWin = match.radiant_win;
    for (const pb of match.picks_bans || []) {
      if (!pb.is_pick) continue;

      const heroId = pb.hero_id;
      const won = (pb.team === 0 && radiantWin) || (pb.team === 1 && !radiantWin);

      stats[heroId] ??= { picks: 0, wins: 0 };
      stats[heroId].picks += 1;
      if (won) stats[heroId].wins += 1;
      totalPicks += 1;
    }
  }

  const winrates = {};
  for (const [heroId, { picks, wins }] of Object.entries(stats)) {
    winrates[heroId] = {
      picks,
      wins,
      winrate: picks > 0 ? wins / picks : null,
      pickrate: totalPicks > 0 ? picks / totalPicks : 0,
    };
  }

  return { winrates, totalPicks, matchesUsed };
}

/**
 * Уверенность пика:
 *   playerConf = Wilson(playerWR, playerGames)   // комфорт игрока на герое
 *   metaConf   = Wilson(metaWR, metaGames)       // сила героя в турнире
 *   score      = 0.65 * playerConf + 0.35 * metaConf
 *
 * Если у игрока 0 игр на герое — берём только мету (с лёгким штрафом за неизвестность).
 */
function pickConfidence({ playerPicks, playerWins, metaPicks, metaWins }) {
  const playerWR = playerPicks > 0 ? playerWins / playerPicks : null;
  const metaWR = metaPicks > 0 ? metaWins / metaPicks : null;

  const playerConf =
    playerPicks > 0 ? heroConfidenceScore(playerWR, playerPicks) : null;
  const metaConf =
    metaPicks > 0 ? heroConfidenceScore(metaWR, metaPicks) : 0;

  let score;
  if (playerConf == null) {
    // нет истории игрока → только мета, но осторожнее
    score = metaConf * 0.7;
  } else {
    score = PLAYER_WEIGHT * playerConf + META_WEIGHT * metaConf;
  }

  return {
    playerWR: playerWR == null ? null : Number((playerWR * 100).toFixed(1)),
    metaWR: metaWR == null ? null : Number((metaWR * 100).toFixed(1)),
    playerConf,
    metaConf,
    score: Number(score.toFixed(1)),
  };
}

function analyzeMatch(matchId, heroMap = {}) {
  const cache = loadMatchCache();
  const match = getMatch(cache, matchId);
  const playerStats = buildPlayerHeroStats(matchId);
  const { winrates: metaStats, matchesUsed, totalPicks } = buildHeroMetaStats(matchId);

  function mapSide(isRadiant) {
    const players = (match.players || [])
      .filter((p) => Boolean(p.isRadiant) === isRadiant)
      .sort((a, b) => a.player_slot - b.player_slot)
      .map((p) => {
        const heroId = p.hero_id;
        const ph = playerStats[p.account_id]?.[heroId] || { picks: 0, wins: 0 };
        const meta = metaStats[heroId] || metaStats[String(heroId)] || {
          picks: 0,
          wins: 0,
          winrate: null,
          pickrate: 0,
        };

        const conf = pickConfidence({
          playerPicks: ph.picks,
          playerWins: ph.wins,
          metaPicks: meta.picks,
          metaWins: meta.wins,
        });

        return {
          player: p.name || p.personaname || `account:${p.account_id}`,
          accountId: p.account_id,
          heroId,
          hero: heroMap[heroId] || `Hero(${heroId})`,
          playerGames: ph.picks,
          playerWins: ph.wins,
          playerWR: conf.playerWR,
          metaGames: meta.picks,
          metaWins: meta.wins,
          metaWR: conf.metaWR,
          metaPickrate: Number(((meta.pickrate || 0) * 100).toFixed(2)),
          playerConf: conf.playerConf,
          metaConf: conf.metaConf,
          confidence: conf.score,
        };
      });

    const sumConfidence = Number(
      players.reduce((acc, p) => acc + p.confidence, 0).toFixed(1)
    );

    return {
      teamName: isRadiant
        ? match.radiant_name || 'Radiant'
        : match.dire_name || 'Dire',
      players,
      sumConfidence,
    };
  }

  const radiant = mapSide(true);
  const dire = mapSide(false);
  const winner = match.radiant_win ? radiant.teamName : dire.teamName;
  const predicted =
    radiant.sumConfidence === dire.sumConfidence
      ? 'tie'
      : radiant.sumConfidence > dire.sumConfidence
        ? radiant.teamName
        : dire.teamName;

  return {
    matchId: match.match_id,
    matchesUsed,
    totalPicks,
    radiant,
    dire,
    winner,
    predicted,
    correct: predicted !== 'tie' && predicted === winner,
    edge: Number(Math.abs(radiant.sumConfidence - dire.sumConfidence).toFixed(1)),
  };
}

function printSide(label, side) {
  console.log(`\n${label}: ${side.teamName}  |  sum confidence = ${side.sumConfidence}`);
  console.table(
    side.players.map((p) => ({
      player: p.player,
      hero: p.hero,
      'player g/w': `${p.playerGames}/${p.playerWins}`,
      'player WR': p.playerWR == null ? 'n/a' : `${p.playerWR}%`,
      'meta g/w': `${p.metaGames}/${p.metaWins}`,
      'meta WR': p.metaWR == null ? 'n/a' : `${p.metaWR}%`,
      'meta pick%': `${p.metaPickrate}%`,
      playerConf: p.playerConf ?? 'n/a',
      metaConf: p.metaConf,
      confidence: p.confidence,
    }))
  );
}

function printResult(result) {
  console.log(`\nmatch_id: ${result.matchId}`);
  console.log(
    `статистика без этого матча: ${result.matchesUsed} матчей, ${result.totalPicks} пиков героев`
  );
  console.log(
    `формула: confidence = ${PLAYER_WEIGHT} * Wilson(playerWR) + ${META_WEIGHT} * Wilson(metaWR)`
  );
  console.log('(если у игрока 0 игр на герое → 0.7 * Wilson(metaWR))');

  printSide('Radiant', result.radiant);
  printSide('Dire', result.dire);

  const mark =
    result.predicted === 'tie' ? '~' : result.correct ? '✓' : '✗';

  console.log('\n' + '='.repeat(72));
  console.log(`winner:    ${result.winner}`);
  console.log(
    `predicted: ${
      result.predicted === 'tie'
        ? 'ничья'
        : `${result.predicted} (+${result.edge})`
    }  [${mark}]`
  );
  console.log('='.repeat(72));
}

module.exports = { analyzeMatch, pickConfidence, buildHeroMetaStats };

if (require.main === module) {
  (async () => {
    const matchId = Number(process.argv[2]) || 9026425519;
    const heroMap = await loadHeroNames();
    printResult(analyzeMatch(matchId, heroMap));
  })().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
