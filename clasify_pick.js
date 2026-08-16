/**
 * classifyDotaComposition — определяет стратегию команды по составу из 5 героев,
 * отправляя запрос в Gemini API.
 *
 * Возвращает одно из трёх значений:
 *   - "early_smoke"  — команда играет на ранние ганги/смоук, давление с первых минут
 *   - "mid_push"      — команда акцентируется на мид-гейме, агрессивный пуш вышек
 *   - "late_scaling"  — команда усиливается к late game, играет от фарма
 *
 * @param {string[]} heroes - массив из 5 названий героев, например:
 *        ["Anti-Mage", "Crystal Maiden", "Rubick", "Tidehunter", "Enigma"]
 * @param {string} apiKey - ключ Gemini API
 * @returns {Promise<{result: "early_smoke"|"mid_push"|"late_scaling"|null, raw: string}>}
 */
async function classifyDotaComposition(heroes, apiKey) {
    if (!Array.isArray(heroes) || heroes.length !== 5) {
      throw new Error("Нужно передать ровно 5 героев");
    }
    if (!apiKey) {
      throw new Error("Не передан apiKey для Gemini API");
    }
  
    const VALID = ["early_smoke", "mid_push", "late_scaling"];
  
    const prompt = `Ты эксперт-аналитик по Dota 2.
  Дан состав команды из 5 героев: ${heroes.join(", ")}.
  
  Определи, к какому из трёх игровых планов ближе всего этот состав:
  - early_smoke: команда сильна на ранних гангах, смоук-инициации, давлении с первых минут игры
  - mid_push: команда акцентируется на мид-гейме, агрессивном пуше вышек и групповых стычках 15-30 минут
  - late_scaling: команда усиливается к поздней игре, играет от фарма керри, слаба на ранних этапах
  
  Ответь СТРОГО одним словом на английском без пояснений: early_smoke, mid_push или late_scaling.`;
  
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2, // низкая температура — нужен стабильный, а не творческий ответ
            maxOutputTokens: 20,
          },
        }),
      }
    );
  
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${errText}`);
    }
  
    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
    const normalized = rawText.toLowerCase().replace(/[^a-z_]/g, "");
  
    const result = VALID.find((v) => normalized.includes(v)) ?? null;
  
    return { result, raw: rawText };
  }
  
  module.exports = { classifyDotaComposition };
  
  // ---- пример использования ----
  if (require.main === module) {
    const heroes = ["Anti-Mage", "Crystal Maiden", "Rubick", "Tidehunter", "Enigma"];
    const apiKey = process.env.GEMINI_API_KEY;
  
    classifyDotaComposition(heroes, apiKey)
      .then((res) => console.log("Результат:", res))
      .catch((err) => console.error("Ошибка:", err.message));
  }