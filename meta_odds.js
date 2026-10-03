const fs = require('fs');
const path = require('path');

/**
 * meta_odds.js — кэш прематч-коэффициентов через OddsPapi
 * Docs: https://oddspapi.io/docs
 *
 * Берёт матчи из matches-cache.json (OpenDota), ищет fixture в OddsPapi
 * по командам + времени, тянет historical moneyline и сохраняет снимок
 * в odds-cache.json.
 *
 * Важно: OddsPapi fixture = СЕРИЯ (Bo3/Bo5), не одна карта OpenDota.
 * По умолчанию берём closing prematch ДО старта серии (не live посреди Bo3).
 *
 * Usage:
 *   node meta_odds.js
 *   node meta_odds.js 9025934049
 *   node meta_odds.js --force --mode series --minutes 20 9025934049
 *   node meta_odds.js --mode game 9025934049   # снимок за N мин до карты (live)
 */

const MATCH_CACHE_PATH = path.join(__dirname, 'matches-cache.json');
const ODDS_CACHE_PATH = path.join(__dirname, 'odds-cache.json');

const OPENDOTA_BASE = 'https://api.opendota.com/api';
const ODDSPAPI_BASE = 'https://api.oddspapi.io/v4';
const ODDSPAPI_KEY = '780fe6f7-6591-4bf0-a990-525844200b9e';

const DOTA_SPORT_ID = 16; // esport-dota
/** Букмекеры (historical-odds допускает max 3) */
const BOOKMAKERS = ['1xbet'];
/** Moneyline 2-way для Dota (1 / 2) */
const MONEYLINE_MARKET_ID = '161';
const OUTCOME_HOME = '161';
const OUTCOME_AWAY = '162';

const DEFAULT_MINUTES_BEFORE = 20;
/** series = до старта серии (правильно для прематча); game = до конкретной карты (часто live) */
const DEFAULT_MODE = 'series';
const FIXTURE_SEARCH_PAD_HOURS = 36;
const HISTORICAL_DELAY_MS = 5500;
const FIXTURES_DELAY_MS = 1200;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    console.warn(`Не удалось прочитать ${filePath}, начинаем с пустого`);
    return fallback;
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = new Error(
      data?.error?.message || `Request failed: ${url} (status ${res.status})`
    );
    err.status = res.status;
    err.body = data;
    err.retryMs = data?.error?.retryMs;
    throw err;
  }
  return data;
}

async function oddspapiGet(pathname, params = {}) {
  const url = new URL(`${ODDSPAPI_BASE}${pathname}`);
  url.searchParams.set('apiKey', ODDSPAPI_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fetchJson(url.toString());
    } catch (err) {
      if (err.status === 429 && attempt < 3) {
        const wait = Number(err.retryMs) || 5000;
        await delay(wait + 200);
        continue;
      }
      throw err;
    }
  }
  return null;
}

