# YLCT — 설계 문서

> Chrome 확장 프로그램으로 YouTube 라이브 채팅의 일본어 메시지를 **CLI 기반 번역 제공자(Claude / Codex / Gemini)** 로 한국어로 실시간 번역. 제공자는 팝업에서 런타임에 선택. 부가 기능으로 한국어 입력의 일본어 미리보기(KO→JA), 채널 화이트리스트, 옵션 토글 제공.
>
> **제공자 특성 (실측 기준)**:
> - **Claude**: 영속 stream-json 세션. 후속 호출 빠름(~5s, haiku).
> - **Codex**: 영속 `codex mcp-server` 세션(MCP/stdio)으로 `codex` 도구를 매 호출. 프로세스 기동을 1회만 지불 → **호출당 ~5s 안정적**. 모델은 `codex debug models`로 **계정 가용 mini 중 최저 버전을 자동 감지**(현재 `gpt-5.4-mini`) + effort `low`. `YLCT_CODEX_ONESHOT=1`이면 `codex exec` 1회성(8~38s)으로 폴백.
> - **Gemini**: `gemini -o json` 1회성. CLI 기동+인증이 ~8s 고정 바닥이라 영속화 이득이 thinking 변동으로 불확실 → one-shot 유지하되 **`gemini-2.5-flash-lite` + `-e none`로 ~9s 일관**되게 최적화. (계정상 더 가벼운 `gemini-3-flash-lite`/`flash-lite-latest`는 미가용.)
>
> 배치 윈도우로 호출 빈도를 낮춰 cold start 부담을 추가 완화.

**최종 갱신**: 2026-05-08 (M9 시점)
**마일스톤 이력**: [CHANGELOG.md](CHANGELOG.md)
**사용 가이드**: [../README.md](../README.md)

---

## 1. 개요

### 1.1 목적
- YouTube 라이브 채팅 시청 중 일본어 메시지를 **자동 감지**하여 원문 아래 한국어 번역 인라인 표시
- 한국어 채팅 입력 시 **일본어 미리보기 후 전송** 옵션 제공
- 별도 Anthropic API 키 없이 **사용자의 Claude Max 구독을 활용**

### 1.2 비기능 목표
| 항목 | 목표 |
|------|------|
| 첫 호출 (cold start) | < 12초 |
| 후속 호출 | < 5초 (session 재사용) |
| 캐시 적중 시 | < 50ms (즉시 DOM 주입) |
| Max 사용량 (5h 라이브) | $100 플랜 한도의 50% 이하 |
| 사용자 의도 보호 | opt-in (whitelist 기반) |
| 추가 메모리 | < 50MB |
| API 키 | **불필요** (Max OAuth) |

---

## 2. 아키텍처

### 2.1 전체 컴포넌트

