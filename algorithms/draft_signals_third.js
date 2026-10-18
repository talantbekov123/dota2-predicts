const fs = require('fs');
const path = require('path');

/**
 * Copy of draft_signals_second.js. The runner prints its correct and incorrect
 * picks in two separate log sections.
 *
 * Bets stay in the 1.50 to 4.00 price band. The score adds two-hero
 * synergy and how often the hero is banned against this team, on top of
 * career win rate, hero win rate, counters, and a penalty for popular heroes.
 *
 * Scores Radiant and Dire from signals in earlier matches only:
 * team win rate, team win rate on this patch, team last-10 win rate,
 * hero pick rate, player win rate on the hero, games on that hero,
 * player win rate on any hero, win rate with ally heroes,
 * win rate against enemy heroes, and how often the hero is banned against this team.
 *
 * Few games on a hero pull that player's hero win rate toward 0.5.
 * Ban rate is compared with how often the hero is banned in general.
 * Pick rate is a penalty: in earlier matches, more popular heroes won less often,
 * so a high pick rate lowers the side score.
 */

const HERO_GAMES_FOR_FULL_TRUST = 10;
const PAIR_PRIOR_GAMES = 6;
const ODDS_PATH = path.join(__dirname, '..', 'odds-cache.json');

/** Only bet inside this price band. Shorter prices cannot pay a 5% stake. */
const MIN_PICK_ODDS = 1.5;
const MAX_PICK_ODDS = 4;

/** Skip a match when the two sides are closer than this. */
const MIN_EDGE = 4;

/** Hero win rate leads. Popular heroes are penalized. Synergy and bans add a smaller push. */
const WEIGHTS = {
  hero: 1.5,
  counter: 1,
  ally: 0.8,
  ban: 0.5,
  overall: 0.5,
  pick: -1,
  games: 0,
  patch: 0,
  any: 0,
  last10: 0,
};

let oddsCache = null;

function loadOdds() {
  if (oddsCache) return oddsCache;
  oddsCache = fs.existsSync(ODDS_PATH) ? JSON.parse(fs.readFileSync(ODDS_PATH, 'utf8')) : {};
  return oddsCache;
}

function priceOf(matchId, side) {
  const price = Number(loadOdds()[String(matchId)]?.odds?.[side]);
  return Number.isFinite(price) && price > 1 ? price : null;
}

function rate(wins, games, priorGames = 0) {
  if (!priorGames) return games > 0 ? wins / games : 0.5;
  return (wins + 0.5 * priorGames) / (games + priorGames);
}

