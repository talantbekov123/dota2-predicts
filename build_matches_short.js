const fs = require('fs');
const path = require('path');

const SLIM_PATH = path.join(__dirname, 'matches-slim.json');
const CACHE_PATH = path.join(__dirname, 'matches-cache.json');
const OUT_PATH = path.join(__dirname, 'matches-short.json');

function teamName(match, side) {
  if (!match) return null;
  const direct = match[`${side}_name`];
  if (direct) return direct;
  return match[`${side}_team`]?.name || null;
}

function playerName(player) {
  if (!player) return null;
  return player.name || player.personaname || null;
}

function shortenMatch(slim, full) {
  const fullByAccount = new Map();
  for (const player of full?.players || []) {
    if (player.account_id != null) fullByAccount.set(player.account_id, player);
  }

  const players = (slim.players || []).map((player) => {
    const detail = fullByAccount.get(player.account_id);
    return {
      account_id: player.account_id ?? null,
      name: playerName(detail),
      player_slot: detail?.player_slot ?? null,
      is_radiant: Boolean(player.isRadiant ?? detail?.isRadiant),
      hero_id: player.hero_id ?? null,
    };
  });

  players.sort((a, b) => {
    if (a.player_slot == null && b.player_slot == null) return 0;
    if (a.player_slot == null) return 1;
    if (b.player_slot == null) return -1;
    return a.player_slot - b.player_slot;
  });

  const picksBans = (full?.picks_bans || []).map((pick) => ({
    is_pick: Boolean(pick.is_pick),
    hero_id: pick.hero_id,
    team: pick.team,
    order: pick.order,
  }));

  return {
    match_id: slim.match_id,
    start_time: slim.start_time ?? null,
    patch: slim.patch ?? null,
    leagueid: slim.leagueid ?? null,
    series_id: slim.series_id ?? null,
    series_type: slim.series_type ?? null,
    radiant_win: slim.radiant_win ?? null,
    radiant_team_id: slim.radiant_team_id ?? null,
    dire_team_id: slim.dire_team_id ?? null,
    radiant_name: teamName(full, 'radiant'),
    dire_name: teamName(full, 'dire'),
    players,
    picks_bans: picksBans,
  };
}

function main() {
  const slim = JSON.parse(fs.readFileSync(SLIM_PATH, 'utf8'));
  const cache = fs.existsSync(CACHE_PATH)
    ? JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))
    : {};

  const short = {};
  let withDraft = 0;

  for (const [id, match] of Object.entries(slim)) {
    const full = cache[id] || null;
    const row = shortenMatch(match, full);
    if (row.picks_bans.length > 0) withDraft += 1;
    short[id] = row;
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(short));
  console.log(
    `Wrote ${Object.keys(short).length} matches (${withDraft} with picks/bans) to ${OUT_PATH}`
  );
}

main();