```
┌──────────────────────────────────────────────────────────────────┐
│ YouTube Watch Page (https://www.youtube.com/watch?v=...)          │
│                                                                   │
│  ┌─────────────────────────────────────────┐                      │
│  │ channel-detector.js                     │                      │
│  │  - meta[itemprop="channelId"] 추출      │                      │
│  │  - GET_CHANNEL_INFO 응답                │                      │
│  └─────────────────────────────────────────┘                      │
│                                                                   │
│  ┌─────────────────────────────────────────┐                      │
│  │ <iframe src="...www.youtube.com/        │                      │
│  │           live_chat?continuation=...">  │                      │
│  │                                         │                      │
│  │  ┌───────────────────────────────────┐  │                      │
│  │  │ content.js                        │  │                      │
│  │  │  - 채팅 감지 (MutationObserver)   │  │                      │
│  │  │  - 일본어/노이즈 분류             │  │                      │
│  │  │  - LRU 캐시 + 영속화              │  │                      │
│  │  │  - whitelist 체크 (parent doc)    │  │                      │
│  │  │  - 15s 배치 + DOM 주입            │  │                      │
│  │  │  - 자동 스크롤 보정               │  │                      │
│  │  │  - storage.onChanged 즉시 반영    │  │                      │
│  │  ├───────────────────────────────────┤  │                      │
│  │  │ input-translator.js               │  │                      │
│  │  │  - 한국어 입력 가로채기 (Enter)   │  │                      │
│  │  │  - 일본어 미리보기 → 전송         │  │                      │
│  │  │  - 본인 텍스트 record (30s TTL)   │  │                      │
│  │  └───────────────────────────────────┘  │                      │
│  └─────────────────────────────────────────┘                      │
└──────────────────────────────┬───────────────────────────────────┘
                               │ chrome.runtime.sendMessage
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ Service Worker (background.js)                                    │
│  - PING_HOST / CALL_CLAUDE / TRANSLATE_BATCH /                    │
│    TRANSLATE_KO_TO_JA / WARMUP / RESET_SESSION                    │
│  - prompt 빌드 + 응답 JSON 파싱                                   │
│  - chrome.runtime.connectNative("com.ylct.translator")            │
└──────────────────────────────┬───────────────────────────────────┘
                               │ Native Messaging (4-byte len + JSON)
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ Native Host — Node.js (host.js)                                   │
│  - nm-protocol.js: stdin/stdout 프레이밍                          │
│  - claude-session.js: persistent stream-json session              │
│    · ja_to_ko / ko_to_ja wrap                                     │
│    · turnCount + auto-restart                                     │
│    · idle timeout (30분)                                          │
│  - claude-runner.js: one-shot fallback                            │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
                 ┌──────────────────────────┐
                 │ Claude Max OAuth          │
                 │ → Anthropic API           │
                 │   (claude-haiku-4-5,      │
                 │    --effort low)          │
                 └──────────────────────────┘
```

### 2.2 파일별 역할

| 파일 | 컨텍스트 | 책임 |
|------|---------|------|
| `extension/manifest.json` | Chrome | MV3 매니페스트, `/live_chat*` + `/watch*` 매칭 |
| `extension/src/background/background.js` | service worker | native bridge, 메시지 라우팅, prompt 빌드, 응답 파싱 |
| `extension/src/content/content.js` | live_chat iframe (isolated) | 감지/배치/주입, 캐시, whitelist, 스크롤 보정, GET_CHANNEL_INFO |
| `extension/src/content/input-translator.js` | live_chat iframe (isolated) | KO→JA 입력 가로채기, state machine, 본인 텍스트 record |
| `extension/src/content/channel-detector.js` | watch page (isolated) | 채널 정보 추출, GET_CHANNEL_INFO 응답 |
| `extension/src/content/content.css` | live_chat iframe | placeholder/done/error 스타일 |
| `extension/src/popup/popup.html` | popup | 메인/디버그 탭 UI |
| `extension/src/popup/popup.js` | popup | 탭 전환, channel detection, whitelist CRUD, 옵션 |
| `native-host/host.js` | OS 프로세스 | stdin/stdout 메시지 라우팅, provider 분기 |
| `native-host/nm-protocol.js` | OS 프로세스 | 4-byte length prefix wire protocol |
| `native-host/translation-prompt.js` | OS 프로세스 | 공유 system prompt / wrap / output schema |
| `native-host/proc-util.js` | OS 프로세스 | killTree + one-shot runCommand 헬퍼 |
| `native-host/providers/types.js` | OS 프로세스 | `TranslationProvider` 인터페이스, provider 판별 |
| `native-host/providers/claude.js` | OS 프로세스 | Claude provider (영속 세션 + one-shot fallback) |
| `native-host/providers/codex.js` | OS 프로세스 | Codex provider (영속 mcp-server + exec one-shot fallback) |
| `native-host/providers/gemini.js` | OS 프로세스 | Gemini provider (`gemini -o json` one-shot, flash-lite) |
| `native-host/providers/index.js` | OS 프로세스 | provider 레지스트리 / 선택 |
| `native-host/claude-session.js` | OS 프로세스 | persistent claude stream-json 프로세스 관리 (M7+) |
| `native-host/codex-session.js` | OS 프로세스 | persistent codex mcp-server (MCP/stdio) 관리 |
| `native-host/codex-models.js` | OS 프로세스 | `codex debug models`로 가용 mini 모델 자동 감지 |
| `native-host/claude-runner.js` | OS 프로세스 | claude one-shot fallback (M3 legacy) |
| `native-host/install.ps1` | PowerShell | NMH 등록 + host.bat 생성 |

