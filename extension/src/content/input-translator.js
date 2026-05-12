// Korean -> Japanese chat input translator (preview-before-send mode).
//
// User flow:
//   1. Type Korean message into the YouTube chat input.
//   2. Press Enter -> intercepted, send to claude.
//   3. Translation appears in the input box, highlighted (yellow).
//   4. Press Enter again -> YouTube sends the Japanese version.
//      Press Escape    -> Korean text restored.
//      Type more       -> preview cancelled, returns to idle.

(() => {
  "use strict";

  if (window.__ylctInputTranslatorLoaded) return;
  window.__ylctInputTranslatorLoaded = true;

  const { MSG } = globalThis.YLCT_CONST;

  const HANGUL_RE = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;
  const PREVIEW_BG = "rgba(255, 235, 59, 0.25)";
  const SELF_SEND_TTL_MS = 30_000;

  // Shared with content.js (same isolated world). Tracks text that the
  // current user just submitted, so the chat-detector can skip it.
  if (!window.__ylctSentByMe) window.__ylctSentByMe = new Set();

  function recordSentText(text) {
    if (!text) return;
    window.__ylctSentByMe.add(text);
    setTimeout(() => window.__ylctSentByMe.delete(text), SELF_SEND_TTL_MS);
  }

  // mode lifecycle:
  //   IDLE ─Enter(KO)─> TRANSLATING ─resp─> PREVIEW
  //                                          │
  //                            Enter ────────┴─> IDLE (Japanese sent)
  //                            ESC ──────────┴─> CANCELLED (Korean restored)
  //                            typed ────────┴─> IDLE (user editing)
  //   CANCELLED ─Enter─> IDLE (Korean sent as-is, NOT re-translated)
  //   CANCELLED ─typed─> IDLE (user editing → next Enter triggers translate again)
  const MODE = Object.freeze({
    IDLE: "idle",
    TRANSLATING: "translating",
    PREVIEW: "preview",
    CANCELLED: "cancelled",
  });
  let mode = MODE.IDLE;
  let originalKorean = "";
  let abortGen = 0;

  function getInputText(el) {
    if (!el) return "";
    if ("value" in el && typeof el.value === "string") return el.value;
    return (el.innerText || el.textContent || "").trim();
  }

  function setInputText(el, text) {
    if (!el) return;
    if ("value" in el && typeof el.value === "string") {
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, text); else el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    el.focus();
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  function isKorean(text) {
    return HANGUL_RE.test(text);
  }

  function applyPreviewStyle(el) {
    if (!el) return;
    el.style.transition = "background-color 0.15s ease";
    el.style.backgroundColor = PREVIEW_BG;
    el.title = "[YLCT] 일본어 번역 미리보기 — Enter로 전송, ESC로 취소";
  }

  function clearPreviewStyle(el) {
    if (!el) return;
    el.style.backgroundColor = "";
    el.title = "";
  }

  function applyTranslatingStyle(el) {
    if (!el) return;
    el.style.opacity = "0.6";
    el.title = "[YLCT] 번역 중...";
  }

  function clearTranslatingStyle(el) {
    if (!el) return;
    el.style.opacity = "";
    el.title = "";
  }

  function requestTranslation(text, gen) {
    return new Promise((resolve) => {
      if (!chrome.runtime || !chrome.runtime.id) {
        resolve({ ok: false, error: "extension reloaded — refresh page" });
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: MSG.TRANSLATE_KO_TO_JA, text }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          if (gen !== abortGen) { resolve({ ok: false, error: "aborted" }); return; }
          resolve(response || { ok: false, error: "no response" });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err && err.message || err) });
      }
    });
  }

  function resetToIdle(el) {
    mode = MODE.IDLE;
    originalKorean = "";
    abortGen += 1;
    clearPreviewStyle(el);
    clearTranslatingStyle(el);
  }

  function cancelToOriginal(el) {
    if (!originalKorean) { resetToIdle(el); return; }
    setInputText(el, originalKorean);
    abortGen += 1;
    clearPreviewStyle(el);
    clearTranslatingStyle(el);
    mode = MODE.CANCELLED;
    el.title = "[YLCT] 다음 Enter는 한국어 그대로 전송 (수정 시 다시 번역)";
  }

  async function onKeyDown(e) {
    // Pass-through when this channel is not whitelisted (set by content.js).
    if (!window.__ylctEnabled) return;

    const el = e.target;
    if (!el || !(el instanceof HTMLElement)) return;

    const isChatInput = el.closest("yt-live-chat-message-input-renderer, yt-live-chat-text-input-field-renderer");
    if (!isChatInput) return;

    if (e.key === "Escape") {
      if (mode !== MODE.IDLE) {
        e.preventDefault();
        e.stopPropagation();
        cancelToOriginal(el);
      }
      return;
    }

    if (mode === MODE.TRANSLATING && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (mode === MODE.PREVIEW && e.key.length === 1 && !e.ctrlKey && !e.metaKey && e.key !== "Enter") {
      mode = MODE.IDLE;
      originalKorean = "";
      clearPreviewStyle(el);
      return;
    }

    // In CANCELLED mode, any input edit (single-char or Backspace/Delete)
    // returns to IDLE so the next Enter can re-trigger translation.
    if (mode === MODE.CANCELLED && e.key !== "Enter" &&
        (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete") &&
        !e.ctrlKey && !e.metaKey) {
      mode = MODE.IDLE;
      originalKorean = "";
      el.title = "";
      return;
    }

    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;

    if (mode === MODE.PREVIEW) {
      // Record the (Japanese) text that's about to be sent.
      recordSentText(getInputText(el).trim());
      clearPreviewStyle(el);
      mode = MODE.IDLE;
      originalKorean = "";
      return;
    }

    if (mode === MODE.CANCELLED) {
      // Korean about to be sent as-is.
      recordSentText(getInputText(el).trim());
      mode = MODE.IDLE;
      originalKorean = "";
      el.title = "";
      return;
    }

    const text = getInputText(el).trim();
    if (!text) return;
    if (!isKorean(text)) {
      // Non-Korean (e.g. Japanese typed directly) about to be sent — record.
      recordSentText(text);
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    originalKorean = text;
    mode = MODE.TRANSLATING;
    const gen = ++abortGen;
    applyTranslatingStyle(el);

    const reply = await requestTranslation(text, gen);
    clearTranslatingStyle(el);

    if (gen !== abortGen) return;

    if (!reply.ok || !reply.ja) {
      console.warn("[ylct] KO->JA translate failed:", reply.error);
      mode = MODE.IDLE;
      originalKorean = "";
      return;
    }

    setInputText(el, reply.ja);
    applyPreviewStyle(el);
    mode = MODE.PREVIEW;
  }

  document.addEventListener("keydown", onKeyDown, true);

  console.log("[ylct] input-translator armed (KO->JA preview on Enter)");
})();
