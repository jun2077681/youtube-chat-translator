// Korean -> Japanese chat input translator (preview-before-send mode).

import { MSG, type KoToJaResponse } from "../shared/constants";

declare global {
  interface Window {
    __ylctInputTranslatorLoaded?: boolean;
    __ylctEnabled?: boolean;
    __ylctSentByMe?: Set<string>;
  }
}

(() => {
  if (window.__ylctInputTranslatorLoaded) return;
  window.__ylctInputTranslatorLoaded = true;

  const HANGUL_RE = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;
  const PREVIEW_BG = "rgba(255, 235, 59, 0.25)";
  const SELF_SEND_TTL_MS = 30_000;

  if (!window.__ylctSentByMe) window.__ylctSentByMe = new Set<string>();

  function recordSentText(text: string): void {
    if (!text) return;
    window.__ylctSentByMe!.add(text);
    setTimeout(() => window.__ylctSentByMe!.delete(text), SELF_SEND_TTL_MS);
  }

  const MODE = Object.freeze({
    IDLE: "idle",
    TRANSLATING: "translating",
    PREVIEW: "preview",
    CANCELLED: "cancelled",
  } as const);
  type Mode = (typeof MODE)[keyof typeof MODE];

  let mode: Mode = MODE.IDLE;
  let originalKorean = "";
  let abortGen = 0;

  function getInputText(el: HTMLElement | null): string {
    if (!el) return "";
    if ("value" in el && typeof (el as HTMLInputElement).value === "string") {
      return (el as HTMLInputElement).value;
    }
    return (el.innerText || el.textContent || "").trim();
  }

  function setInputText(el: HTMLElement, text: string): void {
    if (!el) return;
    if ("value" in el && typeof (el as HTMLInputElement).value === "string") {
      const input = el as HTMLInputElement;
      const proto = Object.getPrototypeOf(input);
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(input, text);
      else input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    el.focus();
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  function isKorean(text: string): boolean {
    return HANGUL_RE.test(text);
  }

  function applyPreviewStyle(el: HTMLElement): void {
    el.style.transition = "background-color 0.15s ease";
    el.style.backgroundColor = PREVIEW_BG;
    el.title = "[YLCT] 일본어 번역 미리보기 — Enter로 전송, ESC로 취소";
  }

  function clearPreviewStyle(el: HTMLElement): void {
    el.style.backgroundColor = "";
    el.title = "";
  }

  function applyTranslatingStyle(el: HTMLElement): void {
    el.style.opacity = "0.6";
    el.title = "[YLCT] 번역 중...";
  }

  function clearTranslatingStyle(el: HTMLElement): void {
    el.style.opacity = "";
    el.title = "";
  }

  function requestTranslation(text: string, gen: number): Promise<KoToJaResponse> {
    return new Promise((resolve) => {
      if (!chrome.runtime || !chrome.runtime.id) {
        resolve({ ok: false, error: "extension reloaded — refresh page" });
        return;
      }
      try {
        chrome.runtime.sendMessage(
          { type: MSG.TRANSLATE_KO_TO_JA, text },
          (response: KoToJaResponse | undefined) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
              return;
            }
            if (gen !== abortGen) {
              resolve({ ok: false, error: "aborted" });
              return;
            }
            resolve(response || { ok: false, error: "no response" });
          }
        );
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  function cancelToOriginal(el: HTMLElement): void {
    if (!originalKorean) {
      mode = MODE.IDLE;
      originalKorean = "";
      abortGen += 1;
      clearPreviewStyle(el);
      clearTranslatingStyle(el);
      return;
    }
    setInputText(el, originalKorean);
    abortGen += 1;
    clearPreviewStyle(el);
    clearTranslatingStyle(el);
    mode = MODE.CANCELLED;
    el.title = "[YLCT] 다음 Enter는 한국어 그대로 전송 (수정 시 다시 번역)";
  }

  async function onKeyDown(e: KeyboardEvent): Promise<void> {
    if (!window.__ylctEnabled) return;

    const target = e.target;
    if (!target || !(target instanceof HTMLElement)) return;
    const el = target;

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
      recordSentText(getInputText(el).trim());
      clearPreviewStyle(el);
      mode = MODE.IDLE;
      originalKorean = "";
      return;
    }

    if (mode === MODE.CANCELLED) {
      recordSentText(getInputText(el).trim());
      mode = MODE.IDLE;
      originalKorean = "";
      el.title = "";
      return;
    }

    const text = getInputText(el).trim();
    if (!text) return;
    if (!isKorean(text)) {
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
