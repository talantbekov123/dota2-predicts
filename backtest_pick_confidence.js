const fs = require('fs');
const path = require('path');
const { buildPlayerHeroStats } = require('./player_hero_winrates');
const { bayesianSmoothScore } = require('./hero_confidence_score');

const MATCH_CACHE_PATH = path.join(__dirname, 'matches-cache.json');
const ODDS_CACHE_PATH = path.join(__dirname, 'odds-cache.json');
const BASE_URL = 'https://api.opendota.com/api';

/** Веса (режим pick): комфорт игрока важнее турнирной меты */
const PLAYER_WEIGHT = 0.65;
const META_WEIGHT = 0.35;

/** TEST-3A: сила априора байесовского сглаживания */
const BAYES_C = 5;
const BAYES_PRIOR = 0.5;

/** TEST-4A: порог Δ */
const MIN_EDGE_PICK = 10;
const MIN_EDGE_MATCHUP = 5;
const MIN_EDGE_TEAM = 5;

/**
 * APPROACH-1: Matchup Synergy Matrix 5×5
 * APPROACH-2: Team Rating Baseline + DraftModifier
 */
const DEFAULT_SCORE_MODE = 'team'; // 'matchup' | 'pick' | 'team'


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

function getTeamHeroIds(match, isRadiant) {
  const fromPlayers = (match.players || [])
    .filter((p) => Boolean(p.isRadiant) === isRadiant)
    .sort((a, b) => a.player_slot - b.player_slot)
    .map((p) => p.hero_id)
    .filter(Boolean);

  if (fromPlayers.length === 5) return fromPlayers;

  const fromDraft = [];
  for (const pb of match.picks_bans || []) {
    if (!pb.is_pick) continue;
    if (isRadiant && pb.team === 0) fromDraft.push(pb.hero_id);
    if (!isRadiant && pb.team === 1) fromDraft.push(pb.hero_id);
  }
  return fromDraft;
}

/**
 * Матрица контрпиков по кэшу (leave-one-out).
 * matchups[heroA][heroB] = { games, wins } — сколько раз A выиграл, стоя против B.
 */
function buildHeroMatchupStats(excludeMatchId) {
  const cache = loadMatchCache();
  const matchups = {};
  let matchesUsed = 0;
  let pairSamples = 0;

  function bump(a, b, won) {
    matchups[a] ??= {};
    matchups[a][b] ??= { games: 0, wins: 0 };
    matchups[a][b].games += 1;
    if (won) matchups[a][b].wins += 1;
    pairSamples += 1;
  }

  for (const match of Object.values(cache)) {
    if (excludeMatchId != null && Number(match.match_id) === Number(excludeMatchId)) {
      continue;
    }

    const radiant = getTeamHeroIds(match, true);
    const dire = getTeamHeroIds(match, false);
    if (radiant.length === 0 || dire.length === 0) continue;

    matchesUsed += 1;
    const radiantWin = Boolean(match.radiant_win);

    for (const r of radiant) {
      for (const d of dire) {
        bump(r, d, radiantWin);
        bump(d, r, !radiantWin);
      }
    }
  }

  return { matchups, matchesUsed, pairSamples };
}

function pairMatchupScore(matchups, heroA, heroB) {
  const entry = matchups[heroA]?.[heroB];
  if (!entry || entry.games <= 0) {
    return {
      games: 0,
      wins: 0,
      rawWR: null,
      score: bayesianSmoothScore(BAYES_PRIOR, 0, BAYES_C, BAYES_PRIOR),
    };
  }
  const rawWR = entry.wins / entry.games;
  return {
    games: entry.games,
    wins: entry.wins,
    rawWR: Number((rawWR * 100).toFixed(1)),
    score: bayesianSmoothScore(rawWR, entry.games, BAYES_C, BAYES_PRIOR),
  };
}

/**
 * MatchupScore(A vs B) = среднее Bayes(WR(Ai vs Bj)) по всем 5×5 парам.
 */
