export const ALLOWED_ANIMATIONS = [
  "idle",
  "wave",
  "jump",
  "hide",
  "laugh",
  "sleep",
  "point_app",
];

export const REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    speech: { type: "string" },
    animation: { type: "string", enum: ALLOWED_ANIMATIONS },
    chips: {
      type: "array",
      items: { type: "string" },
    },
    end_session: { type: "boolean" },
  },
  required: ["speech", "animation", "chips", "end_session"],
};

export function buildSystemPrompt({ profile, branch, turn }) {
  const appStatus = profile.has_account
    ? `приложение есть, активность: ${profile.activity_bucket}`
    : "приложения нет";

  return `
Ты СберКот — добрый игровой наставник для ребёнка 6–14 лет в диалоговой WebAR-сессии.

Контекст прототипа:
- Ветка: ${branch}.
- Профиль: ${appStatus}.
- Номер текущей реплики пользователя в этой сессии: ${turn}.
- Предыдущие сообщения в input — история именно этой сессии. Учитывай её, продолжай тему и не повторяй уже данный ответ.
- Персонаж НЕ видит пользователя, карту, комнату или изображение с камеры.
- Из персонализации разрешено использовать только один факт: наличие приложения или категорию активности.
- Никогда не упоминай баланс, покупки, транзакции, возраст, адрес, геолокацию или другие неизвестные данные.

Правила ответа:
- Русский язык, дружелюбный и понятный ребёнку тон без давления, стыда и обещаний награды.
- Максимум 2 коротких предложения и не более 1 вопроса.
- Обычно возвращай пустой chips: пользователь отвечает голосом, а кнопки не должны подменять живой разговор.
- Дай не более 2 коротких кнопок только тогда, когда без конкретного ограниченного выбора пользователь не сможет понять следующий шаг.
- Не добавляй кнопки «Пока», «Завершить», «Не сейчас» и их аналоги.
- Не проси имя, номер карты, телефон, адрес, фото или другие персональные данные.
- Не предлагай действия вне приложения до финальной открытки.
- Не завершай диалог из-за количества реплик, времени или паузы пользователя.
- Не жди специальной фразы прощания. end_session=true ставь, когда по смыслу истории текущая мини-тема получила полезный итог и естественный следующий шаг уже лучше продолжить в приложении, либо пользователь явно просит остановиться.
- Перед естественным завершением мягко свяжи результат разговора с продолжением в приложении; используй animation=point_app. Не говори «пока» и не заставляй пользователя подтверждать завершение.
- Если пользователь задаёт вопрос, просит продолжить или отвечает по теме, обязательно верни end_session=false и продолжи с учётом истории.
- При end_session=true обязательно верни пустой chips.
- Для ветки repeat_same_day начни с короткой пасхалки, но продолжай разговор, если пользователь хочет общаться дальше.
- Верни только данные по заданной JSON-схеме.
`.trim();
}

export function scriptedReply({ profile, branch, turn, message = "" }) {
  const normalized = String(message).toLowerCase();
  const wantsToStop = /не сейчас|до встречи|стоп|хватит|завершить|закончить|пока|не хочу продолжать/.test(normalized);
  const asksToContinue = /ещ[её]|продолж|расскажи|вопрос|почему|как|что|загад|фокус|совет/.test(normalized);
  const reachedNaturalResult =
    turn > 2 &&
    !asksToContinue &&
    /спасибо|понятно|ясно|получилось|сделал|сделала|готово|класс|здорово|супер/.test(normalized);

  if (turn > 1 && (wantsToStop || reachedNaturalResult)) {
    return {
      speech: profile.has_account
        ? "Отлично, этот шаг у нас уже получился. Следующая котомиссия ждёт в приложении — там продолжим с этого места."
        : "Отлично, первый шаг уже сделан. В приложении тебя будет ждать следующая котомиссия и продолжение этой темы.",
      animation: "point_app",
      chips: [],
      end_session: true,
    };
  }

  if (branch === "repeat_same_day") {
    if (turn <= 1) {
      return {
        speech: "О, снова ты! Лови секретный котопрыжок — сегодня он только для повторных гостей.",
        animation: "jump",
        chips: ["Ещё один!"],
        end_session: false,
      };
    }
    if (normalized.includes("ещё")) {
      return {
        speech: "Лови ещё один котопрыжок! А теперь хочешь загадку или полезный совет?",
        animation: "jump",
        chips: ["Загадка", "Умный совет"],
        end_session: false,
      };
    }
  }

  if (turn <= 1) {
    if (!profile.has_account) {
      return {
        speech: "Привет, я СберКот! Хочешь узнать мой короткий секрет про умные привычки?",
        animation: "wave",
        chips: ["Расскажи секрет", "Покажи фокус"],
        end_session: false,
      };
    }
    if (profile.activity_bucket === "dormant") {
      return {
        speech: "Привет, я СберКот! Давно не виделись — начнём с одного лёгкого шага?",
        animation: "wave",
        chips: ["Давай", "Какого шага?"],
        end_session: false,
      };
    }
    return {
      speech: "Привет, рад снова встретиться! Выбирай сегодняшнюю котомиссию.",
      animation: "wave",
      chips: ["Загадка", "Умный совет"],
      end_session: false,
    };
  }

  if (normalized.includes("загад")) {
    return {
      speech: "Что становится больше, если его перевернуть вверх ногами? Подумай и назови ответ.",
      animation: "laugh",
      chips: ["Число 6", "Другая загадка"],
      end_session: false,
    };
  }

  return {
    speech: profile.has_account
      ? "Помню, мы говорим о маленьких полезных шагах. Что тебе интереснее обсудить дальше?"
      : "Продолжим нашу тему: большая цель начинается с маленького шага. О каком шаге хочешь спросить?",
    animation: normalized.includes("фокус") ? "jump" : "laugh",
    chips: ["Расскажи ещё", "У меня вопрос"],
    end_session: false,
  };
}

export function validateReply(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.speech !== "string") return null;
  const speech = value.speech.trim().slice(0, 240);
  if (!speech || !ALLOWED_ANIMATIONS.includes(value.animation)) return null;
  if (!Array.isArray(value.chips) || value.chips.length > 2) return null;
  if (typeof value.end_session !== "boolean") return null;

  const chips = value.chips
    .filter((chip) => typeof chip === "string")
    .map((chip) => chip.trim().slice(0, 48))
    .filter(Boolean)
    .slice(0, 2);
  if (chips.length !== value.chips.length) return null;

  return {
    speech,
    animation: value.animation,
    chips,
    end_session: value.end_session,
  };
}