### 2.3 Manifest V3

```json
{
  "manifest_version": 3,
  "permissions": ["nativeMessaging", "storage"],
  "background": { "service_worker": "src/background/background.js", "type": "module" },
  "action": { "default_popup": "src/popup/popup.html" },
  "content_scripts": [
    {
      "matches": ["https://www.youtube.com/live_chat*"],
      "js": ["src/content/content.js", "src/content/input-translator.js"],
      "css": ["src/content/content.css"],
      "run_at": "document_idle",
      "all_frames": true
    },
    {
      "matches": ["https://www.youtube.com/watch*"],
      "js": ["src/content/channel-detector.js"],
      "run_at": "document_idle"
    }
  ]
}
```

---

## 3. 데이터 흐름

### 3.1 JA→KO 자동 번역
1. YouTube가 새 채팅 메시지를 list에 append
2. content.js의 messageObserver 콜백 — measure scroll state(wasAtBottom) → handleNode
3. handleNode: enabled 체크 → 분류 → 본인 메시지 skip → 캐시 조회 → visibility check → placeholder 주입 + queue
4. 15s 타이머 또는 30개 도달 → flushBatch
5. background.translateBatch → host.translate (direction=ja_to_ko)
6. claude-session: turnCount 검증 → spawn or 재사용 → user message NDJSON 송신
7. 응답 result → background → content
8. content.applyTranslation: placeholder 교체 + cachePut + scroll preserve

### 3.2 KO→JA 입력 미리보기
1. 사용자: 한국어 입력 + Enter (input-translator의 keydown capture)
2. window.__ylctEnabled false면 pass-through
3. mode=idle + 한국어 → preventDefault, originalKorean 저장, mode=translating
4. background.TRANSLATE_KO_TO_JA → host.translate (direction=ko_to_ja)
5. 응답 ja → setInputText + applyPreviewStyle, mode=preview
6. 사용자 Enter → recordSentText(일본어) → mode=idle, YouTube 일본어 전송
7. 사용자 ESC → originalKorean 복원, mode=cancelled (다음 Enter는 한국어 그대로 전송)
8. 사용자 추가 타이핑 → mode=idle (다시 번역 트리거 가능)

### 3.3 화이트리스트 즉시 반영
1. popup에서 추가/제거 → `chrome.storage.local.set("ylct:whitelist:v1", ...)`
2. content.js의 storage.onChanged 리스너 → recomputeEnabled
3. enabled false→true 첫 전환 시 watchersAttached + watchForList 호출
4. 이후 메시지부터 즉시 번역. 기 진행 중 placeholder는 응답 도착 시 정상 처리

---

## 4. 핵심 모듈 사양

### 4.1 분류 (`content.js#classify`)
1. 빈 텍스트 → `skip`
2. 노이즈 패턴 (`^w+$`, `^ｗ+$`, `^k+$`, `^[ㄱ-ㅎ]+$`, `^(lol|lmao|...)$`, `^[!?.…]+$`, 순수 이모지) → `noise`
3. 한글 비율 > 30% → `korean` (skip)
4. 히라가나/가타카나 1자 이상 → `japanese`
5. 한자만 (한글 없음) → `japanese` (사용자 결정: 일본어 가정)
6. 그 외 → `skip`

### 4.2 정규화 (`content.js#normalize`)
1. Unicode NFC
2. trim
3. 연속 공백 1개로 압축
4. 전각 영숫자 → 반각

### 4.3 LRU 캐시
- `Map<정규화_원문, 번역>` (Map 삽입 순서 LRU)
- 최대 2000 엔트리, 초과 시 oldest 제거
- 조회 적중 시 most-recent로 이동
- 5초 디바운스 후 `chrome.storage.local["ylct:cache:v1"]`에 영속화: `{version: 1, entries: [[k,v], ...]}`

