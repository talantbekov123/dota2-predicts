const fs = require('fs');
const path = require('path');
const { sumTeamWinrates } = require('./sum_team_winrates');

const MATCH_CACHE_PATH = path.join(__dirname, 'matches-cache.json');

const SERIES_TYPE_LABEL = {
  0: 'Non-series',
  1: 'Bo3',
  2: 'Bo5',
};

/** Только эти серии участвуют в бектесте (порядок игр как в списке). */
const BACKTEST_SERIES = [
  {
    label: 'Iron Wing vs Team Liquid',
    seriesId: 1130564,
    matchIds: [8946337070, 8946414154, 8946495628],
  },
  {
    label: 'TEAM VISION vs Team Falcons',
    seriesId: 1130069,
    matchIds: [8943267925, 8943364918, 8943477775],
  },
  {
    label: 'BoomBoys vs Iron Wing',
    seriesId: 1130060,
    matchIds: [8943202720, 8943278347, 8943357930],
  },
  {
    label: 'Team Yandex vs Team Liquid',
    seriesId: 1130281,
    matchIds: [8944475950, 8944525313, 8944570404],
  },
  {
    label: 'Aurora Gaming vs Team Liquid',
    seriesId: 1130669,
    matchIds: [8946740853, 8946860406, 8946996385],
  },
  {
    label: 'Team Falcons vs BoomBoys',
    seriesId: 1130641,
    matchIds: [8946648249, 8946758310, 8946889239],
  },
  {
    label: 'Team Yandex vs Aurora Gaming',
    seriesId: 1130328,
    matchIds: [8944841068, 8944931337, 8945052416],
  },
];

function loadMatchCache() {
  if (!fs.existsSync(MATCH_CACHE_PATH)) {
    throw new Error(`Кэш не найден: ${MATCH_CACHE_PATH}. Сначала запустите meta.js`);
  }
  return JSON.parse(fs.readFileSync(MATCH_CACHE_PATH, 'utf8'));
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

function resolveBacktestSeries(cache) {
  const groups = [];

  for (const spec of BACKTEST_SERIES) {
    const matches = [];
    const missing = [];

    for (const matchId of spec.matchIds) {
      const match = cache[String(matchId)] || cache[matchId];
      if (!match) missing.push(matchId);
      else matches.push(match);
    }

    if (missing.length) {
      console.warn(
        `⚠ ${spec.label} (series_id ${spec.seriesId}): нет в кэше match_id: ${missing.join(', ')}`
      );
    }

    if (matches.length === 0) continue;

    groups.push({
      seriesId: spec.seriesId,
      seriesType: matches[0].series_type,
      label: spec.label,
      matches,
    });
  }

  return groups;
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

  return Object.entries(scoreByTeam)
    .map(([name, wins]) => `${name} ${wins}`)
    .join(' — ');
}

/**
 * Для матча из кэша: берёт пики → sumTeamWinrates → суммы обеих сторон.
 */
function analyzeMatch(match) {
  const radiantName = match.radiant_name || 'Radiant';
  const direName = match.dire_name || 'Dire';
  const { radiant, dire } = getTeamPicks(match);

  const { team1, team2 } = sumTeamWinrates(radiant, dire);
  const winner = match.radiant_win ? radiantName : direName;
  const predicted =
    team1.sumWinrate === team2.sumWinrate
      ? 'tie'
      : team1.sumWinrate > team2.sumWinrate
        ? radiantName
        : direName;

  return {
    matchId: match.match_id,
    radiantName,
    direName,
    radiantPicks: radiant,
    direPicks: dire,
    radiantSum: team1.sumWinrate,
    direSum: team2.sumWinrate,
    radiantExcluded: team1.excludedMatches,
    direExcluded: team2.excludedMatches,
    winner,
    predicted,
    correct: predicted !== 'tie' && predicted === winner,
  };
}

function printSeries(group, analyses, index, total) {
  const { seriesId, seriesType, matches, label } = group;
  const typeLabel = SERIES_TYPE_LABEL[seriesType] || `type ${seriesType}`;

  console.log('\n' + '='.repeat(72));
  console.log(
    `SERIES ${index}/${total}  |  ${typeLabel}  |  series_id: ${seriesId ?? 'n/a'}`
  );
  console.log(label || `${matches[0].radiant_name}  vs  ${matches[0].dire_name}`);
  console.log(`Счёт серии: ${seriesScore(matches)}`);
  console.log('='.repeat(72));

  let hits = 0;
  let decided = 0;

  analyses.forEach((a, gameIdx) => {
    const mark =
      a.predicted === 'tie' ? '~' : a.correct ? '✓' : '✗';

    if (a.predicted !== 'tie') {
      decided += 1;
      if (a.correct) hits += 1;
    }

    console.log(`\n  Game ${gameIdx + 1}  |  match_id: ${a.matchId}  |  winner: ${a.winner}  [${mark}]`);
    console.log(
      `  ${a.radiantName} (Radiant): sum=${a.radiantSum}  picks=[${a.radiantPicks.join(', ')}]  excl=${a.radiantExcluded}`
    );
    console.log(
      `  ${a.direName} (Dire):     sum=${a.direSum}  picks=[${a.direPicks.join(', ')}]  excl=${a.direExcluded}`
    );
    console.log(
      `  преимущество по сумме: ${
        a.predicted === 'tie'
          ? 'ничья'
          : `${a.predicted} (+${Math.abs(a.radiantSum - a.direSum).toFixed(1)})`
      }`
    );
  });

  if (decided > 0) {
    console.log(
      `\n  Серия: угадал ${hits}/${decided} (${((hits / decided) * 100).toFixed(0)}%)`
    );
  }

  return { hits, decided };
}

function main() {
  const cache = loadMatchCache();
  const series = resolveBacktestSeries(cache);

  console.log(
    `Бектест: ${series.length} серий, ${BACKTEST_SERIES.reduce((n, s) => n + s.matchIds.length, 0)} матчей`
  );

  let totalHits = 0;
  let totalDecided = 0;

  series.forEach((group, i) => {
    const analyses = group.matches.map(analyzeMatch);
    const { hits, decided } = printSeries(group, analyses, i + 1, series.length);
    totalHits += hits;
    totalDecided += decided;
  });

  console.log('\n' + '='.repeat(72));
  console.log(
    `ИТОГО: ${totalHits}/${totalDecided} (${
      totalDecided ? ((totalHits / totalDecided) * 100).toFixed(1) : 0
    }%)`
  );
}

main();
