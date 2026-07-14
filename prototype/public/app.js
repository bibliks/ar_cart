(() => {
  "use strict";

  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const routeName = pathParts.at(-1) || "";
  const isWithoutApp = routeName === "without-app";
  const isWithApp = routeName === "with-app";
  const isExperience = isWithoutApp || isWithApp;
  const launcher = document.querySelector("#launcher");
  const experience = document.querySelector("#experience");

  if (!isExperience) {
    launcher.hidden = false;
    const healthElement = document.querySelector("#api-health");
    setupCredentialForm(document.querySelector("#launcher-api-setup"), () => refreshHealth(healthElement));
    refreshHealth(healthElement);
    return;
  }

  registerCharacterComponent();
  experience.hidden = false;
  window.dispatchEvent(new Event("resize"));

  const query = new URLSearchParams(window.location.search);
  const mode = isWithApp ? "with-app" : "without-app";
  const backendTimeout = query.get("backend") === "timeout";
  const forceFallback = query.get("fallback") === "1";
  const disableCamera = query.get("camera") === "off";
  const forceRepeat = query.get("repeat") === "1";
  const activityBucket = isWithApp && query.get("activity") === "dormant" ? "dormant" : "active";
  const profile = backendTimeout
    ? { has_account: false, activity_bucket: "unknown" }
    : {
        has_account: isWithApp,
        activity_bucket: isWithApp ? activityBucket : "unknown",
      };

  const elements = {
    intro: document.querySelector("#intro"),
    apiSetup: document.querySelector("#experience-api-setup"),
    modeKicker: document.querySelector("#mode-kicker"),
    startButton: document.querySelector("#start-button"),
    topbar: document.querySelector("#topbar"),
    modeBadge: document.querySelector("#mode-badge"),
    timer: document.querySelector("#timer"),
    resetTest: document.querySelector("#reset-test"),
    progress: document.querySelector("#progress-value"),
    stateLabel: document.querySelector("#state-label"),
    scanHint: document.querySelector("#scan-hint"),
    scanStatus: document.querySelector("#scan-status"),
    dialogue: document.querySelector("#dialogue"),
    subtitle: document.querySelector("#subtitle"),
    chips: document.querySelector("#chips"),
    replySource: document.querySelector("#reply-source"),
    micButton: document.querySelector("#mic-button"),
    micLabel: document.querySelector("#mic-label"),
    micNote: document.querySelector("#mic-note"),
    postcard: document.querySelector("#postcard"),
    postcardCopy: document.querySelector("#postcard-copy"),
    ctaButton: document.querySelector("#cta-button"),
    ctaNote: document.querySelector("#cta-note"),
    restartButton: document.querySelector("#restart-button"),
    fallbackLayer: document.querySelector("#fallback-layer"),
    fallbackCamera: document.querySelector("#fallback-camera"),
    scene: document.querySelector("#ar-scene"),
    target: document.querySelector("#ar-target"),
    character: document.querySelector("#character-model"),
  };

  const stateConfig = {
    SCAN: ["Наведите камеру на маркер", 8],
    LOADING: ["Запускаем камеру и сцену", 16],
    APPEAR: ["СберКот появился", 28],
    GREETING: ["Знакомство", 42],
    EPISODE: ["Короткая котомиссия", 68],
    CLOSING: ["Готовим продолжение", 88],
    POSTCARD: ["Продолжение готово", 100],
  };

  let currentState = "SCAN";
  let currentBranch = "no_app";
  let appeared = false;
  let pending = false;
  let closing = false;
  let turn = 0;
  let history = [];
  let sessionStartedAt = 0;
  let timerInterval = 0;
  let inactivityTimer = 0;
  let markerLostTimer = 0;
  let usingFallback = forceFallback || !supportsWebGL();
  let fallbackStream = null;
  let recorder = null;
  let recorderStream = null;
  let recorderChunks = [];
  let audioContext = null;
  let audioSource = null;
  let analyser = null;
  let vadBuffer = null;
  let vadFrame = 0;
  let listeningEnabled = false;
  let voiceUnavailable = false;
  let speechFrameCount = 0;
  let lastVoiceAt = 0;
  let captureStartedAt = 0;
  let noiseFloor = 0.012;
  let discardRecording = false;
  let assistantSpeaking = false;
  let listenResumeAt = 0;
  let speechGeneration = 0;
  let speechFallbackTimer = 0;
  let experienceStarted = false;
  let openAIConfigured = false;

  window.__sberkotAnalytics = [];
  setupModeCopy();
  setState("SCAN");
  configureCta();
  bindEvents();
  prepareScene();
  setupCredentialForm(elements.apiSetup, async () => {
    await checkHealth();
    elements.apiSetup.open = false;
  });
  checkHealth();

  function setupModeCopy() {
    if (backendTimeout) {
      elements.modeKicker.textContent = "Гостевой fallback · mock backend timeout";
      elements.modeBadge.textContent = "Гостевой режим";
      return;
    }
    if (isWithApp) {
      elements.modeKicker.textContent =
        activityBucket === "dormant" ? "Версия с приложением · возврат" : "Версия с приложением · активный пользователь";
      elements.modeBadge.textContent = activityBucket === "dormant" ? "С приложением · возврат" : "С приложением";
      return;
    }
    elements.modeKicker.textContent = "Версия без приложения · первое знакомство";
    elements.modeBadge.textContent = "Без приложения";
  }

  function configureCta() {
    if (profile.has_account) {
      elements.ctaButton.textContent = "Открыть приложение";
      elements.postcardCopy.textContent = "Котомиссия сохранена. Продолжение будет ждать в приложении.";
    } else {
      elements.ctaButton.textContent = "Установить приложение";
      elements.postcardCopy.textContent = "СберКот оставил открытку. Продолжение появится после установки приложения.";
    }
  }

  function bindEvents() {
    elements.startButton.addEventListener("click", startExperience);
    elements.target.addEventListener("targetFound", onTargetFound);
    elements.target.addEventListener("targetLost", onTargetLost);
    elements.resetTest.addEventListener("click", resetTestState);
    elements.restartButton.addEventListener("click", () => window.location.reload());
    elements.ctaButton.addEventListener("click", () => {
      track("cta_click", { mode });
      elements.ctaNote.hidden = false;
    });

    elements.micButton.addEventListener("click", toggleAlwaysListening);
    window.addEventListener("pagehide", stopAllMedia);
  }

  function prepareScene() {
    if (usingFallback || !window.AFRAME || !elements.scene) {
      usingFallback = true;
      elements.startButton.disabled = false;
      elements.startButton.textContent = "Запустить 2D-версию";
      return;
    }

    const markReady = () => {
      elements.startButton.disabled = false;
      elements.startButton.textContent = "Запустить AR";
    };
    if (elements.scene.hasLoaded) markReady();
    else elements.scene.addEventListener("loaded", markReady, { once: true });

    window.setTimeout(() => {
      if (elements.startButton.disabled) {
        usingFallback = true;
        elements.startButton.disabled = false;
        elements.startButton.textContent = "Запустить 2D-версию";
      }
    }, 8000);
  }

  async function checkHealth() {
    let serverAvailable = true;
    try {
      const response = await fetch("api/health", { cache: "no-store" });
      if (!response.ok) throw new Error("health_unavailable");
      const health = await response.json();
      openAIConfigured = Boolean(health.openaiConfigured);
    } catch {
      openAIConfigured = false;
      serverAvailable = false;
    }

    elements.apiSetup.hidden = !serverAvailable;

    if (!openAIConfigured) {
      updateListeningUi();
    } else {
      updateListeningUi();
      const setupStatus = elements.apiSetup.querySelector("[data-api-status]");
      setupStatus.textContent = "OpenAI подключён. Ключ хранится только в памяти сервера.";
      setupStatus.classList.add("is-success");
    }
  }

  async function startExperience() {
    if (elements.startButton.disabled) return;
    experienceStarted = true;
    elements.startButton.disabled = true;
    elements.intro.hidden = true;
    elements.topbar.hidden = false;
    elements.scanHint.hidden = false;
    setState("LOADING");
    track("session_start", { mode, fallback: usingFallback });
    if (openAIConfigured) await startAlwaysListening();

    if (usingFallback) {
      await startFallbackCamera();
      elements.scanStatus.textContent = "2D-режим готов";
      window.setTimeout(onAppearance, 500);
      return;
    }

    try {
      const system = elements.scene.systems["mindar-image-system"];
      if (!system) throw new Error("mindar_system_missing");
      await system.start();
      setState("SCAN");
      elements.scanStatus.textContent = "Держите маркер целиком в рамке";
    } catch {
      usingFallback = true;
      try {
        elements.scene.systems["mindar-image-system"]?.stop();
      } catch {
        // MindAR мог не успеть запуститься.
      }
      await startFallbackCamera();
      elements.scanStatus.textContent = "AR недоступна — включён 2D-режим";
      track("fallback_2d", { reason: "ar_start_failed" });
      window.setTimeout(onAppearance, 500);
    }
  }

  async function startFallbackCamera() {
    elements.scene.style.display = "none";
    elements.fallbackLayer.classList.add("is-active");
    elements.fallbackLayer.setAttribute("aria-hidden", "false");
    if (disableCamera) return;
    if (!navigator.mediaDevices?.getUserMedia) return;

    try {
      fallbackStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      elements.fallbackCamera.srcObject = fallbackStream;
      await elements.fallbackCamera.play();
    } catch {
      track("camera_denied", { fallback: true });
    }
  }

  function onTargetFound() {
    window.clearTimeout(markerLostTimer);
    markerLostTimer = 0;
    if (!appeared) onAppearance();
    else elements.stateLabel.textContent = stateConfig[currentState][0];
  }

  function onTargetLost() {
    if (!appeared || closing) return;
    elements.stateLabel.textContent = "Маркер потерян — верните его в кадр";
    track("marker_lost", {});
    window.clearTimeout(markerLostTimer);
    markerLostTimer = window.setTimeout(() => {
      elements.stateLabel.textContent = "Диалог продолжается — верните маркер, чтобы снова увидеть персонажа";
      elements.micNote.textContent = "Можно продолжать говорить: потеря маркера не завершает сессию";
    }, 10000);
  }

  function onAppearance() {
    if (appeared) return;
    appeared = true;
    elements.scanHint.hidden = true;
    elements.dialogue.hidden = false;
    setState("APPEAR");
    sessionStartedAt = Date.now();
    determineBranch();
    startSessionTimers();
    applyAnimation("wave");
    track("character_appeared", { branch: currentBranch, fallback: usingFallback });
    window.setTimeout(() => runDialogue("__start__"), 450);
  }

  function determineBranch() {
    if (backendTimeout) {
      currentBranch = "guest_fallback";
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const stored = readScanState();
    const isRepeat = forceRepeat || (stored.date === today && stored.count > 0);
    writeScanState({ date: today, count: stored.date === today ? stored.count + 1 : 1 });

    if (isRepeat) currentBranch = "repeat_same_day";
    else if (!profile.has_account) currentBranch = "no_app";
    else currentBranch = profile.activity_bucket === "dormant" ? "dormant" : "active";

    if (isRepeat) elements.modeBadge.textContent = `${elements.modeBadge.textContent} · повтор`;
  }

  function startSessionTimers() {
    timerInterval = window.setInterval(updateTimer, 250);
    resetInactivityTimer();
  }

  function updateTimer() {
    if (!sessionStartedAt) return;
    const elapsed = Math.floor((Date.now() - sessionStartedAt) / 1000);
    const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const seconds = String(elapsed % 60).padStart(2, "0");
    elements.timer.textContent = `${minutes}:${seconds}`;
  }

  function resetInactivityTimer() {
    window.clearTimeout(inactivityTimer);
    if (!closing) {
      inactivityTimer = window.setTimeout(() => {
        elements.stateLabel.textContent = "СберКот ждёт продолжения разговора";
        elements.micNote.textContent = openAIConfigured
          ? listeningEnabled
            ? "Я продолжаю слушать — говорите, когда будете готовы"
            : "Микрофон выключен — нажмите, чтобы продолжить голосом"
          : "Я подожду — выберите ответ, когда будете готовы";
        applyAnimation("idle");
        track("dialogue_waiting", { turn });
      }, 30000);
    }
  }

  async function runDialogue(message) {
    if (pending || closing) return;
    pending = true;
    turn += 1;
    setControlsDisabled(true);
    setState(turn === 1 ? "GREETING" : "EPISODE");
    elements.subtitle.textContent = turn === 1 ? "СберКот подбирает приветствие…" : "СберКот думает…";
    elements.replySource.textContent = "обработка…";
    const historyBeforeTurn = history.slice(-24);

    try {
      const response = await fetch("api/dialogue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          history: historyBeforeTurn,
          profile,
          branch: currentBranch,
          turn,
        }),
      });
      if (!response.ok) throw new Error("dialogue_unavailable");
      const data = await response.json();
      if (!data.reply?.speech) throw new Error("invalid_reply");

      if (message !== "__start__") history.push({ role: "user", content: message.slice(0, 300) });
      history.push({ role: "assistant", content: data.reply.speech.slice(0, 240) });
      history = history.slice(-24);
      renderReply(data.reply, data.source);
      track("dialogue_reply", { turn, source: data.source });
    } catch {
      renderReply(clientScriptedReply(message), "client-fallback");
      track("dialogue_reply", { turn, source: "client-fallback" });
    } finally {
      pending = false;
      setControlsDisabled(false);
      resetInactivityTimer();
    }
  }

  function renderReply(reply, source) {
    elements.subtitle.textContent = reply.speech;
    elements.replySource.textContent = sourceLabel(source);
    elements.chips.replaceChildren();
    applyAnimation(reply.animation);
    const replyChips = [...reply.chips];
    if (
      openAIConfigured &&
      !voiceUnavailable &&
      ["network-fallback", "safety-fallback", "client-fallback"].includes(source)
    ) {
      replyChips.length = 0;
    }
    if (!reply.end_session && (voiceUnavailable || !openAIConfigured) && replyChips.length === 0) {
      replyChips.push("Продолжай", "У меня вопрос");
    }
    speak(reply.speech, reply.end_session ? () => beginClosing("dialogue_complete", true) : null);
    updateListeningUi();

    for (const label of replyChips.slice(0, 2)) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        track("chip_selected", { turn, index: [...elements.chips.children].indexOf(button) });
        runDialogue(label);
      });
      elements.chips.append(button);
    }

  }

  function clientScriptedReply(message) {
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

    if (currentBranch === "repeat_same_day" && turn <= 1) {
      return {
        speech: "О, снова ты! Лови секретный котопрыжок — сегодня он только для повторных гостей.",
        animation: "jump",
        chips: ["Ещё один!"],
        end_session: false,
      };
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
      return {
        speech: profile.activity_bucket === "dormant"
          ? "Привет, я СберКот! Давно не виделись — начнём с одного лёгкого шага?"
          : "Привет, рад снова встретиться! Выбирай сегодняшнюю котомиссию.",
        animation: "wave",
        chips: profile.activity_bucket === "dormant" ? ["Давай", "Какого шага?"] : ["Загадка", "Умный совет"],
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

  function beginClosing(reason, alreadySpoken = false) {
    if (closing) return;
    closing = true;
    pending = false;
    window.clearTimeout(inactivityTimer);
    setControlsDisabled(true);
    setState("CLOSING");
    elements.chips.replaceChildren();
    stopAlwaysListening();
    track("session_closing", { reason, turn });

    if (!alreadySpoken) {
      const phrase = "Этот шаг готов. Продолжение котомиссии уже ждёт тебя в приложении.";
      elements.subtitle.textContent = phrase;
      elements.replySource.textContent = "переход к продолжению";
      applyAnimation("wave");
      speak(phrase);
    }
    window.setTimeout(showPostcard, alreadySpoken ? 700 : 1800);
  }

  function showPostcard() {
    if (!elements.postcard.hidden) return;
    closing = true;
    clearSessionTimers();
    setState("POSTCARD");
    elements.dialogue.hidden = true;
    elements.postcard.hidden = false;
    track("postcard_shown", { mode, branch: currentBranch });
  }

  function setState(nextState) {
    currentState = nextState;
    const [label, progress] = stateConfig[nextState];
    elements.stateLabel.textContent = label;
    elements.progress.style.width = `${progress}%`;
  }

  function setControlsDisabled(disabled) {
    for (const button of elements.chips.querySelectorAll("button")) button.disabled = disabled;
    updateListeningUi();
  }

  function applyAnimation(action) {
    if (usingFallback) {
      const cat = elements.fallbackLayer.querySelector(".fallback-cat");
      cat.dataset.action = action;
      if (action === "jump") {
        cat.animate(
          [
            { transform: "translate(-50%, -50%)" },
            { transform: "translate(-50%, -78%)" },
            { transform: "translate(-50%, -50%)" },
          ],
          { duration: 700, easing: "ease-out" },
        );
      }
      return;
    }
    elements.character.setAttribute("sberkot-character", "action", action || "idle");
  }

  function setCharacterSpeaking(speaking) {
    if (usingFallback) {
      elements.fallbackLayer.querySelector(".fallback-cat")?.classList.toggle("is-speaking", speaking);
      return;
    }
    elements.character.setAttribute("sberkot-character", "speaking", speaking);
  }

  function speak(text, onDone = null) {
    const generation = ++speechGeneration;
    window.clearTimeout(speechFallbackTimer);
    if (!("speechSynthesis" in window)) {
      setCharacterSpeaking(false);
      onDone?.();
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ru-RU";
    utterance.rate = 0.94;
    utterance.pitch = 1.08;
    let finished = false;
    const finish = () => {
      if (finished || generation !== speechGeneration) return;
      finished = true;
      window.clearTimeout(speechFallbackTimer);
      assistantSpeaking = false;
      listenResumeAt = performance.now() + 450;
      setCharacterSpeaking(false);
      updateListeningUi();
      onDone?.();
    };
    utterance.addEventListener("start", () => {
      if (generation !== speechGeneration) return;
      assistantSpeaking = true;
      setCharacterSpeaking(true);
      updateListeningUi();
    });
    utterance.addEventListener("end", finish, { once: true });
    utterance.addEventListener("error", finish, { once: true });
    assistantSpeaking = true;
    setCharacterSpeaking(true);
    updateListeningUi();
    window.speechSynthesis.speak(utterance);
    speechFallbackTimer = window.setTimeout(finish, Math.min(15000, Math.max(3500, text.length * 95)));
  }

  async function toggleAlwaysListening() {
    if (!openAIConfigured || closing) return;
    resetInactivityTimer();
    if (listeningEnabled) {
      stopAlwaysListening();
      track("always_listening_disabled", {});
    } else {
      await startAlwaysListening();
    }
  }

  async function startAlwaysListening() {
    if (listeningEnabled || closing) return;
    if (
      !navigator.mediaDevices?.getUserMedia ||
      !window.MediaRecorder ||
      (!window.AudioContext && !window.webkitAudioContext)
    ) {
      voiceUnavailable = true;
      updateListeningUi();
      return;
    }

    voiceUnavailable = false;
    elements.micLabel.textContent = "Запрашиваем доступ к микрофону…";
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioContext = new AudioContextClass();
      recorderStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      await audioContext.resume();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.12;
      vadBuffer = new Float32Array(analyser.fftSize);
      audioSource = audioContext.createMediaStreamSource(recorderStream);
      audioSource.connect(analyser);
      listeningEnabled = true;
      speechFrameCount = 0;
      noiseFloor = 0.012;
      updateListeningUi();
      monitorVoiceActivity();
      track("always_listening_enabled", {});
    } catch {
      voiceUnavailable = true;
      stopAlwaysListening({ preserveUnavailable: true });
      updateListeningUi();
      track("microphone_denied", {});
    }
  }

  function monitorVoiceActivity() {
    window.cancelAnimationFrame(vadFrame);
    if (!listeningEnabled || !analyser || !vadBuffer) return;

    analyser.getFloatTimeDomainData(vadBuffer);
    let energy = 0;
    for (const sample of vadBuffer) energy += sample * sample;
    const rms = Math.sqrt(energy / vadBuffer.length);
    const now = performance.now();
    const threshold = Math.max(0.026, noiseFloor * 2.8);
    const canHearUser = appeared && !pending && !closing && !assistantSpeaking && now >= listenResumeAt;

    if (!recorder && canHearUser) {
      noiseFloor = Math.min(0.04, noiseFloor * 0.96 + rms * 0.04);
      speechFrameCount = rms > threshold ? speechFrameCount + 1 : Math.max(0, speechFrameCount - 1);
      if (speechFrameCount >= 3) startVoiceCapture(now);
    } else if (recorder?.state === "recording") {
      if (rms > threshold * 0.72) lastVoiceAt = now;
      const heardEnough = now - captureStartedAt > 450;
      const pauseReached = heardEnough && now - lastVoiceAt > 900;
      if (pauseReached || now - captureStartedAt > 12000) stopVoiceCapture();
    }

    vadFrame = window.requestAnimationFrame(monitorVoiceActivity);
  }

  function startVoiceCapture(now) {
    if (!recorderStream || recorder || pending || assistantSpeaking) return;
    try {
      const mimeType = chooseRecorderMimeType();
      const activeRecorder = mimeType ? new MediaRecorder(recorderStream, { mimeType }) : new MediaRecorder(recorderStream);
      recorder = activeRecorder;
      recorderChunks = [];
      discardRecording = false;
      captureStartedAt = now;
      lastVoiceAt = now;
      speechFrameCount = 0;
      activeRecorder.addEventListener("dataavailable", (chunk) => {
        if (chunk.data.size) recorderChunks.push(chunk.data);
      });
      activeRecorder.addEventListener("stop", () => {
        const chunks = recorderChunks;
        const recordingType = activeRecorder.mimeType || chunks[0]?.type || "audio/webm";
        const shouldDiscard = discardRecording;
        if (recorder === activeRecorder) recorder = null;
        recorderChunks = [];
        discardRecording = false;
        elements.micButton.classList.remove("is-recording");
        updateListeningUi();
        if (!shouldDiscard) transcribeRecording(chunks, recordingType);
      }, { once: true });
      activeRecorder.start(250);
      elements.micButton.classList.add("is-recording");
      updateListeningUi();
      track("voice_recording_started", {});
    } catch {
      voiceUnavailable = true;
      stopAlwaysListening({ preserveUnavailable: true });
      updateListeningUi();
    }
  }

  function stopVoiceCapture({ discard = false } = {}) {
    if (discard) discardRecording = true;
    if (recorder?.state === "recording") recorder.stop();
  }

  async function transcribeRecording(chunks, mimeType) {
    const audio = new Blob(chunks, { type: mimeType });

    if (!audio.size) {
      updateListeningUi("Речь не распознана — я продолжаю слушать");
      return;
    }

    pending = true;
    setControlsDisabled(true);
    elements.subtitle.textContent = "Распознаём короткую реплику…";
    try {
      const response = await fetch("api/transcribe", {
        method: "POST",
        headers: { "Content-Type": mimeType },
        body: audio,
      });
      const data = await response.json();
      if (!response.ok || !data.text) throw new Error("transcription_failed");
      pending = false;
      elements.micNote.textContent = `Услышал: «${data.text.slice(0, 80)}»`;
      track("voice_transcribed", {});
      await runDialogue(data.text);
    } catch {
      pending = false;
      elements.subtitle.textContent = "Не получилось разобрать реплику. Я продолжаю слушать — скажите ещё раз.";
      updateListeningUi("Речь не отправлена — можно повторить без кнопки");
      setControlsDisabled(false);
      track("voice_transcription_failed", {});
    }
  }

  function chooseRecorderMimeType() {
    const candidates = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
    return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || "";
  }

  function updateListeningUi(note = "") {
    const isRecording = recorder?.state === "recording";
    elements.micButton.classList.toggle("is-listening", listeningEnabled);
    elements.micButton.classList.toggle("is-recording", isRecording);
    elements.micButton.setAttribute("aria-pressed", String(listeningEnabled));

    if (!openAIConfigured) {
      elements.micButton.disabled = true;
      elements.micLabel.textContent = "Голос доступен после подключения API";
      elements.micNote.textContent = note || "Кнопки появляются только как резервный способ ответа";
      return;
    }

    elements.micButton.disabled = closing;
    if (voiceUnavailable) {
      elements.micLabel.textContent = "Повторить доступ к микрофону";
      elements.micNote.textContent = note || "Микрофон недоступен — используйте редкие кнопки-подсказки";
      elements.micButton.setAttribute("aria-label", "Повторить запрос доступа к микрофону");
    } else if (!experienceStarted) {
      elements.micLabel.textContent = "Микрофон включится после запуска";
      elements.micNote.textContent = note || "После запуска можно говорить без удержания кнопки";
    } else if (!listeningEnabled) {
      elements.micLabel.textContent = "Включить микрофон";
      elements.micNote.textContent = note || "Прослушивание выключено";
      elements.micButton.setAttribute("aria-label", "Включить постоянное прослушивание");
    } else if (isRecording) {
      elements.micLabel.textContent = "Слышу вас…";
      elements.micNote.textContent = note || "Закончу реплику после короткой паузы";
      elements.micButton.setAttribute("aria-label", "Выключить постоянное прослушивание");
    } else if (pending) {
      elements.micLabel.textContent = "Обрабатываю реплику…";
      elements.micNote.textContent = note || "После ответа снова начну слушать автоматически";
    } else if (assistantSpeaking) {
      elements.micLabel.textContent = "СберКот отвечает";
      elements.micNote.textContent = note || "Прослушивание продолжится сразу после ответа";
    } else {
      elements.micLabel.textContent = "Слушаю — говорите свободно";
      elements.micNote.textContent = note || "Микрофон включён постоянно · нажмите, чтобы выключить";
      elements.micButton.setAttribute("aria-label", "Выключить постоянное прослушивание");
    }
  }

  function stopAlwaysListening({ preserveUnavailable = false } = {}) {
    listeningEnabled = false;
    window.cancelAnimationFrame(vadFrame);
    vadFrame = 0;
    stopVoiceCapture({ discard: true });
    audioSource?.disconnect();
    audioSource = null;
    analyser = null;
    vadBuffer = null;
    recorderStream?.getTracks().forEach((track) => track.stop());
    recorderStream = null;
    if (audioContext && audioContext.state !== "closed") audioContext.close().catch(() => {});
    audioContext = null;
    speechFrameCount = 0;
    if (!preserveUnavailable) voiceUnavailable = false;
    updateListeningUi();
  }

  function stopAllMedia() {
    clearSessionTimers();
    stopAlwaysListening();
    window.clearTimeout(speechFallbackTimer);
    window.speechSynthesis?.cancel();
    fallbackStream?.getTracks().forEach((track) => track.stop());
    fallbackStream = null;
    try {
      elements.scene.systems["mindar-image-system"]?.stop();
    } catch {
      // Сцена уже остановлена браузером.
    }
  }

  function clearSessionTimers() {
    window.clearInterval(timerInterval);
    window.clearTimeout(inactivityTimer);
    window.clearTimeout(markerLostTimer);
  }

  function readScanState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(`sberkot_scan_${mode}`) || "{}");
      return {
        date: typeof parsed.date === "string" ? parsed.date : "",
        count: Number.isInteger(parsed.count) ? Math.max(0, parsed.count) : 0,
      };
    } catch {
      return { date: "", count: 0 };
    }
  }

  function writeScanState(value) {
    try {
      localStorage.setItem(
        `sberkot_scan_${mode}`,
        JSON.stringify({ date: value.date, count: value.count }),
      );
    } catch {
      // Отказ localStorage не блокирует сессию.
    }
  }

  function resetTestState() {
    try {
      localStorage.removeItem(`sberkot_scan_${mode}`);
    } catch {
      // Перезагрузка всё равно вернёт базовый сценарий в приватном режиме.
    }
    window.location.href = `${window.location.pathname}${forceFallback ? "?fallback=1" : ""}`;
  }

  function track(event, detail) {
    window.__sberkotAnalytics.push({
      event,
      detail,
      at_ms: sessionStartedAt ? Date.now() - sessionStartedAt : 0,
    });
  }

  function sourceLabel(source) {
    const labels = {
      openai: "ИИ-ответ",
      "local-fallback": "локальный сценарий",
      "network-fallback": "гостевой fallback",
      "safety-fallback": "безопасный fallback",
      "moderation-fallback": "фильтр безопасности",
      "client-fallback": "резервный сценарий",
    };
    return labels[source] || "сценарий";
  }

  function supportsWebGL() {
    try {
      const canvas = document.createElement("canvas");
      return Boolean(window.WebGLRenderingContext && (canvas.getContext("webgl") || canvas.getContext("experimental-webgl")));
    } catch {
      return false;
    }
  }

  function registerCharacterComponent() {
    if (!window.AFRAME || window.AFRAME.components["sberkot-character"]) return;

    window.AFRAME.registerComponent("sberkot-character", {
      schema: {
        action: { type: "string", default: "idle" },
        speaking: { type: "boolean", default: false },
      },

      init() {
        this.bones = {};
        this.rest = {};
        this.actionStartedAt = performance.now();
        this.basePosition = this.el.object3D.position.clone();
        this.baseScale = this.el.object3D.scale.clone();
        this.el.addEventListener("model-loaded", () => {
          const model = this.el.getObject3D("mesh");
          const boneNames = [
            "Head",
            "Spine1",
            "LeftArm",
            "LeftForeArm",
            "RightArm",
            "RightForeArm",
            "LeftUpLeg",
            "LeftLeg",
            "RightUpLeg",
            "RightLeg",
          ];
          for (const name of boneNames) {
            const bone = model?.getObjectByName(name) || model?.getObjectByName(`mixamorig${name}`);
            if (!bone) continue;
            this.bones[name] = bone;
            this.rest[name] = bone.rotation.clone();
          }
        });
      },

      update(oldData) {
        if (oldData.action !== this.data.action) this.actionStartedAt = performance.now();
      },

      tick(time) {
        const seconds = time / 1000;
        const actionSeconds = (performance.now() - this.actionStartedAt) / 1000;
        const action = this.data.action;
        const setRotation = (name, x = 0, y = 0, z = 0) => {
          const bone = this.bones[name];
          const rest = this.rest[name];
          if (bone && rest) bone.rotation.set(rest.x + x, rest.y + y, rest.z + z);
        };

        for (const name of Object.keys(this.rest)) setRotation(name);
        this.el.object3D.position.copy(this.basePosition);
        this.el.object3D.scale.copy(this.baseScale);

        setRotation("Head", 0.025 * Math.sin(seconds * 1.7), 0.07 * Math.sin(seconds * 0.85), 0);
        setRotation("Spine1", 0.02 * Math.sin(seconds * 1.5), 0, 0.018 * Math.sin(seconds * 0.9));

        if (action === "wave") {
          setRotation("LeftArm", 0, 0, 0.75);
          setRotation("LeftForeArm", 0.35 * Math.sin(actionSeconds * 8), 0, 0.55);
        } else if (action === "jump") {
          const jump = Math.max(0, Math.sin(Math.min(actionSeconds, 1) * Math.PI));
          this.el.object3D.position.y += jump * 0.5;
          setRotation("LeftArm", 0, 0, 0.6);
          setRotation("RightArm", 0, 0, -0.6);
          setRotation("LeftUpLeg", -0.3 * jump, 0, 0.08);
          setRotation("RightUpLeg", -0.3 * jump, 0, -0.08);
          setRotation("LeftLeg", 0.4 * jump, 0, 0);
          setRotation("RightLeg", 0.4 * jump, 0, 0);
        } else if (action === "laugh") {
          this.el.object3D.position.y += Math.abs(Math.sin(actionSeconds * 7)) * 0.035;
          setRotation("Head", -0.08, 0, 0.05 * Math.sin(actionSeconds * 6));
          setRotation("LeftArm", 0.08, 0, 0.34 + 0.1 * Math.sin(actionSeconds * 5));
          setRotation("RightArm", 0.08, 0, -0.34 - 0.1 * Math.sin(actionSeconds * 5));
        } else if (action === "hide") {
          const scale = 0.72 + 0.05 * Math.sin(actionSeconds * 3);
          this.el.object3D.scale.multiplyScalar(scale);
        } else if (action === "sleep") {
          setRotation("Head", 0.16, 0, 0.2);
          setRotation("Spine1", 0.12, 0, 0.1);
        } else if (action === "point_app") {
          setRotation("RightArm", 0, 0, -0.75);
          setRotation("RightForeArm", 0.1, 0, -0.35);
        } else {
          setRotation("LeftArm", 0, 0, 0.12 + 0.06 * Math.sin(seconds * 2.1));
          setRotation("LeftForeArm", 0.08 * Math.sin(seconds * 2.1), 0, 0.08);
        }

        if (this.data.speaking && action !== "hide" && action !== "sleep") {
          const gesture = Math.sin(seconds * 5.2);
          const alternate = Math.sin(seconds * 3.6 + 1.2);
          setRotation("Head", -0.025 + 0.04 * alternate, 0.065 * Math.sin(seconds * 2.3), 0.025 * gesture);
          setRotation("Spine1", 0.035 * gesture, 0, 0.035 * alternate);
          setRotation("LeftArm", 0.08 * alternate, 0, 0.34 + 0.18 * gesture);
          setRotation("LeftForeArm", 0.2 + 0.12 * gesture, 0, 0.18);
          if (action !== "point_app") {
            setRotation("RightArm", -0.06 * alternate, 0, -0.34 - 0.18 * gesture);
            setRotation("RightForeArm", 0.2 - 0.12 * gesture, 0, -0.18);
          }
          setRotation("LeftUpLeg", 0.025 * gesture, 0, 0.018 * alternate);
          setRotation("RightUpLeg", -0.025 * gesture, 0, -0.018 * alternate);
          this.el.object3D.position.y += Math.abs(gesture) * 0.012;
        }
      },
    });
  }

  async function refreshHealth(element) {
    try {
      const response = await fetch("api/health", { cache: "no-store" });
      if (!response.ok) throw new Error("health_unavailable");
      const health = await response.json();
      element.textContent = health.openaiConfigured
        ? `OpenAI подключён · ${health.model}`
        : "OpenAI не подключён · работает локальный сценарий";
    } catch {
      element.textContent = "Статическая версия · работает локальный сценарий";
      element.closest(".launcher__content")?.querySelector("[data-api-setup]")?.setAttribute("hidden", "");
    }
  }

  function setupCredentialForm(root, onConfigured) {
    if (!root) return;
    const form = root.querySelector("[data-api-form]");
    const input = root.querySelector("[data-api-key]");
    const submit = root.querySelector("[data-api-submit]");
    const status = root.querySelector("[data-api-status]");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const apiKey = input.value.trim();
      if (!apiKey) return;

      submit.disabled = true;
      input.disabled = true;
      status.classList.remove("is-error", "is-success");
      status.textContent = "Проверяем ключ через OpenAI…";

      try {
        const response = await fetch("api/configure", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey }),
        });
        const data = await response.json();
        if (!response.ok || !data.openaiConfigured) {
          const messages = {
            invalid_api_key_format: "Формат ключа не распознан.",
            api_key_rejected: "OpenAI отклонил ключ. Создайте новый и проверьте доступ проекта.",
            openai_unavailable: "Не удалось связаться с OpenAI. Попробуйте ещё раз.",
          };
          throw new Error(messages[data.error] || "Не удалось подключить ключ.");
        }

        status.textContent = "OpenAI подключён. Теперь доступен голосовой диалог.";
        status.classList.add("is-success");
        await onConfigured?.();
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "Не удалось подключить ключ.";
        status.classList.add("is-error");
      } finally {
        input.value = "";
        input.disabled = false;
        submit.disabled = false;
      }
    });
  }
})();