function computeMatchupMatrixScore(heroesA, heroesB, matchups) {
  const matrix = [];
  let sum = 0;
  let pairs = 0;
  let knownPairs = 0;

  for (const a of heroesA) {
    const row = [];
    for (const b of heroesB) {
      const cell = pairMatchupScore(matchups, a, b);
      row.push({ heroA: a, heroB: b, ...cell });
      sum += cell.score;
      pairs += 1;
      if (cell.games > 0) knownPairs += 1;
    }
    matrix.push(row);
  }

  return {
    matrix,
    sumScore: Number(sum.toFixed(1)),
    avgScore: pairs > 0 ? Number((sum / pairs).toFixed(1)) : 50,
    pairs,
    knownPairs,
  };
}

/**
 * Уверенность пика (TEST-3A-BAYESIAN-SMOOTHING):
 *   playerConf = Bayes(playerWR, playerGames, C=5)
 *   metaConf   = Bayes(metaWR, metaGames, C=5)
 *   score      = 0.65 * playerConf + 0.35 * metaConf
 *
 * Bayes: (wins + C*0.5) / (n + C) → 0..100
 * Если у игрока 0 игр на герое — берём только мету (с лёгким штрафом за неизвестность).
 */
function pickConfidence({ playerPicks, playerWins, metaPicks, metaWins }) {
  const playerWR = playerPicks > 0 ? playerWins / playerPicks : null;
  const metaWR = metaPicks > 0 ? metaWins / metaPicks : null;

  const playerConf =
    playerPicks > 0
      ? bayesianSmoothScore(playerWR, playerPicks, BAYES_C, BAYES_PRIOR)
      : null;
  const metaConf =
    metaPicks > 0
      ? bayesianSmoothScore(metaWR, metaPicks, BAYES_C, BAYES_PRIOR)
      : 0;

  let score;
  if (playerConf == null) {
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

function analyzeMatchPick(matchId, heroMap = {}, minEdge = MIN_EDGE_PICK) {
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
      heroIds: players.map((p) => p.heroId),
      sumConfidence,
    };
  }

  const radiant = mapSide(true);
  const dire = mapSide(false);
  return finalizePrediction(match, radiant, dire, {
    matchesUsed,
    totalPicks,
    scoreMode: 'pick',
    minEdge,
  });
}

/**
 * APPROACH-1: Matchup Synergy Matrix 5×5
 * MatchupScore(A) = avg Bayes(WR(Ai vs Bj)) по 25 парам
 */
function analyzeMatchMatchup(matchId, heroMap = {}, minEdge = MIN_EDGE_MATCHUP) {
  const cache = loadMatchCache();
  const match = getMatch(cache, matchId);
  const { matchups, matchesUsed, pairSamples } = buildHeroMatchupStats(matchId);

  const radiantIds = getTeamHeroIds(match, true);
  const direIds = getTeamHeroIds(match, false);

  const radiantMatrix = computeMatchupMatrixScore(radiantIds, direIds, matchups);
  const direMatrix = computeMatchupMatrixScore(direIds, radiantIds, matchups);

  function mapSide(isRadiant, heroIds, matrixResult) {
    const players = (match.players || [])
      .filter((p) => Boolean(p.isRadiant) === isRadiant)
      .sort((a, b) => a.player_slot - b.player_slot)
      .map((p, idx) => {
        const heroId = p.hero_id || heroIds[idx];
        const rowIdx = Math.max(0, heroIds.indexOf(heroId));
        const row = matrixResult.matrix[rowIdx] || [];
        const rowAvg =
          row.length > 0
            ? Number(
                (row.reduce((s, c) => s + c.score, 0) / row.length).toFixed(1)
              )
            : 50;
        const rowKnown = row.filter((c) => c.games > 0).length;

        return {
          player: p.name || p.personaname || `account:${p.account_id}`,
          accountId: p.account_id,
          heroId,
          hero: heroMap[heroId] || `Hero(${heroId})`,
          matchupAvg: rowAvg,
          matchupKnown: rowKnown,
          confidence: rowAvg,
        };
      });

    // если players пустые — синтетика по heroIds
    const list =
      players.length > 0
        ? players
        : heroIds.map((heroId, idx) => {
            const row = matrixResult.matrix[idx] || [];
            const rowAvg =
              row.length > 0
                ? Number(
                    (row.reduce((s, c) => s + c.score, 0) / row.length).toFixed(1)
                  )
                : 50;
            return {
              player: `slot:${idx}`,
              accountId: null,
              heroId,
              hero: heroMap[heroId] || `Hero(${heroId})`,
              matchupAvg: rowAvg,
              matchupKnown: row.filter((c) => c.games > 0).length,
              confidence: rowAvg,
            };
          });

    return {
      teamName: isRadiant
        ? match.radiant_name || 'Radiant'
        : match.dire_name || 'Dire',
      players: list,
      heroIds,
      sumConfidence: matrixResult.avgScore,
      matchupSum: matrixResult.sumScore,
      matchupKnownPairs: matrixResult.knownPairs,
      matchupPairs: matrixResult.pairs,
    };
  }

  const radiant = mapSide(true, radiantIds, radiantMatrix);
  const dire = mapSide(false, direIds, direMatrix);

  return finalizePrediction(match, radiant, dire, {
    matchesUsed,
    totalPicks: pairSamples,
    scoreMode: 'matchup',
    minEdge,
  });
}

function normalizeTeamKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Сила драфта = среднее Bayes(metaWR) пяти героев.
 */
function draftScoreFromHeroes(heroIds, metaWinrates) {
  if (!heroIds.length) return 50;
  let sum = 0;
  for (const id of heroIds) {
    const m = metaWinrates[id] || metaWinrates[String(id)];
    if (!m || !m.picks) {
      sum += bayesianSmoothScore(BAYES_PRIOR, 0, BAYES_C, BAYES_PRIOR);
    } else {
      sum += bayesianSmoothScore(
        m.wins / m.picks,
        m.picks,
        BAYES_C,
        BAYES_PRIOR
      );
    }
  }
  return Number((sum / heroIds.length).toFixed(1));
}

/**
 * База по командам (leave-one-out):
 *   winrate + средний draftScore их прошлых пиков.
 */
function buildTeamBaselines(excludeMatchId, metaWinrates) {
  const cache = loadMatchCache();
  const teams = {};

  function ensure(name) {
    const key = normalizeTeamKey(name);
    if (!key) return null;
    teams[key] ??= {
      name,
      games: 0,
      wins: 0,
      draftSum: 0,
      draftCount: 0,
    };
    return teams[key];
  }

  for (const match of Object.values(cache)) {
    if (
      excludeMatchId != null &&
      Number(match.match_id) === Number(excludeMatchId)
    ) {
      continue;
    }

    const radiantName = match.radiant_name || 'Radiant';
    const direName = match.dire_name || 'Dire';
    const radiant = ensure(radiantName);
    const dire = ensure(direName);
    if (!radiant || !dire) continue;

    const radiantIds = getTeamHeroIds(match, true);
    const direIds = getTeamHeroIds(match, false);
    const rDraft = draftScoreFromHeroes(radiantIds, metaWinrates);
    const dDraft = draftScoreFromHeroes(direIds, metaWinrates);

    radiant.games += 1;
    dire.games += 1;
    if (match.radiant_win) radiant.wins += 1;
    else dire.wins += 1;

    radiant.draftSum += rDraft;
    radiant.draftCount += 1;
    dire.draftSum += dDraft;
    dire.draftCount += 1;
  }

  for (const t of Object.values(teams)) {
    t.winrate = t.games > 0 ? t.wins / t.games : 0.5;
    t.baseRating = bayesianSmoothScore(
      t.winrate,
      t.games,
      BAYES_C,
      BAYES_PRIOR
    );
    t.avgDraftScore =
      t.draftCount > 0
        ? Number((t.draftSum / t.draftCount).toFixed(1))
        : 50;
  }

  return teams;
}