function normalizeTeamName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, ' ')
    .replace(/\b(team|esports|e sports|gaming|club|dota|dota2)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function namesMatch(a, b) {
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  return false;
}

async function getOpenDotaMatch(matchId, matchCache) {
  const key = String(matchId);
  if (matchCache[key]) return matchCache[key];
  const match = await fetchJson(`${OPENDOTA_BASE}/matches/${matchId}`);
  matchCache[key] = match;
  saveJson(MATCH_CACHE_PATH, matchCache);
  return match;
}

function getOpenDotaTeams(match) {
  return {
    radiant: match.radiant_name || match.radiant_team?.name || null,
    dire: match.dire_name || match.dire_team?.name || null,
    startTime: match.start_time || null,
  };
}

/**
 * Ищет OddsPapi fixture (серия) по командам около start_time карты.
 */
async function findOddsPapiFixture(radiant, dire, startTime) {
  const from = new Date((startTime - FIXTURE_SEARCH_PAD_HOURS * 3600) * 1000);
  const to = new Date((startTime + FIXTURE_SEARCH_PAD_HOURS * 3600) * 1000);

  // API: from/to не дальше чем 10 дней
  const maxSpanMs = 9.5 * 24 * 3600 * 1000;
  if (to - from > maxSpanMs) {
    from.setTime(startTime * 1000 - maxSpanMs / 2);
    to.setTime(startTime * 1000 + maxSpanMs / 2);
  }

  const fixtures = await oddspapiGet('/fixtures', {
    sportId: DOTA_SPORT_ID,
    from: from.toISOString(),
    to: to.toISOString(),
  });

  if (!Array.isArray(fixtures) || fixtures.length === 0) return null;

  let best = null;

  for (const fx of fixtures) {
    const p1 = fx.participant1Name;
    const p2 = fx.participant2Name;
    const direct = namesMatch(radiant, p1) && namesMatch(dire, p2);
    const swapped = namesMatch(radiant, p2) && namesMatch(dire, p1);
    if (!direct && !swapped) continue;

    const fxStart =
      Date.parse(fx.trueStartTime || fx.startTime || 0) / 1000 ||
      Date.parse(fx.startTime || 0) / 1000;
    const deltaSec = Math.abs(fxStart - startTime);

    if (!best || deltaSec < best.deltaSec) {
      best = {
        fixtureId: fx.fixtureId,
        participant1Id: fx.participant1Id,
        participant2Id: fx.participant2Id,
        participant1Name: p1,
        participant2Name: p2,
        tournamentId: fx.tournamentId,
        tournamentName: fx.tournamentName,
        startTime: fx.startTime,
        trueStartTime: fx.trueStartTime,
        trueEndTime: fx.trueEndTime,
        statusName: fx.statusName,
        hasOdds: fx.hasOdds,
        swappedSides: swapped,
        deltaSec,
      };
    }
  }

  return best;
}

function timelineFromHistorical(hist, bookmaker, marketId, outcomeId) {
  const series =
    hist?.bookmakers?.[bookmaker]?.markets?.[marketId]?.outcomes?.[outcomeId]
      ?.players?.['0'];
  return Array.isArray(series) ? series : [];
}

/**
 * Последняя котировка <= targetMs.
 * @param {boolean} [activeOnly=true] - только active:true (для прематча)
 */
function pickSnapshot(timeline, targetMs, activeOnly = true) {
  if (!timeline.length) return null;
  const sorted = [...timeline].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
  );
  const before = sorted.filter((x) => {
    if (Date.parse(x.createdAt) > targetMs) return false;
    if (activeOnly && x.active === false) return false;
    return true;
  });
  return before.at(-1) || null;
}

/**
 * Moneyline snapshot.
 * mode=series (default): за minutesBefore до trueStartTime СЕРИИ (closing prematch)
 * mode=game: за minutesBefore до OpenDota start_time карты (может быть live Bo3)
 */
function extractPrematchOdds(
  hist,
  fixture,
  radiantName,
  direName,
  gameStartUnix,
  minutesBefore,
  mode = DEFAULT_MODE
) {
  const seriesStartMs = Date.parse(
    fixture.trueStartTime || fixture.startTime || 0
  );

  let targetMs;
  let modeLabel;

  if (mode === 'game') {
    targetMs = (gameStartUnix - minutesBefore * 60) * 1000;
    modeLabel = `minutes_before_game_${minutesBefore}`;
  } else {
    // series prematch
    if (!seriesStartMs) return null;
    targetMs = seriesStartMs - minutesBefore * 60 * 1000;
    modeLabel = `minutes_before_series_${minutesBefore}`;
  }

  for (const bookmaker of BOOKMAKERS) {
    const homeTl = timelineFromHistorical(
      hist,
      bookmaker,
      MONEYLINE_MARKET_ID,
      OUTCOME_HOME
    );
    const awayTl = timelineFromHistorical(
      hist,
      bookmaker,
      MONEYLINE_MARKET_ID,
      OUTCOME_AWAY
    );
    if (!homeTl.length || !awayTl.length) continue;

    // для series — только active; для game допускаем inactive (линия могла сесть)
    const activeOnly = mode !== 'game';
    let homeSnap = pickSnapshot(homeTl, targetMs, activeOnly);
    let awaySnap = pickSnapshot(awayTl, targetMs, activeOnly);

    // fallback series: если за N минут пусто — последний active до старта серии
    if ((!homeSnap || !awaySnap) && mode === 'series' && seriesStartMs) {
      homeSnap = pickSnapshot(homeTl, seriesStartMs - 1, true);
      awaySnap = pickSnapshot(awayTl, seriesStartMs - 1, true);
      modeLabel = 'series_closing_prematch';
    }

    if (!homeSnap || !awaySnap) continue;

    const p1Odd = Number(homeSnap.price);
    const p2Odd = Number(awaySnap.price);
    if (!p1Odd || !p2Odd) continue;

    const radiantIsP1 = namesMatch(radiantName, fixture.participant1Name);
    const radiantOdd = radiantIsP1 ? p1Odd : p2Odd;
    const direOdd = radiantIsP1 ? p2Odd : p1Odd;

    return {
      bookmaker,
      marketId: Number(MONEYLINE_MARKET_ID),
      market: 'moneyline',
      mode: modeLabel,
      snapshotAt: homeSnap.createdAt,
      targetAt: new Date(targetMs).toISOString(),
      seriesStartAt: seriesStartMs
        ? new Date(seriesStartMs).toISOString()
        : null,
      participant1: p1Odd,
      participant2: p2Odd,
      radiant: radiantOdd,
      dire: direOdd,
      impliedProb: {
        radiant: Number((1 / radiantOdd).toFixed(4)),
        dire: Number((1 / direOdd).toFixed(4)),
      },
    };
  }

  return null;
}

