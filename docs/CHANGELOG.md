# YLCT — Changelog

마일스톤별 주요 변경사항. 자세한 설계 근거는 [DESIGN.md](DESIGN.md), 사용법은 [../README.md](../README.md) 참고.

---

## 0.10.1 — 클린 아키텍처 리팩토링 (2026-06-13)

확장 버전 0.10.1 (native-host 0.2.0 변경 없음). **동작 변경 없음** — 내부 구조만 책임 단위로 분리.

### 변경 (extension)
- **순수 도메인 분리**: `content.ts`의 분류/정규화 로직을 `domain/classify.ts`(classify/isNoise/pictogramRatio), `domain/normalize.ts`(normalize/collapseRepeats/cacheKey)로 추출 — DOM/chrome 무의존, 단위 테스트 가능
- **채널 탐지 분리**: `readChannelInfoFromDocument` + DOM 헬퍼를 `shared/constants.ts`에서 `shared/channel.ts`로 이동
- **content.ts 분해** (766줄 → 진입점 212줄): `translation-cache`(LRU+영속화) / `batch-queue`(분류·디덥·배칭·적용 파이프라인) / `chat-dom`(placeholder·스크롤핀) / `chat-observer`(MutationObserver·백필·워밍업) / `background-bridge`(메시지 프리미티브) / `stats`(카운터). 순환 방지를 위해 `isEnabled`/`getCurrentList`를 진입점에서 주입(DI)
- **background.ts 분해** (272줄 → 라우터 87줄): `host-port`(Native Messaging 포트 전송) / `parse`(parseClaudeJson) / `translate`(번역 유스케이스). provider는 인자로 주입

---

## M10 — 멀티 번역 제공자 (Claude / Codex / Gemini) (2026-06-02)

확장 버전 0.10.0, native-host 0.2.0.

### 추가
- **번역 제공자 추상화** (`native-host/providers/`): `TranslationProvider` 인터페이스 + claude/codex/gemini 구현 + 레지스트리. 공유 프롬프트 모듈(`translation-prompt.js`)로 system prompt/wrap/schema 일원화
- **팝업 제공자 선택**: 메인 탭 옵션에 claude/codex/gemini 드롭다운, 마지막 선택 영속(`ylct:settings:v1.provider`)
- **Codex 영속 세션** (`codex-session.js`): `codex mcp-server`(MCP/stdio)로 도구 호출 → 호출당 ~5s 안정 (one-shot 8~38s 대비). `YLCT_CODEX_ONESHOT=1`로 `codex exec` 폴백
- **Codex 모델 자동 감지** (`codex-models.js`): `codex debug models`로 계정 가용 mini 중 최저 버전 자동 선택(현재 gpt-5.4-mini), 세션당 1회 캐시. 모델 에러 시에만 재감지·재시도
- **Gemini one-shot 최적화**: `gemini -o json` + `gemini-2.5-flash-lite` + `-e none`. prompt는 stdin 전달(Windows shell 토큰 분리 회피), `.response` 필드 파싱
- **디버그 탭 번역 테스트**: 제공자 선택 + 일본어 입력 → 실제 번역 실행, 사용된 **모델**·번역 결과·소요시간 표시 (`TEST_TRANSLATE`)
- **모델 정보 응답**: host translate 응답에 `model` 포함 (`TranslationProvider.currentModel()`)

### 변경
- 메시지 `CALL_CLAUDE` → `TEST_TRANSLATE`(provider+text)
- `killTree` 공용화(`proc-util.js`) + one-shot `runCommand` 헬퍼 추출
- background가 provider를 storage에서 매 호출 읽던 것을 메모리 캐시 + `storage.onChanged`로 전환
- 호스트 종료 시 전 provider `shutdownAll()`로 좀비 프로세스 방지

### 제공자별 특성
- Claude: 영속 stream-json 세션, `haiku`(별칭이라 버전 무관)
- Codex: 영속 mcp-server, gpt-5.4-mini 자동 감지, ~5s 안정
- Gemini: one-shot flash-lite ~9s (CLI 기동 ~8s 바닥, keyless 모델 목록 API 부재로 자동 감지 불가)

---

## M9 — 채널 화이트리스트 + popup 탭 분리 (2026-05-08)