/**
 * Близкий матч: коэфы в «равной» зоне или базы команд почти равны.
 * Именно тут чистый BaseTeamRating даёт ~50% — нужен сильный draft/matchup сигнал.
 */
function isCloseMatch(odds, baseA, baseB) {
  const teamGap = Math.abs(baseA - baseB);
  if (teamGap < 8) return true;

  if (odds) {
    const hi = Math.max(odds.radiant, odds.dire);
    const lo = Math.min(odds.radiant, odds.dire);
    // фаворит не сильнее ~1.4 и андердог не длиннее ~3 → равный матч
    if (lo >= 1.35 && hi <= 3.1) return true;
    if (hi / lo <= 2.1) return true;
  }
  return false;
}

/**
 * APPROACH-2 (+ close-match fix):
 *   mismatch: Final = BaseTeamRating + DraftModifier
 *   close:    Final = (1-α)*Base + α*MatchupScore + DraftModifier
 *             (α=0.65 — на близких матчах больше верим контрпикам 5×5)
 */
function analyzeMatchTeam(matchId, heroMap = {}, minEdge = MIN_EDGE_TEAM) {
  const cache = loadMatchCache();
  const match = getMatch(cache, matchId);
  const { winrates: metaWinrates, matchesUsed, totalPicks } =
    buildHeroMetaStats(matchId);
  const teams = buildTeamBaselines(matchId, metaWinrates);
  const { matchups } = buildHeroMatchupStats(matchId);
  const oddsCache = loadOddsCache();
  const odds = getMatchOdds(oddsCache, matchId);

  const radiantIds = getTeamHeroIds(match, true);
  const direIds = getTeamHeroIds(match, false);

  const radiantMatrix = computeMatchupMatrixScore(
    radiantIds,
    direIds,
    matchups
  );
  const direMatrix = computeMatchupMatrixScore(direIds, radiantIds, matchups);

  function sideBaseline(teamName) {
    return (
      teams[normalizeTeamKey(teamName)] || {
        name: teamName,
        games: 0,
        wins: 0,
        winrate: 0.5,
        baseRating: 50,
        avgDraftScore: 50,
      }
    );
  }

  const radiantName = match.radiant_name || 'Radiant';
  const direName = match.dire_name || 'Dire';
  const rBase = sideBaseline(radiantName);
  const dBase = sideBaseline(direName);
  const close = isCloseMatch(odds, rBase.baseRating, dBase.baseRating);

  // на близких матчах сильнее matchup; на разъездах — сила тега
  const ALPHA_CLOSE = 0.65;
  const ALPHA_MISMATCH = 0.15;
  const alpha = close ? ALPHA_CLOSE : ALPHA_MISMATCH;

  function mapSide(isRadiant, heroIds, matrixResult, baseline) {
    const teamName = isRadiant ? radiantName : direName;
    const draftNow = draftScoreFromHeroes(heroIds, metaWinrates);
    const draftModifier = Number(
      (draftNow - baseline.avgDraftScore).toFixed(1)
    );
    const matchupScore = matrixResult.avgScore;

    // Final = (1-α)*Base + α*Matchup + DraftModifier
    const finalScore = Number(
      (
        (1 - alpha) * baseline.baseRating +
        alpha * matchupScore +
        draftModifier
      ).toFixed(1)
    );

    const players = (match.players || [])
      .filter((p) => Boolean(p.isRadiant) === isRadiant)
      .sort((a, b) => a.player_slot - b.player_slot)
      .map((p, idx) => {
        const heroId = p.hero_id || heroIds[idx];
        const m = metaWinrates[heroId] || metaWinrates[String(heroId)];
        const heroDraft =
          m && m.picks
            ? bayesianSmoothScore(m.wins / m.picks, m.picks, BAYES_C, BAYES_PRIOR)
            : 50;
        const row = matrixResult.matrix[idx] || [];
        const rowAvg =
          row.length > 0
            ? Number(
                (row.reduce((s, c) => s + c.score, 0) / row.length).toFixed(1)
              )
            : 50;
        return {
          player: p.name || p.personaname || `account:${p.account_id}`,
          accountId: p.account_id,
          heroId,
          hero: heroMap[heroId] || `Hero(${heroId})`,
          heroDraft,
          matchupAvg: rowAvg,
          confidence: heroDraft,
        };
      });

    return {
      teamName,
      players,
      heroIds,
      baseRating: baseline.baseRating,
      teamGames: baseline.games,
      teamWins: baseline.wins,
      teamWR:
        baseline.games > 0
          ? Number(((baseline.wins / baseline.games) * 100).toFixed(1))
          : null,
      draftNow,
      draftBaseline: baseline.avgDraftScore,
      draftModifier,
      matchupScore,
      alpha,
      close,
      sumConfidence: finalScore,
    };
  }

  const radiant = mapSide(true, radiantIds, radiantMatrix, rBase);
  const dire = mapSide(false, direIds, direMatrix, dBase);

  return finalizePrediction(match, radiant, dire, {
    matchesUsed,
    totalPicks,
    scoreMode: 'team',
    minEdge,
  });
}