/**
 * Fallback: текущие /odds (для ещё не сыгранных).
 */
function extractLiveOdds(oddsPayload, fixture, radiantName) {
  const bookmakerOdds = oddsPayload?.bookmakerOdds || {};
  for (const bookmaker of BOOKMAKERS) {
    const market =
      bookmakerOdds[bookmaker]?.markets?.[MONEYLINE_MARKET_ID] ||
      bookmakerOdds[bookmaker]?.markets?.[Number(MONEYLINE_MARKET_ID)];
    if (!market) continue;

    const home =
      market.outcomes?.[OUTCOME_HOME]?.players?.['0']?.price ??
      market.outcomes?.[OUTCOME_HOME]?.players?.[0]?.price;
    const away =
      market.outcomes?.[OUTCOME_AWAY]?.players?.['0']?.price ??
      market.outcomes?.[OUTCOME_AWAY]?.players?.[0]?.price;
    if (home == null || away == null) continue;

    const p1Odd = Number(home);
    const p2Odd = Number(away);
    const radiantIsP1 = namesMatch(radiantName, fixture.participant1Name);
    const radiantOdd = radiantIsP1 ? p1Odd : p2Odd;
    const direOdd = radiantIsP1 ? p2Odd : p1Odd;

    return {
      bookmaker,
      marketId: Number(MONEYLINE_MARKET_ID),
      market: 'moneyline',
      mode: 'current_odds',
      snapshotAt: new Date().toISOString(),
      targetAt: null,
      participant1: p1Odd,
      participant2: p2Odd,
      radiant: radiantOdd,
      dire: direOdd,
      impliedProb: {
        radiant: Number((1 / radiantOdd).toFixed(4)),
        dire: Number((1 / direOdd).toFixed(4)),
      },
    };
  }
  return null;
}

async function buildOddsEntry(opendotaMatchId, matchCache, options = {}) {
  const minutesBefore = options.minutesBefore ?? DEFAULT_MINUTES_BEFORE;
  const mode = options.mode ?? DEFAULT_MODE;
  const match = await getOpenDotaMatch(opendotaMatchId, matchCache);
  const { radiant, dire, startTime } = getOpenDotaTeams(match);

  const base = {
    opendotaMatchId: Number(opendotaMatchId),
    provider: 'oddspapi',
    radiant,
    dire,
    startTime,
    startTimeIso: startTime ? new Date(startTime * 1000).toISOString() : null,
    minutesBefore,
    mode,
    fixture: null,
    odds: null,
    error: null,
    fetchedAt: new Date().toISOString(),
  };

  if (!radiant || !dire || !startTime) {
    base.error = 'opendota_missing_teams_or_start_time';
    return base;
  }

  let fixture;
  try {
    fixture = await findOddsPapiFixture(radiant, dire, startTime);
  } catch (err) {
    base.error = `fixture_search_failed: ${err.message}`;
    return base;
  }

  if (!fixture) {
    base.error = 'oddspapi_fixture_not_found';
    return base;
  }

  base.fixture = fixture;
  await delay(FIXTURES_DELAY_MS);

  try {
    const hist = await oddspapiGet('/historical-odds', {
      fixtureId: fixture.fixtureId,
      bookmakers: BOOKMAKERS.join(','),
    });

    const odds = extractPrematchOdds(
      hist,
      fixture,
      radiant,
      dire,
      startTime,
      minutesBefore,
      mode
    );

    if (odds) {
      base.odds = odds;
      return base;
    }

    // fallback на текущие коэфы
    await delay(1500);
    const live = await oddspapiGet('/odds', {
      fixtureId: fixture.fixtureId,
      bookmakers: BOOKMAKERS.join(','),
    });
    const liveOdds = extractLiveOdds(live, fixture, radiant);
    if (liveOdds) {
      base.odds = liveOdds;
      return base;
    }

    base.error = 'odds_snapshot_not_found';
  } catch (err) {
    base.error = `odds_fetch_failed: ${err.message}`;
  }

  return base;
}