### 4.4 배치 큐
- `queue: {id, ja, node}[]`, `pendingMap: Map<id, {node, ja}>`
- flush: 마지막 enqueue로부터 `batchWindowMs` 또는 `MAX_BATCH_SIZE=30` 도달
- `batchWindowMs`는 settings에서 동적 갱신, 5000~60000ms로 clamp

### 4.5 자동 스크롤 보정
- `SCROLL_BOTTOM_THRESHOLD = 150px`
- scroller 자동 탐색: hard-coded selector → fallback `getComputedStyle().overflowY === "auto"|"scroll"`
- 콜백 시작 시 wasAtBottom measure → mutations 처리 → wasAtBottom이면 즉시 + rAF + rAF + setTimeout 120ms (4중)

### 4.6 채널 감지
`/watch` 페이지에서:
```
meta[itemprop="channelId"]?.content                  // 우선
meta[itemprop="identifier"]?.content                 // fallback
```
채널명 fallback 체인:
```
span[itemprop="author"] link[itemprop="name"]?.getAttribute("content")
ytd-channel-name yt-formatted-string?.textContent
#owner #channel-name yt-formatted-string?.textContent
```
`live_chat` iframe에서는 `window.parent.document`에 같은 셀렉터 적용 (same-origin).

### 4.7 Persistent claude session

**Spawn args**:
```
claude --print
       --input-format stream-json
       --output-format stream-json
       --verbose
       --system-prompt "<양방향 안내 + 출력 규칙>"
       --tools ""
       --disable-slash-commands
       --model haiku
       --effort low
       --exclude-dynamic-system-prompt-sections
```

**Per-message wrap**:
- JA→KO: `Translate the 'ja' field ... Output {"results":[{"id","ko"}]} ... Korean only ...` + JSON items
- KO→JA: `Translate the 'ko' field ... Output {"results":[{"id","ja"}]} ... Japanese only ...` + JSON items

**입력 NDJSON**: `{"type":"user","message":{"role":"user","content":"<wrapped>"}}`

**출력 파싱**:
- `{type:"assistant", ...}` 무시
- `{type:"result", is_error:false, result:"<JSON>"}` → resolve
- `{type:"result", is_error:true}` → reject

**turnCount + auto-restart**:
- 성공 result 시 `turnCount++`
- `sendUserMessage(content, direction, maxTurns)` 진입 시 `turnCount >= maxTurns && idle && proc` → `shutdown()` → 다음 send에서 자동 spawn
- `shutdown()`: `removeAllListeners()` → `kill()` → `proc=null, turnCount=0`

### 4.8 입력 가로채기 state machine

```
                  Enter+한국어
            idle ────────────► translating ──response──► preview
             │                       │                      │
             │                  ESC/error                    │
             │                       │              ┌──Enter (일본어 전송)
             │                       ▼              │
             │                    cancelled ◄──ESC──┤
             │                       │              │
             │                       │              └──타이핑 (idle)
             │                       │
             │                       ├─Enter (한국어 그대로 전송)─►idle
             │                       └─타이핑 ─────────────────►idle
             ▼
        Enter+비한국어 → recordSentText → pass-through
```

전송될 텍스트는 `window.__ylctSentByMe` Set에 30초 TTL로 저장 → content.js의 handleNode가 매칭 시 skip.

### 4.9 화이트리스트 정책

```js
async function shouldOperateForCurrentChannel() {
  const list = await loadWhitelist();
  if (list.length === 0) return false;          // opt-in: 빈 리스트 = OFF
  const info = readParentChannelInfo();
  if (!info || !info.channelId) return false;  // 감지 실패 = OFF (안전)
  return list.some((e) => e.channelId === info.channelId);
}
```

`enabled` 변경 시 `window.__ylctEnabled` 동기화 → input-translator도 자동 ON/OFF.

`storage.onChanged`로 즉시 반영. enabled=false→true 첫 전환에서만 `watchForList()` 호출 (한 번만 부착).

---

## 5. Storage 스키마

### 5.1 `ylct:cache:v1`
```json
{
  "version": 1,
  "entries": [
    ["おつ", "수고했어"],
    ["草", "ㅋㅋ"]
  ]
}
```