### 추가
- **popup UI**: 메인/디버그 탭 분리
  - 메인 탭: 현재 채널 표시 + "이 채널 추가" + 화이트리스트 목록 + 옵션
  - 디버그 탭: 기존 Ping/Call 버튼
- **채널 화이트리스트** (`ylct:whitelist:v1`): 등록된 채널에서만 동작 (빈 리스트 = 전체 OFF)
- **`/watch*` content script** (`channel-detector.js`): 메인 페이지에서 channelId/channelName 추출
- **`live_chat` content script**: `window.parent.document` 통해 채널 정보 조회 fallback
- **storage.onChanged 즉시 반영**: 화이트리스트 변경 시 페이지 reload 없이 enable/disable
- **옵션**: 배치 윈도우(5~60초) + 세션 자동 재시작(100/200/500/사용 안 함) + 수동 재시작 버튼
- **세션 자동 재시작** (`turnCount` 기반): context 누적 방지. 임계값 도달 시 fresh spawn
- **`RESET_SESSION` 메시지**: popup → background → host의 `manualRestart()` 호출

### 변경
- 빈 화이트리스트 정책: 이전 "모든 채널 ON" → **모든 채널 OFF** (opt-in)
- `claude-session.js.shutdown()`: listener leak 방지를 위해 `removeAllListeners()` 호출

---

## M8 — KO→JA 입력 미리보기 + 본인 메시지 skip

### 추가
- **`input-translator.js`**: 한국어 입력 가로채기 + 일본어 미리보기
  - State machine: `idle` → `translating` → `preview` → (Enter: 일본어 전송 / ESC: `cancelled` / 타이핑: `idle`)
  - `cancelled`: ESC 후 다음 Enter는 한국어 그대로 전송, 입력 수정 시 `idle`로
- **양방향 wrap** (`claude-session.js`): `WRAP_JA_TO_KO`, `WRAP_KO_TO_JA`. `sendUserMessage(content, direction)` 시그니처
- **`TRANSLATE_KO_TO_JA` 메시지** (background)
- **본인 메시지 skip** (`window.__ylctSentByMe`, 30초 TTL): input-translator에서 전송 시 record, content.js의 handleNode에서 skip

---

## M7 — Persistent claude session (stream-json multi-message)

### 추가
- **`claude-session.js`**: 한 번 spawn된 `claude --print --input-format stream-json --output-format stream-json` 프로세스를 idle timeout(30분)까지 재사용
- **per-message wrap**: system prompt는 spawn 시 `--system-prompt`로 주입, user message는 JSON items + 출력 스키마 enforcement instruction
- **fallback**: `YLCT_SESSION_MODE=0` 환경변수로 one-shot 모드 복귀 가능

### 성능
- 첫 호출: ~10초 (cold start)
- 후속 호출: **~3초** (이전 11초에서 70% 단축)
- 캐시 적중: cache_creation 30K → cache_read 27K + 새 turn ~80 토큰
- 비용: $0.20/호출 → $0.008/호출 (캐시 적중 시 추가 99% 절감)

### 옵션
- `--effort low` 추가: thinking 최소화 (~200ms 추가 절약)
- `--system-prompt`, `--tools ""`, `--disable-slash-commands`, `--exclude-dynamic-system-prompt-sections`로 토큰 최소화

### 안전장치
- **자동 재시작** (M9에서 추가): turnCount ≥ maxTurns 시 spawn 재시작
- listener leak 방지

---

## M5 — LRU 캐시 + 영속화 + visibility skip

### 추가
- **LRU 캐시** (`Map<정규화_원문, 번역>`): 최대 2000개, `chrome.storage.local["ylct:cache:v1"]`에 디바운스 5초 후 영속화
- **정규화** (`normalize`): NFC + trim + 공백 압축 + 전각→반각
- **visibility skip**: `document.hidden` 시 LLM 호출 안 함, 캐시 적중은 계속 적용
- **모드 전환 대응** (`watchForList`): `document.documentElement` 루트 observer로 `#items` 교체 감지 → 자동 재부착
- **자동 스크롤 보정** (`preserveBottomScroll`): 임계값 150px, 즉시 + rAF×2 + setTimeout 4중 보정
- **scroller 자동 탐색**: hard-coded selector + `getComputedStyle().overflowY` fallback
- **확장 context invalidated 처리**: `chrome.runtime?.id` 사전 체크 + try/catch