async function fillOddsCache(matchIds, options = {}) {
  const {
    force = false,
    minutesBefore = DEFAULT_MINUTES_BEFORE,
    mode = DEFAULT_MODE,
  } = options;
  const matchCache = loadJson(MATCH_CACHE_PATH, {});
  const oddsCache = loadJson(ODDS_CACHE_PATH, {});

  const ids =
    matchIds.length > 0 ? matchIds.map(String) : Object.keys(matchCache);

  if (ids.length === 0) {
    throw new Error(
      'Нет матчей: сначала заполни matches-cache.json (meta.js / fetch_last_n_matches.js)'
    );
  }

  console.log(`К обработке: ${ids.length}`);
  console.log(
    `provider=OddsPapi  mode=${mode}  minutesBefore=${minutesBefore}`
  );
  console.log(`кэш: ${ODDS_CACHE_PATH}`);

  let written = 0;
  let skipped = 0;
  let withOdds = 0;
  let errors = 0;

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (
      !force &&
      oddsCache[id]?.odds &&
      oddsCache[id]?.provider === 'oddspapi' &&
      oddsCache[id]?.mode === mode
    ) {
      skipped += 1;
      console.log(`[${i + 1}/${ids.length}] ${id} — уже есть odds, skip`);
      continue;
    }

    try {
      const entry = await buildOddsEntry(id, matchCache, {
        minutesBefore,
        mode,
      });
      oddsCache[id] = entry;
      saveJson(ODDS_CACHE_PATH, oddsCache);
      written += 1;

      if (entry.odds) {
        withOdds += 1;
        console.log(
          `[${i + 1}/${ids.length}] ${id}  ${entry.radiant} vs ${entry.dire}  →  ${entry.odds.radiant} / ${entry.odds.dire}  (${entry.odds.bookmaker}, ${entry.odds.mode})`
        );
      } else {
        errors += 1;
        console.log(
          `[${i + 1}/${ids.length}] ${id}  ${entry.radiant || '?'} vs ${entry.dire || '?'}  →  ${entry.error}`
        );
        if (entry.fixture) {
          console.log(
            `         fixture ${entry.fixture.fixtureId}  ${entry.fixture.participant1Name} vs ${entry.fixture.participant2Name}`
          );
        }
      }
    } catch (err) {
      errors += 1;
      console.error(`[${i + 1}/${ids.length}] ${id} ERROR:`, err.message);
    }

    if (i < ids.length - 1) await delay(HISTORICAL_DELAY_MS);
  }

  return { total: ids.length, written, skipped, withOdds, errors };
}

function parseArgs(argv) {
  const matchIds = [];
  let force = false;
  let minutesBefore = DEFAULT_MINUTES_BEFORE;
  let mode = DEFAULT_MODE;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg === '--minutes' || arg === '-m') {
      minutesBefore = Number(argv[++i]) || DEFAULT_MINUTES_BEFORE;
      continue;
    }
    if (arg === '--mode') {
      mode = String(argv[++i] || '').toLowerCase();
      if (mode !== 'series' && mode !== 'game') {
        throw new Error('--mode должен быть series или game');
      }
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      return { help: true };
    }
    if (/^\d+$/.test(arg)) {
      matchIds.push(arg);
      continue;
    }
    throw new Error(`Неизвестный аргумент: ${arg}`);
  }

  return { matchIds, force, minutesBefore, mode, help: false };
}

function printUsage() {
  console.log(`Usage:
  node meta_odds.js [--force] [--mode series|game] [--minutes 20] [matchId...]

Modes:
  series (default) — коэфы за N мин ДО старта серии (настоящий прематч)
  game             — коэфы за N мин ДО конкретной карты (часто уже live)

Examples:
  node meta_odds.js --force 9025934049
  node meta_odds.js --force --mode series --minutes 20 9025934049
  node meta_odds.js --force --mode game 9025934049

Источник: OddsPapi (https://api.oddspapi.io/v4)
Кэш: odds-cache.json`);
}

module.exports = {
  buildOddsEntry,
  fillOddsCache,
  findOddsPapiFixture,
  extractPrematchOdds,
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

    const result = await fillOddsCache(parsed.matchIds, {
      force: parsed.force,
      minutesBefore: parsed.minutesBefore,
      mode: parsed.mode,
    });


    console.log('\nГотово:');
    console.log(
      `всего=${result.total} записано=${result.written} skip=${result.skipped} с_коэфами=${result.withOdds} ошибок=${result.errors}`
    );
    console.log(`файл: ${ODDS_CACHE_PATH}`);
  })().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
