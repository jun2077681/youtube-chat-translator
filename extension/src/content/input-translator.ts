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
  // The element that actually received the preview/translating styling. Under
  // YouTube's shadow DOM, a `document`-level keydown sees `e.target` retargeted to
  // the shadow host — so the styled element differs from what querySelector("#input")
  // finds in the click path. We track it here so whichever handler finalizes the
  // send clears the highlight on the *same* element it was applied to.
  let styledEl: HTMLElement | null = null;

  function getInputText(el: HTMLElement | null): string {
    if (!el) return "";
    if ("value" in el && typeof (el as HTMLInputElement).value === "string") {
      return (el as HTMLInputElement).value;
    }
    return (el.innerText || el.textContent || "").trim();
  }

  // Resolve the element we may safely write into: a real <input>/<textarea>, or a
  // contenteditable. Writing textContent onto a non-editable wrapper (e.g. the
  // shadow host or the members-only placeholder banner) desyncs YouTube's internal
  // value model, producing text that renders but can't be deleted.
  function resolveWritable(el: HTMLElement): HTMLElement | null {
    if ("value" in el && typeof (el as HTMLInputElement).value === "string") return el;
    if (el.isContentEditable) return el;
    const field = el.closest("yt-live-chat-text-input-field-renderer");
    const inner = field?.querySelector<HTMLElement>("#input");
    if (inner && (inner.isContentEditable || "value" in inner)) return inner;
    return null;
  }

  function setInputText(el: HTMLElement, text: string): void {
    const writable = resolveWritable(el);
    if (!writable) return;
    if ("value" in writable && typeof (writable as HTMLInputElement).value === "string") {
      const input = writable as HTMLInputElement;
      const proto = Object.getPrototypeOf(input);
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(input, text);
      else input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    writable.focus();
    writable.textContent = text;
    writable.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  function isKorean(text: string): boolean {
    return HANGUL_RE.test(text);
  }

  function applyPreviewStyle(el: HTMLElement): void {
    styledEl = el;
    el.style.transition = "background-color 0.15s ease";
    el.style.backgroundColor = PREVIEW_BG;
    el.title = "[YLCT] 일본어 번역 미리보기 — Enter로 전송, ESC로 취소";
  }

  // Clears highlight + tooltip on whichever element we actually styled. Falls back
  // to the passed element if nothing is tracked.
  function clearPreviewStyle(el: HTMLElement): void {
    const t = styledEl || el;
    t.style.backgroundColor = "";
    t.title = "";
    styledEl = null;
  }

  function applyTranslatingStyle(el: HTMLElement): void {
    styledEl = el;
    el.style.opacity = "0.6";
    el.title = "[YLCT] 번역 중...";
  }

  function clearTranslatingStyle(el: HTMLElement): void {
    const t = styledEl || el;
    t.style.opacity = "";
    t.title = "";
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

  // Finalize a send that carries already-resolved text (PREVIEW translation or a
  // CANCELLED Korean passthrough): record it as self-sent so the chat observer
  // does not re-translate our own message, then clear all preview affordances.
  function finalizeSend(el: HTMLElement): void {
    recordSentText(getInputText(el).trim());
    clearPreviewStyle(el);
    mode = MODE.IDLE;
    originalKorean = "";
  }

  // Kick off KO->JA translation and enter PREVIEW on success. Shared by the
  // Enter key path and the send-button click path.
  async function translateAndPreview(el: HTMLElement, text: string): Promise<void> {
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

  function findChatInput(scope: Element): HTMLElement | null {
    return scope.querySelector<HTMLElement>(
      "yt-live-chat-text-input-field-renderer #input, #input"
    );
  }

  // The send button submits the same way Enter does but fires no keydown, so we
  // finalize the preview here. This ONLY runs while a translation is active
  // (PREVIEW / CANCELLED / TRANSLATING) — never in IDLE. That matters because
  // YouTube's send-button markup is not reliably identifiable (id-less divs in
  // some builds), so instead of guessing which click is "send" we simply react to
  // any click inside the input renderer while we already own an active preview.
  // In IDLE we stay completely inert, which keeps us out of members-only chat
  // interactions (emoji picker, drag, join banners) that previously misfired.
  function onSendClick(e: MouseEvent): void {
    if (!window.__ylctEnabled) return;
    if (mode === MODE.IDLE) return;

    const target = e.target;
    if (!target || !(target instanceof HTMLElement)) return;

    const renderer = target.closest("yt-live-chat-message-input-renderer");
    if (!renderer) return;
    // A click landing inside the editable itself is the user placing the caret,
    // not submitting — leave it alone.
    if (target.closest("yt-live-chat-text-input-field-renderer")) return;

    const el = findChatInput(renderer);
    if (!el) return;

    if (mode === MODE.TRANSLATING) {
      // Block a submit mid-translation; the preview isn't ready yet.
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // PREVIEW or CANCELLED: record the resolved text as self-sent and drop the
    // highlight, then let the native send proceed.
    finalizeSend(el);
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

    if (mode === MODE.PREVIEW || mode === MODE.CANCELLED) {
      finalizeSend(el);
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

    await translateAndPreview(el, text);
  }

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("click", onSendClick, true);

  console.log("[ylct] input-translator armed (KO->JA preview on Enter)");
})();
