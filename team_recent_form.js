/**
 * team_recent_form — оценка текущей формы команды по последним играм.
 *
 * Идея:
 *  - win_coefficient (коэффициент букмекера) переводим в implied probability:
 *      p = 1 / coefficient  — вероятность победы по мнению рынка
 *  - Очки за игру (score_i), диапазон (-1..1), без искусственного клампа —
 *    ограничение естественное, т.к. p всегда в (0..1):
 *      если победа:  score = 1 - p   (чем выше коэф. — тем неожиданнее победа андердога — тем больше очков)
 *      если поражение: score = -p    (чем ниже коэф. — тем сильнее был фаворитом — тем больнее штраф)
 *  - Вес каждой игры в выборке одинаковый (статичный) — форма считается
 *    как простое среднее score_i по последним N играм
 *  - Итог нормализуем в шкалу 0..100 для удобства сравнения команд
 *
 * @param {Array<{win_coefficient: number, is_winner: boolean}>} games - список игр
 *        (порядок: от старых к новым; если наоборот — передайте newestFirst: true)
 * @param {Object} [options]
 * @param {number} [options.limit=20] - сколько последних игр учитывать
 * @param {boolean} [options.newestFirst=false] - true, если games[0] это самая свежая игра
 * @returns {{form: number, rawForm: number, gamesAnalyzed: number, details: Array}}
 */
function team_recent_form(games, options = {}) {
    const { limit = 20, newestFirst = false } = options;
  
    if (!Array.isArray(games) || games.length === 0) {
      return { form: 50, rawForm: 0, gamesAnalyzed: 0, details: [] };
    }
  
    // Приводим к порядку "от старых к новым" и берём последние N
    let chronological = newestFirst ? [...games].reverse() : games;
    const recent = chronological.slice(-limit);
    const N = recent.length;
  
    let weightedSum = 0;
    let totalWeight = 0;
    const details = [];
  
    recent.forEach((game, idx) => {
      const c = Number(game.win_coefficient);
      const isWinner = Boolean(game.is_winner);
  
      if (!c || c <= 1) {
        // некорректный коэффициент — пропускаем, чтобы не портить статистику
        return;
      }
  
      const impliedProb = 1 / c; // насколько команда считалась фаворитом
  
      // Очки за игру: -1..1
      const gameScore = isWinner ? 1 - impliedProb : -impliedProb;
  
      // Вес игры статичный — все игры в выборке учитываются одинаково
      weightedSum += gameScore;
      totalWeight += 1;
  
      details.push({
        win_coefficient: c,
        is_winner: isWinner,
        impliedProb: Number(impliedProb.toFixed(3)),
        gameScore: Number(gameScore.toFixed(3)),
      });
    });
  
    if (totalWeight === 0) {
      return { form: 50, rawForm: 0, gamesAnalyzed: 0, details: [] };
    }
  
    const rawForm = weightedSum / totalWeight; // диапазон примерно -1..1
    const formScore = ((rawForm + 1) / 2) * 100; // нормализация в 0..100
  
    return {
      form: Number(formScore.toFixed(2)),
      rawForm: Number(rawForm.toFixed(4)),
      gamesAnalyzed: details.length,
      details,
    };
  }
  
  module.exports = { team_recent_form };
  
  // ---- пример использования ----
  if (require.main === module) {
    const teamA = [
      { win_coefficient: 1.2, is_winner: true },  // фаворит выиграл — мало очков
      { win_coefficient: 4.5, is_winner: true },  // андердог выиграл — много очков
      { win_coefficient: 1.15, is_winner: false }, // фаворит проиграл — большой штраф
      { win_coefficient: 3.0, is_winner: false },  // андердог проиграл — маленький штраф
      { win_coefficient: 2.0, is_winner: true },
    ];
  
    console.log("Team A form:", team_recent_form(teamA));
  }