function finalizePrediction(match, radiant, dire, meta) {
  const winner = match.radiant_win ? radiant.teamName : dire.teamName;
  const edge = Number(
    Math.abs(radiant.sumConfidence - dire.sumConfidence).toFixed(1)
  );
  const minEdge =
    meta.minEdge ??
    (meta.scoreMode === 'matchup'
      ? MIN_EDGE_MATCHUP
      : meta.scoreMode === 'team'
        ? MIN_EDGE_TEAM
        : MIN_EDGE_PICK);

  let predicted = 'tie';
  if (edge >= minEdge) {
    predicted =
      radiant.sumConfidence > dire.sumConfidence
        ? radiant.teamName
        : dire.teamName;
  }

  return {
    matchId: match.match_id,
    scoreMode: meta.scoreMode,
    matchesUsed: meta.matchesUsed,
    totalPicks: meta.totalPicks,
    radiant,
    dire,
    winner,
    predicted,
    correct: predicted !== 'tie' && predicted === winner,
    edge,
    minEdge,
    skippedLowEdge: edge < minEdge,
  };
}

function analyzeMatch(
  matchId,
  heroMap = {},
  scoreMode = DEFAULT_SCORE_MODE,
  minEdge = null
) {
  const defaultEdge =
    scoreMode === 'matchup'
      ? MIN_EDGE_MATCHUP
      : scoreMode === 'team'
        ? MIN_EDGE_TEAM
        : MIN_EDGE_PICK;
  const resolvedMinEdge = minEdge != null ? minEdge : defaultEdge;

  if (scoreMode === 'matchup') {
    return analyzeMatchMatchup(matchId, heroMap, resolvedMinEdge);
  }
  if (scoreMode === 'team') {
    return analyzeMatchTeam(matchId, heroMap, resolvedMinEdge);
  }
  return analyzeMatchPick(matchId, heroMap, resolvedMinEdge);
}