### 5.2 `ylct:whitelist:v1`
```json
[
  {
    "channelId": "UCxxxxxxxxxxxxxxxxxxxxxx",
    "channelName": "テストチャンネル",
    "addedAt": "2026-05-08T12:34:56.789Z"
  }
]
```

### 5.3 `ylct:settings:v1`
```json
{
  "batchWindowMs": 15000,
  "maxTurns": 200,
  "provider": "claude"
}
```
`provider`: `"claude" | "codex" | "gemini"` (기본 `"claude"`). background가 매 번역 호출 직전 이 값을 읽어 native host에 전달.

---

## 6. 메시지 프로토콜

### 6.1 content/popup → background
| type | payload | 응답 |
|------|---------|------|
| `PING_HOST` | (none) | `{ok, reply: {text:"pong", elapsedMs}}` |
| `TEST_TRANSLATE` (디버그 탭) | `{provider, text}` | `{ok, provider, model, translated, raw, elapsedMs}` |
| `TRANSLATE_BATCH` | `{items: [{id, ja}], maxTurns}` | `{ok, translations: [{id, ko}], elapsedMs}` |
| `TRANSLATE_KO_TO_JA` | `{text}` | `{ok, ja, elapsedMs}` |
| `WARMUP` | (none) | `{ok, elapsedMs}` |
| `RESET_SESSION` | (none) | `{ok, elapsedMs}` |
| `GET_CHANNEL_INFO` (popup → content tab) | (none) | `{channelId, channelName}` |

### 6.2 background → Native Host
| type | payload | 응답 |
|------|---------|------|
| `ping` | `{id}` | `{id, ok, text:"pong", elapsedMs}` |
| `translate` | `{id, provider?, prompt, direction?, maxTurns?, timeoutMs?}` | `{id, ok, text, model, elapsedMs}` 또는 `{id, ok:false, error, stderr}` (`model`은 실제 사용된 모델, 디버그 표시용) |
| `reset_session` | `{id, provider?}` | `{id, ok, elapsedMs}` |

`provider`: `"claude" | "codex" | "gemini"` (없거나 미지정 시 `claude`). host가 해당 provider로 라우팅. `maxTurns`는 Claude 영속 세션에서만 의미 있고 one-shot provider는 무시.

### 6.3 Native Host ↔ 번역 제공자(provider)

모든 provider는 공유 `translation-prompt`(system prompt + direction별 wrap)를 사용. 출력은 `{"results":[{"id","ko"|"ja"}]}` JSON 텍스트.

- **claude**: 영속 stream-json 세션. Host → claude(stdin): `{type:"user", message:{role:"user", content:"<wrapped>"}}`. claude → Host(stdout NDJSON): `{type:"result", is_error, result:"<JSON>"}` 만 채택, 나머지 무시.
- **codex (기본, 영속)**: `codex mcp-server`를 1회 spawn해 MCP(JSON-RPC 2.0, 개행 구분) `initialize` 후, 매 번역마다 `tools/call` `codex` 도구 호출(`arguments`: prompt, model, sandbox=read-only, cwd, config.model_reasoning_effort=low). 응답 `result.content[].text`가 최종 JSON. idle/요청 timeout + restart는 claude-session과 동일.
- **codex 모델 자동 감지** (`codex-models.ts`): 버전명이 박힌 codex 모델은 버전업·계정별로 이름이 달라지므로, host 세션당 1회 `codex debug models`(계정 가용 카탈로그 JSON)를 실행해 **`visibility:"list"`인 mini 중 버전이 가장 낮은 것**을 자동 선택(예: gpt-5.4-mini)·캐시. mini가 없거나 명령 실패 시 `-m` 생략(CLI 기본). `YLCT_CODEX_MODEL` 지정 시 자동 감지를 건너뛰고 그 값 사용. (참고: `codex login` 토큰이 만료되면 `tools/call`이 인증 에러를 반환하므로 재로그인 필요 — 코드와 무관.)
- **codex (폴백, `YLCT_CODEX_ONESHOT=1`)**: `codex exec --sandbox read-only --skip-git-repo-check -C <tmp> -c model_reasoning_effort=low --output-last-message <tmp> -`. prompt는 stdin, 최종 메시지를 파일에서 읽어 잡음 없는 JSON 확보(읽은 뒤 삭제).
- **gemini**: `gemini -o json --approval-mode yolo --skip-trust -e none -m gemini-2.5-flash-lite`. prompt는 stdin(공백 포함 `-p` 인자는 Windows shell에서 토큰 분리되어 실패). stdout JSON의 `.response` 필드에서 본문 추출. (`-e none`+flash-lite로 startup/지연 최소화; 영속 ACP는 모델 thinking 변동·복잡도로 제외.)