---

## M3 — 배치 + DOM 주입

### 추가
- **15초 배치 윈도우** + 최대 30개 batch
- **placeholder DOM** (`<div class="ylct-translation" data-ylct-state>`): pending → done/error
- **content.css**: pending(점멸) / done / error(빨강) 상태별 스타일
- **`buildPrompt`**: 시스템 프롬프트 + JSON items 결합 (M7에서 시스템 프롬프트는 host로 이전)
- **`parseClaudeJson`**: 마크다운 펜스 / preamble 처리, fallback으로 first `{` ~ last `}` 추출
- **`TRANSLATE_BATCH` 메시지**: content → background → host

### 측정값 (one-shot 모드)
- 첫 호출: ~10초
- 30개 배치: ~26초
- 1개 배치: ~11초 (cold start 지배적)

---

## M2 — 일본어 채팅 감지

### 추가
- **MutationObserver**: `yt-live-chat-item-list-renderer #items`에 부착, `yt-live-chat-text-message-renderer` 추가 감지
- **분류** (`classify`): japanese / korean / noise / skip
  - 히라가나(`぀-ゟ`) / 가타카나(`゠-ヿ`) 1자 이상 → japanese
  - 한자(`一-鿿`)만 + 한글 없음 → japanese (사용자 결정: 일본어로 가정)
  - 한글 비율 > 30% → korean (skip)
  - 노이즈 패턴(`w+`, `lol`, 순수 이모지 등) → noise
- 콘솔 로그만, DOM 주입 없음 (M3에서 추가)

---

## M1 — Native Host PoC

### 추가
- **`native-host/`**:
  - `nm-protocol.js`: 4-byte length prefix + UTF-8 JSON wire protocol
  - `claude-runner.js`: `child_process.spawn("claude", ["-p", ...])` one-shot 호출
  - `host.js`: stdin/stdout 메시지 라우팅 (`ping` / `translate`)
  - `manifest.json`: NMH 매니페스트 (install.ps1이 절대경로/Extension ID 채움)
  - `install.ps1`: Windows 레지스트리 등록 (`HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.ylct.translator`)
  - `host.bat`: Node.js wrapper (Chrome이 .js 직접 실행 불가)
- **`extension/`** (PoC 단계):
  - `manifest.json`: MV3, `nativeMessaging` 권한
  - `background.js`: service worker, `connectNative` 브리지, pending Map으로 응답 매칭
  - `popup.html` + `popup.js`: Ping / Call 버튼 디버그 UI

### 검증
- Chrome 확장 → Native Host 연결 ✓
- JSON 메시지 송수신 ✓
- `claude -p` spawn + 응답 회신 ✓

---

## 설계 결정사항 요약

### Why Claude Code CLI instead of API?
- 사용자가 별도 Anthropic API 키 발급/결제하지 않고 **기존 Max 구독을 그대로 활용**
- API key 노출/관리 부담 없음
- 단점: stream-json 모드의 컨텍스트 누적 (M9의 자동 재시작으로 완화)

### Why stream-json multi-message?
- one-shot `claude -p`는 매 호출 cold start ~10초 → 라이브에 부적합
- stream-json multi-message로 한 번 spawn 후 후속 호출 ~3초
- 검증된 토큰 사용 패턴: cache_creation 30K → cache_read 27K + 매 turn 80 토큰

### Why 본인 메시지 skip via 30s Set?
- channelId 등 안정적 self-identifier가 iframe 컨텍스트에서 어려움
- input-translator가 send 시점에 텍스트를 record → handleNode가 매칭으로 skip
- TTL 30초로 메모리 leak 방지

### Why opt-in whitelist?
- 사용자 의도와 무관한 채널에서 자동 동작은 부담 (cost / privacy)
- 빈 리스트 = OFF가 안전한 기본값

### Why turn-based session restart?
- claude의 stream-json은 conversation 누적 (PURPLE_BANANA 테스트로 검증)
- cache 덕에 비용은 거의 일정하지만, 100+ turn 누적 시 모델 prior 혼란 가능
- 200K context limit 도달 위험
- 200 turn (~3시간) 기본값으로 cold start 비용 vs context 청결도 균형