function printSide(label, side, scoreMode = 'pick') {
  console.log(`\n${label}: ${side.teamName}  |  sum confidence = ${side.sumConfidence}`);
  if (scoreMode === 'team') {
    console.log(
      `  baseRating=${side.baseRating} (team ${side.teamWins}/${side.teamGames}, WR=${side.teamWR ?? 'n/a'}%)`
    );
    console.log(
      `  matchup=${side.matchupScore}  draftNow=${side.draftNow}  draftBase=${side.draftBaseline}  draftMod=${side.draftModifier > 0 ? '+' : ''}${side.draftModifier}`
    );
    console.log(
      `  close=${side.close}  α=${side.alpha}  Final=(1-α)*Base + α*Matchup + DraftMod = ${side.sumConfidence}`
    );
    console.table(
      side.players.map((p) => ({
        player: p.player,
        hero: p.hero,
        heroDraft: p.heroDraft ?? p.confidence,
        matchupAvg: p.matchupAvg ?? 'n/a',
      }))
    );
    return;
  }
  if (scoreMode === 'matchup') {
    console.table(
      side.players.map((p) => ({
        player: p.player,
        hero: p.hero,
        matchupAvg: p.matchupAvg ?? p.confidence,
        knownVsEnemy: p.matchupKnown ?? 'n/a',
      }))
    );
    if (side.matchupKnownPairs != null) {
      console.log(
        `  matchup pairs known: ${side.matchupKnownPairs}/${side.matchupPairs}  sum=${side.matchupSum}`
      );
    }
    return;
  }

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

function printResult(result, { compact = false, odds = null } = {}) {
  const mark =
    result.predicted === 'tie' ? '~' : result.correct ? '✓' : '✗';

  if (compact) {
    const oddsStr = odds
      ? `  odds=${odds.radiant}/${odds.dire}`
      : '';
    const skipStr = result.skippedLowEdge ? `  skipΔ<${result.minEdge}` : '';
    const closeStr =
      result.scoreMode === 'team' && result.radiant.close != null
        ? `  close=${result.radiant.close}`
        : '';
    console.log(
      `[${mark}] ${result.matchId}  ${result.radiant.teamName} ${result.radiant.sumConfidence} vs ${result.dire.teamName} ${result.dire.sumConfidence}  Δ=${result.edge}  → pred=${
        result.predicted === 'tie' ? 'tie' : result.predicted
      }  winner=${result.winner}${oddsStr}${skipStr}${closeStr}`
    );
    return;
  }

  console.log(`\nmatch_id: ${result.matchId}  scoreMode=${result.scoreMode}`);
  if (odds) {
    console.log(`odds: ${result.radiant.teamName} ${odds.radiant} / ${result.dire.teamName} ${odds.dire}`);
  }
  console.log(
    `статистика без этого матча: ${result.matchesUsed} матчей, samples=${result.totalPicks}`
  );
  if (result.scoreMode === 'matchup') {
    console.log(
      'формула (APPROACH-1): MatchupScore = avg Bayes(WR(Ai vs Bj)) по матрице 5×5'
    );
  } else if (result.scoreMode === 'team') {
    console.log(
      'формула (APPROACH-2 close-fix): Final = (1-α)*BaseTeam + α*Matchup + DraftModifier'
    );
    console.log(
      '  close (odds/team gap) → α=0.65; mismatch → α=0.15'
    );
  } else {
    console.log(
      `формула (TEST-3A): confidence = ${PLAYER_WEIGHT} * Bayes(playerWR,C=${BAYES_C}) + ${META_WEIGHT} * Bayes(metaWR,C=${BAYES_C})`
    );
    console.log(
      `(Bayes = (wins + ${BAYES_C}*${BAYES_PRIOR}) / (n + ${BAYES_C}); 0 игр игрока → 0.7 * Bayes(meta))`
    );
  }
  console.log(`TEST-4A: прогноз только если Δ sumConfidence ≥ ${result.minEdge}`);

  printSide('Radiant', result.radiant, result.scoreMode);
  printSide('Dire', result.dire, result.scoreMode);

  console.log('\n' + '='.repeat(72));
  console.log(`winner:    ${result.winner}`);
  console.log(
    `predicted: ${
      result.predicted === 'tie'
        ? result.skippedLowEdge
          ? `skip (Δ=${result.edge} < ${result.minEdge})`
          : 'ничья'
        : `${result.predicted} (+${result.edge})`
    }  [${mark}]`
  );
  console.log('='.repeat(72));
}

/** Читает match_id из файла: один id на строку, # — комментарий. */
function loadMatchIdsFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Файл не найден: ${filePath}`);
  }
  const ids = fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .map((line) => Number(line))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (ids.length === 0) {
    throw new Error(`В файле нет match_id: ${filePath}`);
  }
  return ids;
}

function loadOddsCache() {
  if (!fs.existsSync(ODDS_CACHE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(ODDS_CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function getMatchOdds(oddsCache, matchId) {
  const entry = oddsCache[String(matchId)] || oddsCache[matchId];
  if (!entry?.odds) return null;
  const radiant = Number(entry.odds.radiant);
  const dire = Number(entry.odds.dire);
  if (!radiant || !dire) return null;
  return {
    radiant,
    dire,
    bookmaker: entry.odds.bookmaker || null,
    max: Math.max(radiant, dire),
    min: Math.min(radiant, dire),
  };
}

/**
 * Фильтр: хотя бы у одной команды коэф в [oddsMin, oddsMax].
 * Не заданная граница = без ограничения с этой стороны.
 */
function oddsPassFilter(odds, { oddsMin = null, oddsMax = null } = {}) {
  if (oddsMin == null && oddsMax == null) return true;
  if (!odds) return false;

  const inRange = (coef) => {
    if (oddsMin != null && coef < oddsMin) return false;
    if (oddsMax != null && coef > oddsMax) return false;
    return true;
  };

  return inRange(odds.radiant) || inRange(odds.dire);
}

function parseArgs(argv) {
  const matchIds = [];
  let filePath = null;
  let verbose = false;
  let oddsMin = null;
  let oddsMax = null;
  let scoreMode = DEFAULT_SCORE_MODE;
  let minEdge = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file' || arg === '-f') {
      filePath = argv[++i];
      if (!filePath) throw new Error('Укажи путь после --file');
      continue;
    }
    if (arg === '--verbose' || arg === '-v') {
      verbose = true;
      continue;
    }
    if (arg === '--score') {
      scoreMode = String(argv[++i] || '').toLowerCase();
      if (!['matchup', 'pick', 'team'].includes(scoreMode)) {
        throw new Error('--score должен быть matchup | pick | team');
      }
      continue;
    }
    if (arg === '--min-edge') {
      minEdge = Number(argv[++i]);
      if (!Number.isFinite(minEdge) || minEdge < 0) {
        throw new Error('--min-edge: число ≥ 0');
      }
      continue;
    }
    if (arg === '--odds-min') {
      oddsMin = Number(argv[++i]);
      if (!Number.isFinite(oddsMin)) throw new Error('--odds-min: число');
      continue;
    }
    if (arg === '--odds-max') {
      oddsMax = Number(argv[++i]);
      if (!Number.isFinite(oddsMax)) throw new Error('--odds-max: число');
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      return { help: true };
    }
    if (/^\d+$/.test(arg)) {
      matchIds.push(Number(arg));
      continue;
    }
    if (fs.existsSync(arg) && fs.statSync(arg).isFile()) {
      filePath = arg;
      continue;
    }
    throw new Error(`Неизвестный аргумент: ${arg}`);
  }

  if (filePath) {
    matchIds.push(...loadMatchIdsFromFile(filePath));
  }

  if (oddsMin != null && oddsMax != null && oddsMin > oddsMax) {
    throw new Error('--odds-min не может быть больше --odds-max');
  }

  return {
    matchIds,
    filePath,
    verbose,
    oddsMin,
    oddsMax,
    scoreMode,
    minEdge,
    help: false,
  };
}

function printUsage() {
  console.log(`Usage:
  node backtest_pick_confidence.js -f backtest-matches.txt --score team
  node backtest_pick_confidence.js -f backtest-matches.txt --score matchup --min-edge 3
  node backtest_pick_confidence.js -f backtest-matches.txt --score pick --odds-min 1.5 --odds-max 2

--score team (default)     APPROACH-2: BaseTeamRating + DraftModifier (min-edge ${MIN_EDGE_TEAM})
--score matchup            APPROACH-1: матрица 5×5 (min-edge ${MIN_EDGE_MATCHUP})
--score pick               player+meta (min-edge ${MIN_EDGE_PICK})
--min-edge N               порог Δ для принятия прогноза`);
}

module.exports = {
  analyzeMatch,
  analyzeMatchMatchup,
  analyzeMatchPick,
  analyzeMatchTeam,
  pickConfidence,
  buildHeroMetaStats,
  buildHeroMatchupStats,
  buildTeamBaselines,
  computeMatchupMatrixScore,
  loadMatchIdsFromFile,
  getMatchOdds,
  oddsPassFilter,
};

if (require.main === module) {
  (async () => {
    let parsed;
    try {
      parsed = parseArgs(process.argv.slice(2));
    } catch (err) {
      console.error(err.message);
      printUsage();
      process.exit(1);
    }

    if (parsed.help) {
      printUsage();
      process.exit(0);
    }

    const allIds =
      parsed.matchIds.length > 0 ? parsed.matchIds : [9026425519];
    const oddsCache = loadOddsCache();
    const filterOn = parsed.oddsMin != null || parsed.oddsMax != null;
    const scoreMode = parsed.scoreMode;
    const minEdge =
      parsed.minEdge != null
        ? parsed.minEdge
        : scoreMode === 'matchup'
          ? MIN_EDGE_MATCHUP
          : scoreMode === 'team'
            ? MIN_EDGE_TEAM
            : MIN_EDGE_PICK;

    const filtered = [];
    let skippedNoOdds = 0;
    let skippedFilter = 0;

    for (const matchId of allIds) {
      const odds = getMatchOdds(oddsCache, matchId);
      if (!filterOn) {
        filtered.push({ matchId, odds });
        continue;
      }
      if (!odds) {
        skippedNoOdds += 1;
        continue;
      }
      if (!oddsPassFilter(odds, parsed)) {
        skippedFilter += 1;
        continue;
      }
      filtered.push({ matchId, odds });
    }

    if (parsed.filePath) {
      console.log(`Файл: ${parsed.filePath}  (в файле ${allIds.length})`);
    }
    console.log(`scoreMode=${scoreMode}  minEdge=Δ≥${minEdge}`);
    if (filterOn) {
      console.log(
        `Фильтр odds: [${parsed.oddsMin ?? '-∞'}, ${parsed.oddsMax ?? '+∞'}]  →  прошло ${filtered.length}  |  нет коэфов=${skippedNoOdds}  вне диапазона=${skippedFilter}`
      );
    }

    if (filtered.length === 0) {
      console.log('Нет матчей после фильтра — бектест пустой.');
      process.exit(0);
    }

    console.log('Загрузка кэша / имён героев...');
    const compact = filtered.length > 1 && !parsed.verbose;
    const heroMap = await loadHeroNames();
    loadMatchCache();
    console.log(`К обработке: ${filtered.length} матчей`);

    let hits = 0;
    let decided = 0;
    let ties = 0;
    let lowEdge = 0;
    let errors = 0;

    console.log(`TEST-4A: min edge Δ ≥ ${minEdge}`);

    for (let i = 0; i < filtered.length; i++) {
      const { matchId, odds } = filtered[i];
      try {
        process.stdout.write(`[${i + 1}/${filtered.length}] ${matchId}... `);
        const result = analyzeMatch(matchId, heroMap, scoreMode, minEdge);
        if (compact) {
          process.stdout.write('');
        } else {
          console.log('ok');
        }
        printResult(result, { compact, odds });

        if (result.skippedLowEdge) {
          lowEdge += 1;
        } else if (result.predicted === 'tie') {
          ties += 1;
        } else {
          decided += 1;
          if (result.correct) hits += 1;
        }
      } catch (err) {
        errors += 1;
        console.error(`ERROR: ${err.message}`);
      }
    }

    if (filtered.length > 1 || filterOn) {
      console.log('\n' + '='.repeat(72));
      console.log(
        `ИТОГО: ${hits}/${decided} (${
          decided ? ((hits / decided) * 100).toFixed(1) : 0
        }%)  |  lowEdge(<${minEdge})=${lowEdge}  ties=${ties}  errors=${errors}  filtered=${filtered.length}/${allIds.length}`
      );
      console.log('='.repeat(72));
    }
  })().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
