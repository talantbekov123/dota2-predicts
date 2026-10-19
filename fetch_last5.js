const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const CACHE_PATH = path.join(ROOT, 'matches-cache.json');
const INCOMING_PATH = path.join(ROOT, 'matches-incoming-cache.json');
const BASE = 'https://api.opendota.com/api';

const LEAGUES = [
  { id: 19944, file: 'epl-masters-matches.txt' },
  { id: 20411, file: 'qiji-cup-matches.txt' },
  { id: 20334, file: 'nexus-series-ii-matches.txt' },
  { id: 20406, file: '1win-streamers-league-3-matches.txt' },
  { id: 20359, file: 'dreamleague-s30-qualifiers-matches.txt' },
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, attempt = 0) {
  const res = await fetch(url, { headers: { 'User-Agent': 'dota2-prediction' } });
  if (res.status === 429 && attempt < 8) {
    const wait = 5000 * (attempt + 1);
    console.log(`429 ${url} waiting ${wait}ms`);
    await delay(wait);
    return fetchJson(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function main() {
  const cache = fs.existsSync(CACHE_PATH)
    ? JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'))
    : {};
  const incoming = fs.existsSync(INCOMING_PATH)
    ? JSON.parse(fs.readFileSync(INCOMING_PATH, 'utf8'))
    : {};

  const ids = [];
  for (const league of LEAGUES) {
    const matches = await fetchJson(`${BASE}/leagues/${league.id}/matches`);
    const sorted = [...matches].sort((a, b) => b.match_id - a.match_id);
    fs.writeFileSync(
      path.join(ROOT, league.file),
      sorted.map((match) => match.match_id).join('\n') + '\n'
    );
    console.log(`league ${league.id}: ${sorted.length} ids -> ${league.file}`);
    for (const match of sorted) ids.push(match.match_id);
    await delay(1100);
  }

  const unique = [...new Set(ids.map(String))];
  const missing = unique.filter((id) => !cache[id] && !incoming[id]);
  console.log(`unique ${unique.length}, already stored ${unique.length - missing.length}, to fetch ${missing.length}`);

  let fetched = 0;
  for (const id of missing) {
    try {
      incoming[id] = await fetchJson(`${BASE}/matches/${id}`);
      fetched += 1;
      console.log(`[${fetched}/${missing.length}] ${id}`);
      if (fetched % 25 === 0) {
        fs.writeFileSync(INCOMING_PATH, JSON.stringify(incoming));
        console.log(`saved incoming ${Object.keys(incoming).length}`);
      }
    } catch (err) {
      console.error(`fail ${id}: ${err.message}`);
    }
    await delay(1100);
  }

  fs.writeFileSync(INCOMING_PATH, JSON.stringify(incoming));
  const merged = { ...cache, ...incoming };
  fs.writeFileSync(CACHE_PATH, JSON.stringify(merged));
  fs.unlinkSync(INCOMING_PATH);
  console.log(`cache ${Object.keys(merged).length} (added ${Object.keys(incoming).length})`);

  await new Promise((resolve, reject) => {
    const child = spawn('node', ['build_matches_short.js'], { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`short build ${code}`))));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
