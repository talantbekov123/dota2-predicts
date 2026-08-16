/**
 * team_baseline_style — определяет базовый стиль команды (early_smoke / mid_push / late_scaling)
 * на основе истории её матчей, используя бесплатный OpenDota API.
 *
 * Это НЕ то же самое, что классификация одного конкретного драфта (см. dota_composition_classifier.js).
 * Это "привычка" команды — как она играет чаще всего, посчитанная по фактам, а не по драфту.
 * Дальше baseline_style конкретной команды можно сравнивать с classifyDotaComposition() для
 * текущего драфта — это и будет "draft_plan_execution_fit":
 *   - если baseline_style команды совпадает с классификацией её нового драфта — команда играет "в своей колее"
 *   - если не совпадает — команда пытается сыграть непривычный для себя план (выше риск)
 *
 * ВАЖНО: api.opendota.com не входит в белый список доменов текущей песочницы,
 * поэтому этот скрипт нужно запускать в вашем окружении (Node.js с доступом в интернет).
 *
 * @param {number} teamId - OpenDota team_id (найти можно через /api/search?q=team_name)
 * @param {Object} [options]
 * @param {number} [options.limit=20] - сколько последних матчей анализировать
 * @returns {Promise<{baseline_style: string, confidence: number, distribution: Object, matchesAnalyzed: number}>}
 */
async function teamBaselineStyle(teamId, options = {}) {
    const { limit = 20 } = options;
  
    // 1. Список последних матчей команды
    const matchesRes = await fetch(`https://api.opendota.com/api/teams/${teamId}/matches`);
    if (!matchesRes.ok) throw new Error(`OpenDota matches error ${matchesRes.status}`);
    const matches = (await matchesRes.json()).slice(0, limit);
  
    const tags = [];
  
    for (const m of matches) {
      // 2. Детали каждого матча — нужен gold_adv по времени
      const detailRes = await fetch(`https://api.opendota.com/api/matches/${m.match_id}`);
      if (!detailRes.ok) continue;
      const detail = await detailRes.json();
  
      const duration = detail.duration; // секунды
      const goldAdv = detail.radiant_gold_adv; // массив лида голда по минутам (radiant - dire)
  
      if (!goldAdv || goldAdv.length === 0) continue;
  
      // Была ли эта команда radiant или dire в данном матче — знак лида нужно перевернуть, если dire
      const isRadiant = m.radiant === true;
      const teamGoldAdv = isRadiant ? goldAdv : goldAdv.map((g) => -g);
  
      const tag = classifyMatchByCurve(teamGoldAdv, duration);
      if (tag) tags.push(tag);
    }
  
    if (tags.length === 0) {
      return { baseline_style: null, confidence: 0, distribution: {}, matchesAnalyzed: 0 };
    }
  
    // 3. Мода — самый частый тег
    const distribution = tags.reduce((acc, t) => {
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {});
  
    const [baseline_style, count] = Object.entries(distribution).sort((a, b) => b[1] - a[1])[0];
    const confidence = Number((count / tags.length).toFixed(2));
  
    return { baseline_style, confidence, distribution, matchesAnalyzed: tags.length };
  }
  
  /**
   * classifyMatchByCurve — размечает один матч правилами на основе кривой голд-лида и длительности.
   * @param {number[]} teamGoldAdv - голд-лид ЭТОЙ команды по минутам (положительный = команда впереди)
   * @param {number} durationSec - длительность матча в секундах
   */
  function classifyMatchByCurve(teamGoldAdv, durationSec) {
    const durationMin = durationSec / 60;
  
    // Момент, когда команда впервые уверенно вышла вперёд (лид > 2000 голда)
    const THRESHOLD = 2000;
    const breakoutMin = teamGoldAdv.findIndex((g) => g > THRESHOLD);
  
    if (breakoutMin === -1) {
      // команда ни разу уверенно не лидировала — либо проиграла в невыгодной позиции,
      // либо выиграла "на классе" в самом конце — считаем late_scaling
      return "late_scaling";
    }
  
    if (breakoutMin <= 15 && durationMin <= 32) {
      return "early_smoke";
    }
    if (breakoutMin <= 30) {
      return "mid_push";
    }
    return "late_scaling";
  }
  
  module.exports = { teamBaselineStyle, classifyMatchByCurve };
  
  // ---- пример использования ----
  if (require.main === module) {
    // team_id нужно найти заранее, например через:
    // https://api.opendota.com/api/search?q=Team%20Spirit
    // const TEAM_SPIRIT_ID = 7119388;
    // const TEAM_YANDEX_ID = 9823272;
    const TEAM_PVISION_ID = 9824702;
    const TEAM_OG_ID = 2586976;
  
    teamBaselineStyle(PVISION_ID, { limit: 100 })
      .then((res) => console.log("Baseline style:", res))
      .catch((err) => console.error("Ошибка:", err.message));
  }