function average(values) {
  if (values.length === 0) return 0.5;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function bumpPair(table, heroA, heroB, won) {
  table[heroA] ??= {};
  table[heroA][heroB] ??= { games: 0, wins: 0 };
  table[heroA][heroB].games += 1;
  if (won) table[heroA][heroB].wins += 1;
}

function buildIndex(history, patch) {
  const teams = {};
  const players = {};
  const heroPicks = {};
  const withPair = {};
  const vsPair = {};
  const banAgainst = {};
  const teamDrafts = {};
  const heroBans = {};
  let totalPicks = 0;
  let draftMatches = 0;

  function bumpTeam(teamId, won) {
    if (teamId == null) return;
    teams[teamId] ??= { games: 0, wins: 0, gamesPatch: 0, winsPatch: 0, recent: [] };
    const team = teams[teamId];
    team.games += 1;
    if (won) team.wins += 1;
    team.recent.push(Boolean(won));
  }

  function notePatch(teamId, won, matchPatch) {
    if (teamId == null || patch == null || matchPatch !== patch) return;
    const team = teams[teamId];
    if (!team) return;
    team.gamesPatch += 1;
    if (won) team.winsPatch += 1;
  }

  for (const prior of history) {
    const radiantWon = Boolean(prior.radiant_win);
    bumpTeam(prior.radiant_team_id, radiantWon);
    bumpTeam(prior.dire_team_id, !radiantWon);
    notePatch(prior.radiant_team_id, radiantWon, prior.patch);
    notePatch(prior.dire_team_id, !radiantWon, prior.patch);

    const radiant = [];
    const dire = [];
    for (const player of prior.players || []) {
      (player.is_radiant ? radiant : dire).push(player);
    }

    recordSide(radiant, radiantWon, dire);
    recordSide(dire, !radiantWon, radiant);
    recordBans(prior);
  }

  function recordSide(side, won, enemies) {
    for (let i = 0; i < side.length; i += 1) {
      const player = side[i];
      if (player.account_id == null || !player.hero_id) continue;

      players[player.account_id] ??= { games: 0, wins: 0, heroes: {} };
      const row = players[player.account_id];
      row.games += 1;
      if (won) row.wins += 1;
      row.heroes[player.hero_id] ??= { games: 0, wins: 0 };
      row.heroes[player.hero_id].games += 1;
      if (won) row.heroes[player.hero_id].wins += 1;

      heroPicks[player.hero_id] = (heroPicks[player.hero_id] || 0) + 1;
      totalPicks += 1;

      for (let j = i + 1; j < side.length; j += 1) {
        const allyHero = side[j].hero_id;
        if (!allyHero) continue;
        bumpPair(withPair, player.hero_id, allyHero, won);
        bumpPair(withPair, allyHero, player.hero_id, won);
      }

      for (const enemy of enemies) {
        if (!enemy.hero_id) continue;
        bumpPair(vsPair, player.hero_id, enemy.hero_id, won);
      }
    }
  }

  function recordBans(prior) {
    const picks = prior.picks_bans;
    if (!picks || picks.length === 0) return;
    draftMatches += 1;
    if (prior.radiant_team_id != null) {
      teamDrafts[prior.radiant_team_id] = (teamDrafts[prior.radiant_team_id] || 0) + 1;
    }
    if (prior.dire_team_id != null) {
      teamDrafts[prior.dire_team_id] = (teamDrafts[prior.dire_team_id] || 0) + 1;
    }

    for (const pick of picks) {
      if (pick.is_pick || !pick.hero_id) continue;
      const againstTeam =
        pick.team === 0 ? prior.dire_team_id : pick.team === 1 ? prior.radiant_team_id : null;
      if (againstTeam == null) continue;
      banAgainst[againstTeam] ??= {};
      banAgainst[againstTeam][pick.hero_id] = (banAgainst[againstTeam][pick.hero_id] || 0) + 1;
      heroBans[pick.hero_id] = (heroBans[pick.hero_id] || 0) + 1;
    }
  }

  return {
    teams,
    players,
    heroPicks,
    totalPicks,
    uniqueHeroes: Object.keys(heroPicks).length,
    withPair,
    vsPair,
    banAgainst,
    teamDrafts,
    heroBans,
    draftMatches,
  };
}

function pickScore(index, heroId) {
  if (!index.totalPicks || !index.uniqueHeroes) return 0.5;
  const picks = index.heroPicks[heroId] || 0;
  const pickRate = picks / index.totalPicks;
  const averageRate = 1 / index.uniqueHeroes;
  return clamp01(pickRate / averageRate / 2);
}

function banScore(index, teamId, heroId) {
  const teamGames = index.teamDrafts[teamId] || 0;
  const globalRate = index.draftMatches ? (index.heroBans[heroId] || 0) / index.draftMatches : 0;
  if (!teamGames || !globalRate) return 0.5;
  const teamRate = (index.banAgainst[teamId]?.[heroId] || 0) / teamGames;
  return clamp01(teamRate / globalRate / 2);
}

function pairScore(table, heroA, heroB) {
  const pair = table[heroA]?.[heroB] || { games: 0, wins: 0 };
  return rate(pair.wins, pair.games, PAIR_PRIOR_GAMES);
}

function sideFeatures(index, players, enemies, teamId) {
  const team = index.teams[teamId];
  const last = team ? team.recent.slice(-10) : [];
  const lastWins = last.reduce((sum, won) => sum + (won ? 1 : 0), 0);
  const drafted = players.filter((player) => player.hero_id);

  const parts = drafted.map((player) => {
    const row = player.account_id != null ? index.players[player.account_id] : null;
    const onHero = row?.heroes?.[player.hero_id] || { games: 0, wins: 0 };
    const trust = onHero.games / (onHero.games + HERO_GAMES_FOR_FULL_TRUST);
    const allyRates = drafted
      .filter((ally) => ally.hero_id && ally.hero_id !== player.hero_id)
      .map((ally) => pairScore(index.withPair, player.hero_id, ally.hero_id));
    const enemyRates = enemies
      .filter((enemy) => enemy.hero_id)
      .map((enemy) => pairScore(index.vsPair, player.hero_id, enemy.hero_id));

    return {
      hero: trust * rate(onHero.wins, onHero.games) + (1 - trust) * 0.5,
      overall: rate(row?.wins || 0, row?.games || 0),
      pick: pickScore(index, player.hero_id),
      ban: banScore(index, teamId, player.hero_id),
      ally: average(allyRates),
      counter: average(enemyRates),
      games: Math.min(onHero.games, 20) / 20,
    };
  });

  function mean(key) {
    return average(parts.map((part) => part[key]));
  }

  return {
    patch: rate(team?.winsPatch || 0, team?.gamesPatch || 0),
    any: rate(team?.wins || 0, team?.games || 0),
    last10: rate(lastWins, last.length),
    hero: mean('hero'),
    overall: mean('overall'),
    pick: mean('pick'),
    ban: mean('ban'),
    ally: mean('ally'),
    counter: mean('counter'),
    games: mean('games'),
  };
}

function combine(features) {
  return Object.entries(WEIGHTS).reduce(
    (sum, [key, weight]) => sum + weight * features[key],
    0
  );
}

function predict({ match, history }) {
  const ordered = [...history].sort((a, b) => a.start_time - b.start_time);
  const index = buildIndex(ordered, match.patch ?? null);

  const radiantPlayers = (match.players || []).filter((player) => player.is_radiant);
  const direPlayers = (match.players || []).filter((player) => !player.is_radiant);

  const radiant = combine(sideFeatures(index, radiantPlayers, direPlayers, match.radiant_team_id));
  const dire = combine(sideFeatures(index, direPlayers, radiantPlayers, match.dire_team_id));
  const edge = Number((Math.abs(radiant - dire) * 100).toFixed(1));
  if (edge < MIN_EDGE) return { pick: null, edge };

  const pick = radiant > dire ? 'radiant' : 'dire';
  const price = priceOf(match.match_id, pick);
  if (price == null || price < MIN_PICK_ODDS || price > MAX_PICK_ODDS) return { pick: null, edge };

  return { pick, edge };
}

module.exports = { name: 'draft-signals-third', predict, splitResults: true };
