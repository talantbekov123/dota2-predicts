const fs = require('fs');
const path = require('path');
const { buildPlayerHeroStats } = require('./player_hero_winrates');

const MATCH_CACHE_PATH = path.join(__dirname, 'matches-cache.json');
const BASE_URL = 'https://api.opendota.com/api';

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
  } catch {
    return {};
  }
}

/**
 * Собирает известных игроков из кэша: account_id + имена.
 */
function buildPlayerIndex(cache) {
  const byAccount = new Map();
  const byName = new Map();

  for (const match of Object.values(cache)) {
    for (const p of match.players || []) {
      if (p.account_id == null) continue;

      const display = p.name || p.personaname || `account:${p.account_id}`;
      if (!byAccount.has(p.account_id)) {
        byAccount.set(p.account_id, display);
      }

      for (const raw of [p.name, p.personaname]) {
        if (!raw) continue;
        const key = String(raw).toLowerCase();
        byName.set(key, { accountId: p.account_id, player: display });
      }
    }
  }

  return { byAccount, byName };
}

function resolvePlayer(query, playerIndex) {
  const q = String(query).trim();
  if (!q) throw new Error('Не указан игрок');

  if (/^\d+$/.test(q)) {
    const accountId = Number(q);
    const player = playerIndex.byAccount.get(accountId);
    if (!player) {
      throw new Error(`Игрок account_id=${accountId} не найден в кэше турнира`);
    }
    return { accountId, player };
  }

  const exact = playerIndex.byName.get(q.toLowerCase());
  if (exact) return exact;

  const partial = [...playerIndex.byName.entries()]
    .filter(([name]) => name.includes(q.toLowerCase()))
    .map(([, v]) => v);

  const unique = [...new Map(partial.map((p) => [p.accountId, p])).values()];
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) {
    throw new Error(
      `Несколько игроков похожи на "${q}": ${unique.map((p) => p.player).join(', ')}`
    );
  }
  throw new Error(`Игрок "${q}" не найден в кэше турнира`);
}

function resolveHero(query, heroMap) {
  const q = String(query).trim();
  if (!q) throw new Error('Не указан герой');

  if (/^\d+$/.test(q)) {
    const heroId = Number(q);
    return {
      heroId,
      hero: heroMap[heroId] || `Hero(${heroId})`,
    };
  }

  const entries = Object.entries(heroMap);
  const lower = q.toLowerCase();

  const exact = entries.find(([, name]) => name.toLowerCase() === lower);
  if (exact) return { heroId: Number(exact[0]), hero: exact[1] };

  const partial = entries.filter(([, name]) => name.toLowerCase().includes(lower));
  if (partial.length === 1) {
    return { heroId: Number(partial[0][0]), hero: partial[0][1] };
  }
  if (partial.length > 1) {
    throw new Error(
      `Несколько героев похожи на "${q}": ${partial.map(([, n]) => n).join(', ')}`
    );
  }
  throw new Error(`Герой "${q}" не найден`);
}

/**
 * Винрейт конкретного игрока на конкретном герое по турнирному кэшу.
 *
 * @param {string|number} playerQuery - имя игрока или account_id
 * @param {string|number} heroQuery - имя героя или hero_id
 * @param {object} [options]
 * @param {Object} [options.heroMap] - id -> имя героя
 */
function getPlayerHeroWinrate(playerQuery, heroQuery, options = {}) {
  const { heroMap = {} } = options;
  const cache = loadMatchCache();
  const playerIndex = buildPlayerIndex(cache);
  const { accountId, player } = resolvePlayer(playerQuery, playerIndex);
  const { heroId, hero } = resolveHero(heroQuery, heroMap);
  const stats = buildPlayerHeroStats();
  const entry = stats[accountId]?.[heroId];
  const picks = entry?.picks ?? 0;
  const wins = entry?.wins ?? 0;
  const winrate = picks > 0 ? Number(((wins / picks) * 100).toFixed(1)) : null;

  return {
    accountId,
    player,
    heroId,
    hero,
    picks,
    wins,
    winrate,
  };
}

function printResult(result) {
  console.log(`\nplayer: ${result.player} (account_id=${result.accountId})`);
  console.log(`hero:   ${result.hero} (hero_id=${result.heroId})`);
  console.table([
    {
      player: result.player,
      hero: result.hero,
      games: result.picks,
      wins: result.wins,
      winrate: result.winrate == null ? 'n/a' : `${result.winrate}%`,
    },
  ]);
}

function printUsage() {
  console.log(`Usage:
  node get_player_hero_winrate.js <player> <hero>

Examples:
  node get_player_hero_winrate.js Nisha Invoker
  node get_player_hero_winrate.js 86745912 74
  node get_player_hero_winrate.js "m1CKe" "Shadow Fiend"`);
}

module.exports = {
  getPlayerHeroWinrate,
};

if (require.main === module) {
  (async () => {
    const playerQuery = process.argv[2];
    const heroQuery = process.argv.slice(3).join(' ');

    if (!playerQuery || !heroQuery) {
      printUsage();
      process.exit(1);
    }

    const heroMap = await loadHeroNames();
    printResult(getPlayerHeroWinrate(playerQuery, heroQuery, { heroMap }));
  })().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
