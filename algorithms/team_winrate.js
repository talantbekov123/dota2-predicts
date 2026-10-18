/**
 * Baseline: pick the side whose team has the higher win rate
 * in matches that already finished before this one.
 * Abstains when either team has no prior games, or the rates are equal.
 */
function predict({ match, history }) {
  const stats = {};

  function bump(teamId, won) {
    if (teamId == null) return;
    stats[teamId] ??= { games: 0, wins: 0 };
    stats[teamId].games += 1;
    if (won) stats[teamId].wins += 1;
  }

  for (const prior of history) {
    bump(prior.radiant_team_id, prior.radiant_win);
    bump(prior.dire_team_id, !prior.radiant_win);
  }

  const radiant = stats[match.radiant_team_id];
  const dire = stats[match.dire_team_id];
  if (!radiant?.games || !dire?.games) return { pick: null, edge: 0 };

  const radiantRate = radiant.wins / radiant.games;
  const direRate = dire.wins / dire.games;
  if (radiantRate === direRate) return { pick: null, edge: 0 };

  return {
    pick: radiantRate > direRate ? 'radiant' : 'dire',
    edge: Number((Math.abs(radiantRate - direRate) * 100).toFixed(1)),
  };
}

module.exports = { name: 'team-winrate', predict };
