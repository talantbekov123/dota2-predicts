const fs = require('fs');
const path = require('path');

const MATCH_CACHE_PATH = path.join(__dirname, 'matches-cache.json');
const BASE_URL = 'https://api.opendota.com/api';

const SERIES_TYPE_LABEL = {
  0: 'Non-series',
  1: 'Bo3',
  2: 'Bo5',
};

function loadMatchCache() {
  if (!fs.existsSync(MATCH_CACHE_PATH)) {
    throw new Error(`Кэш не найден: ${MATCH_CACHE_PATH}. Сначала запустите meta.js`);
  }
  return JSON.parse(fs.readFileSync(MATCH_CACHE_PATH, 'utf8'));
}

async function loadHeroNames() {
  try {
    const res = await fetch(`${BASE_URL}/heroes`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const heroes = await res.json();
    return Object.fromEntries(heroes.map((h) => [h.id, h.localized_name]));
  } catch (err) {
    console.warn('Не удалось загрузить имена героев, будут показаны id:', err.message);
    return {};
  }
}

function heroLabel(heroId, heroMap) {
  return heroMap[heroId] || `Hero(${heroId})`;
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

function formatPickList(heroIds, heroMap) {
  const names = heroIds.map((id) => heroLabel(id, heroMap)).join(', ');
  const ids = heroIds.join(', ');
  return `${names}  [${ids}]`;
}

function groupBySeries(matches) {
  const groups = new Map();

  for (const match of matches) {
    const key = match.series_id ?? `solo-${match.match_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        seriesId: match.series_id,
        seriesType: match.series_type,
        matches: [],
      });
    }
    groups.get(key).matches.push(match);
  }

  for (const group of groups.values()) {
    group.matches.sort((a, b) => a.start_time - b.start_time);
  }

  return [...groups.values()].sort(
    (a, b) => a.matches[0].start_time - b.matches[0].start_time
  );
}

function seriesScore(matches) {
  const scoreByTeam = {};

  for (const match of matches) {
    const radiant = match.radiant_name || 'Radiant';
    const dire = match.dire_name || 'Dire';
    scoreByTeam[radiant] ??= 0;
    scoreByTeam[dire] ??= 0;
    if (match.radiant_win) scoreByTeam[radiant] += 1;
    else scoreByTeam[dire] += 1;
  }

  return scoreByTeam;
}

function printSeries(group, heroMap, index, total) {
  const { seriesId, seriesType, matches } = group;
  const first = matches[0];
  const teamA = first.radiant_name || 'Radiant';
  const teamB = first.dire_name || 'Dire';
  const label = SERIES_TYPE_LABEL[seriesType] || `type ${seriesType}`;
  const score = seriesScore(matches);
  const scoreStr = Object.entries(score)
    .map(([name, wins]) => `${name} ${wins}`)
    .join(' — ');

  console.log('\n' + '='.repeat(72));
  console.log(
    `SERIES ${index}/${total}  |  ${label}  |  series_id: ${seriesId ?? 'n/a'}`
  );
  console.log(`${teamA}  vs  ${teamB}`);
  console.log(`Счёт серии: ${scoreStr}`);
  console.log('='.repeat(72));

  matches.forEach((match, gameIdx) => {
    const { radiant, dire } = getTeamPicks(match);
    const radiantName = match.radiant_name || 'Radiant';
    const direName = match.dire_name || 'Dire';
    const winner = match.radiant_win ? radiantName : direName;

    console.log(`\n  Game ${gameIdx + 1}  |  match_id: ${match.match_id}  |  winner: ${winner}`);
    console.log(`  ${radiantName} (Radiant):`);
    console.log(`    ${formatPickList(radiant, heroMap)}`);
    console.log(`  ${direName} (Dire):`);
    console.log(`    ${formatPickList(dire, heroMap)}`);
  });
}

async function main() {
  const cache = loadMatchCache();
  const matches = Object.values(cache);
  const heroMap = await loadHeroNames();
  const series = groupBySeries(matches);

  console.log(`Матчей в кэше: ${matches.length}`);
  console.log(`Серий: ${series.length}`);

  series.forEach((group, i) => {
    printSeries(group, heroMap, i + 1, series.length);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
