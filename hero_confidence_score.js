/**
 * Считает heroConfidenceScore на основе винрейта и количества игр,
 * используя Wilson score interval (нижняя граница доверительного интервала).
 *
 * Это стандартный статистический метод (используется, например, Reddit
 * для ранжирования комментариев) - даёт честную "консервативную" оценку:
 * чем меньше игр, тем сильнее оценка занижается относительно голого винрейта,
 * без искусственного двойного штрафа.
 *
 * @param {number} winRate - винрейт от 0 до 1 (например 0.55 = 55%)
 * @param {number} gameCount - количество сыгранных игр
 * @param {number} [z=1.96] - z-score для уровня доверия (1.96 = 95%, 1.44 = 85%)
 * @returns {number} heroConfidenceScore от 0 до 100
 */
function heroConfidenceScore(winRate, gameCount, z = 1.96) {
  if (!gameCount || gameCount <= 0) return 0;

  const p = Math.max(0, Math.min(1, winRate));
  const n = gameCount;
  const z2 = z * z;

  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));

  const lowerBound = (centre - margin) / denominator;

  return Math.round(Math.max(0, Math.min(1, lowerBound)) * 100);
}

/**
 * TEST-3A: байесовское / Лапласово сглаживание винрейта.
 *   smoothed = (wins + C * prior) / (n + C)
 * при prior=0.5, C=5: (wins + 2.5) / (n + 5)
 *
 * @param {number} winRate - винрейт 0..1
 * @param {number} gameCount
 * @param {number} [C=5] - сила априора (псевдо-игры)
 * @param {number} [prior=0.5] - априорный винрейт
 * @returns {number} score 0..100
 */
function bayesianSmoothScore(winRate, gameCount, C = 5, prior = 0.5) {
  const n = Math.max(0, Number(gameCount) || 0);
  const p = n > 0 ? Math.max(0, Math.min(1, winRate)) : prior;
  const wins = n > 0 ? p * n : 0;
  const smoothed = (wins + C * prior) / (n + C);
  return Math.round(Math.max(0, Math.min(1, smoothed)) * 100);
}

module.exports = { heroConfidenceScore, bayesianSmoothScore };

if (require.main === module) {
  console.log('Wilson:', heroConfidenceScore(0.55, 100), heroConfidenceScore(1.0, 4));
  console.log('Bayes C=5:', bayesianSmoothScore(0.55, 100), bayesianSmoothScore(1.0, 4));
}