환경변수 오버라이드: `YLCT_CODEX_ONESHOT`(=1이면 codex 1회성), `YLCT_CODEX_MODEL`(빈값=CLI 기본), `YLCT_GEMINI_MODEL`(빈값=CLI 기본, 기본 flash-lite), `YLCT_CODEX_EFFORT`, `YLCT_*_PATH`, `YLCT_*_TIMEOUT_MS`, `YLCT_*_IDLE_MS`, `YLCT_*_CWD`.

### 6.4 (legacy) Native Host ↔ claude
- Host → claude (stdin): `{type:"user", message:{role:"user", content:"<wrapped prompt>"}}` + 줄바꿈
- claude → Host (stdout NDJSON):
  - `{type:"assistant", message:{...}}` (무시)
  - `{type:"result", is_error, result:"<JSON 또는 텍스트>"}`
  - `{type:"system", ...}` (무시)

---

## 7. 보안 / 프라이버시

| 항목 | 처리 |
|------|------|
| API 키 | 사용 안 함 (Max OAuth) |
| 메시지 본문 | Native Host 거쳐 Anthropic으로만 송신 |
| Native Host 접근 제한 | `allowed_origins`에 본 확장 ID만 명시 |
| 캐시 | 평문 저장 (개인 환경 가정) |
| 화이트리스트 | local 저장, channelId/channelName/addedAt만 보존 |
| `host_permissions` | 사용 안 함 |
| Same-origin 접근 | youtube.com → youtube.com 동일 origin 허용 |

---

## 8. 비용 / 한도 추정 (Haiku 4.5)

가정: 분당 5메시지, 일본어 70%, 캐시 적중률 40%, 배치 윈도우 15초.

- 일본어 메시지: 210/시간
- 캐시 미적중: 126/시간
- 호출: ~84/시간 (배치당 1.5)

| 메트릭 | 첫 호출 | 후속 |
|-------|---------|------|
| 응답 시간 | ~10s | ~3s |
| input_tokens | 10 | 10 |
| cache_read | 0 | ~30K |
| cache_creation | ~30K | ~80 |
| 비용 (정가) | $0.04 | $0.008 |

**5시간 라이브**: $0.04 + 420 × $0.008 ≈ **$3.4** (정가). Max 정액제에선 호출 카운트 차감만 적용.

**Max 한도**:
- $100 플랜 ~225/5h → 84×5=420 호출 ≈ 한도 초과 → 배치 30초로 늘리면 ~210 호출로 안전권
- $200 플랜 ~900/5h → 여유

---

## 9. 마일스톤 / 변경 이력

[CHANGELOG.md](CHANGELOG.md) 참고.

---

## 10. 미해결 / 향후 결정사항

1. **macOS / Linux 지원**: install.ps1만 있음. plist/json 매니페스트 위치 다름.
2. **Popout 전용 채팅 창**: parent 없을 때 채널 감지 불가.
3. **YouTube DOM 변경 대응**: 셀렉터 fallback 추가 검토.
4. **Streaming 출력**: 부분 표시. UX 복잡도 trade-off.
5. **모델 선택 popup**: provider(claude/codex/gemini) 선택은 popup에서 가능. 각 provider의 모델은 아직 환경변수(`YLCT_*_MODEL`)로만 오버라이드 — popup 모델 선택은 향후 과제.
6. **화이트리스트 export/import**: JSON 파일로 백업/공유.
7. **stats 영속화**: 세션/일/주 단위 누적.
