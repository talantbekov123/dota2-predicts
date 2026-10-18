const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHORT_PATH = path.join(ROOT, 'matches-short.json');
const ODDS_PATH = path.join(ROOT, 'odds-cache.json');
const DEFAULT_LIST = path.join(ROOT, 'backtest-matches.txt');

/**
 * Each file in this folder (except run.js) is one algorithm.
 *
 * module.exports = {
 *   name: 'my-algo',
 *   predict({ match, history }) {
 *     // history = matches with start_time < match.start_time, oldest first.
 *     // return { pick: 'radiant' | 'dire' | null, edge?: number }
 *     // null = abstain
 *   },
 * };
 */

function loadShortMatches() {
  if (!fs.existsSync(SHORT_PATH)) {
    throw new Error(`Нет ${SHORT_PATH}. Сначала: node build_matches_short.js`);
  }
  return JSON.parse(fs.readFileSync(SHORT_PATH, 'utf8'));
}

function loadMatchIds(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function loadAlgorithms(onlyName) {
  const files = fs
    .readdirSync(__dirname)
    .filter((file) => file.endsWith('.js') && file !== 'run.js' && !file.startsWith('_'))
    .sort();

  const algorithms = [];
  for (const file of files) {
    const mod = require(path.join(__dirname, file));
    if (typeof mod.predict !== 'function') {
      console.warn(`Пропуск ${file}: нет predict()`);
      continue;
    }
    const name = mod.name || path.basename(file, '.js');
    if (onlyName && name !== onlyName && file !== onlyName && path.basename(file, '.js') !== onlyName) {
      continue;
    }
    algorithms.push({
      name,
      predict: mod.predict,
      file,
      splitResults: Boolean(mod.splitResults),
    });
  }

  if (algorithms.length === 0) {
    throw new Error(
      onlyName
        ? `Алгоритм «${onlyName}» не найден в algorithms/`
        : 'В algorithms/ нет файлов с predict()'
    );
  }
  return algorithms;
}

function historyBefore(sorted, match) {
  const cutoff = match.start_time;
  if (cutoff == null) return [];
  let end = 0;
  while (end < sorted.length && sorted[end].start_time < cutoff) end += 1;
  return sorted.slice(0, end);
}

function actualSide(match) {
  return match.radiant_win ? 'radiant' : 'dire';
}

function sideLabel(match, side) {
  if (side === 'radiant') return match.radiant_name || `team ${match.radiant_team_id}`;
  if (side === 'dire') return match.dire_name || `team ${match.dire_team_id}`;
  return 'abstain';
}

function loadOdds() {
  if (!fs.existsSync(ODDS_PATH)) return {};
  return JSON.parse(fs.readFileSync(ODDS_PATH, 'utf8'));
}

function matchOdds(oddsCache, matchId) {
  const entry = oddsCache[String(matchId)];
  if (!entry?.odds) return null;
  const radiant = Number(entry.odds.radiant);
  const dire = Number(entry.odds.dire);
  if (!radiant || !dire) return null;
  return {
    radiant,
    dire,
    bookmaker: entry.odds.bookmaker || 'book',
  };
}

function oddsLabel(odds) {
  if (!odds) return 'odds n/a';
  return `odds ${odds.bookmaker} ${odds.radiant}/${odds.dire}`;
}

function parseArgs(argv) {
  let filePath = DEFAULT_LIST;
  let only = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-f' || arg === '--file') {
      filePath = path.resolve(argv[++i]);
    } else if (arg === '--only') {
      only = argv[++i];
    } else if (!arg.startsWith('-')) {
      only = arg;
    }
  }
  return { filePath, only };
}

function resultLine(job, pick, edge, mark) {
  const markText = mark ? `  ${mark}` : '';
  const edgeText = edge == null ? '' : `  edge ${edge}`;
  return `  ${job.id}  ${sideLabel(job.match, 'radiant')} vs ${sideLabel(job.match, 'dire')}  pick ${sideLabel(job.match, pick)}${markText}${edgeText}  ${oddsLabel(job.odds)}`;
}

function printSplit(correctLines, incorrectLines) {
  console.log(`\n  correct (${correctLines.length})`);
  for (const line of correctLines) console.log(line);
  console.log(`\n  not correct (${incorrectLines.length})`);
  for (const line of incorrectLines) console.log(line);
}

function runAlgorithm(algorithm, jobs) {
  let hits = 0;
  let decided = 0;
  let abstain = 0;
  let missing = 0;
  let errors = 0;
  const correctLines = [];
  const incorrectLines = [];

  console.log(`\n${algorithm.name}`);

  for (const job of jobs) {
    if (!job.match) {
      missing += 1;
      console.log(`  ${job.id}  missing`);
      continue;
    }

    let result;
    try {
      result = algorithm.predict({ match: job.match, history: job.history }) || {};
    } catch (err) {
      errors += 1;
      console.log(`  ${job.id}  ERROR ${err.message}`);
      continue;
    }

    const pick = result.pick ?? null;
    if (pick !== 'radiant' && pick !== 'dire') {
      abstain += 1;
      console.log(
        `  ${job.id}  ${sideLabel(job.match, 'radiant')} vs ${sideLabel(job.match, 'dire')}  abstain  ${oddsLabel(job.odds)}`
      );
      continue;
    }

    decided += 1;
    const correct = pick === job.actual;
    if (correct) hits += 1;
    if (algorithm.splitResults) {
      const line = resultLine(job, pick, result.edge, null);
      if (correct) correctLines.push(line);
      else incorrectLines.push(line);
    } else {
      console.log(resultLine(job, pick, result.edge, correct ? 'ok' : 'miss'));
    }
  }

  if (algorithm.splitResults) printSplit(correctLines, incorrectLines);

  const pct = decided ? ((hits / decided) * 100).toFixed(1) : '0.0';
  const summary = `${hits}/${decided} (${pct}%)  abstain=${abstain}  missing=${missing}  errors=${errors}`;
  console.log(`  ${summary}`);
  return { name: algorithm.name, hits, decided, abstain, missing, errors, pct };
}

function main() {
  const { filePath, only } = parseArgs(process.argv.slice(2));
  const short = loadShortMatches();
  const oddsCache = loadOdds();
  const sorted = Object.values(short)
    .filter((match) => match.start_time != null)
    .sort((a, b) => a.start_time - b.start_time);
  const ids = loadMatchIds(filePath);
  const algorithms = loadAlgorithms(only);

  const jobs = ids.map((id) => {
    const match = short[id] || null;
    return {
      id,
      match,
      actual: match ? actualSide(match) : null,
      history: match ? historyBefore(sorted, match) : [],
      odds: matchOdds(oddsCache, id),
    };
  });

  console.log(`matches: ${ids.length}  file: ${path.relative(ROOT, filePath) || filePath}`);
  console.log(`algorithms: ${algorithms.map((algorithm) => algorithm.name).join(', ')}`);

  const rows = algorithms.map((algorithm) => runAlgorithm(algorithm, jobs));

  if (rows.length > 1) {
    console.log('\ncompare');
    for (const row of rows) {
      console.log(`  ${row.name}  ${row.hits}/${row.decided} (${row.pct}%)`);
    }
  }
}

main();
