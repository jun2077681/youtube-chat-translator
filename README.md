# YouTube Live Chat Translator (YLCT)

YouTube 라이브 채팅의 일본어 메시지를 **Claude Code CLI(`claude -p`)**를 통해 한국어로 실시간 번역하는 Chrome 확장 프로그램. **Anthropic API 키 없이 Claude Max 구독을 활용**한다.

추가 기능: 한국어 입력을 일본어로 미리보기 번역(KO→JA), 채널 화이트리스트.

> 아키텍처는 [docs/DESIGN.md](docs/DESIGN.md), 변경 이력은 [docs/CHANGELOG.md](docs/CHANGELOG.md) 참조.

---

## 빠른 시작

### 0. 사전 요구사항
- Windows 10/11 (현재 install 스크립트는 Windows만 지원)
- **Node.js 18+** (PATH에 등록)
- **Claude Code CLI** (`claude` 명령이 PATH에 있고 Max 구독으로 로그인됨)
  - 설치 확인: 터미널에서 `claude -p "안녕"` 실행 → 응답이 오면 OK
- **Google Chrome**

### 1. 확장 빌드
extension은 TypeScript로 작성되며 esbuild로 번들합니다. 최초 1회 + 소스 변경 시마다 빌드 필요.

```powershell
cd D:\path\to\youtube-chat-translator\extension
npm install
npm run build
```

산출물은 `extension/dist/`에 생성됩니다.

개발 중 자동 재빌드:
```powershell
npm run watch
```

타입 검사만:
```powershell
npm run typecheck
```

### 2. 확장 로드
1. Chrome `chrome://extensions` 접속
2. **개발자 모드 ON**
3. **압축해제된 확장 프로그램 로드** → `youtube-chat-translator/extension/dist/` 폴더 선택 (소스 디렉토리 아닌 **dist**)
4. 로드된 확장의 **ID(32자리 a-p)**를 복사

### 3. Native Host 등록 (관리자 권한 불필요)
PowerShell에서:

```powershell
cd D:\path\to\youtube-chat-translator\native-host
powershell -ExecutionPolicy Bypass -File install.ps1 -ExtensionId aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

성공 시 출력:
```
[ok] Node.js found: ...\node.exe
[ok] Wrote ...\host.bat
[ok] Updated ...\manifest.json
[ok] Registered HKCU:\...\com.ylct.translator -> ...
```

### 4. 채널 화이트리스트 등록
**중요**: 화이트리스트가 비어있으면 **번역이 동작하지 않습니다**. 사용할 채널을 등록해야 합니다.

1. 등록할 YouTube 라이브 영상 페이지(`/watch?v=...`) 열기
2. 툴바의 YLCT 아이콘 클릭 → popup 열림
3. **메인 탭**에서 현재 채널 정보 확인 → **"이 채널을 화이트리스트에 추가"** 클릭
4. 페이지 새로고침 없이 즉시 반영됨

---

## 기능

### 일본어 → 한국어 자동 번역 (JA→KO)
- YouTube 라이브 채팅의 일본어 메시지를 감지해 원문 아래 한국어 번역 인라인 표시
- 노이즈 패턴(`w+`, `lol`, 순수 이모지 등) 자동 필터링
- 한국어가 우세한 메시지(한글 30%+) 자동 skip
- 본인이 보낸 메시지 자동 skip (입력 모듈에서 30초 추적)

### 한국어 → 일본어 입력 미리보기 (KO→JA)
- 한국어 입력 후 Enter → claude로 일본어 번역
- 입력창에 일본어 번역문 + 노란 배경 미리보기
- **Enter** 한 번 더 → 일본어 전송
- **ESC** → 한국어 복원, 다음 Enter는 한국어 그대로 전송
- 추가 타이핑 → 미리보기 취소, 다시 번역 모드 가능

### 성능 최적화
- **LRU 캐시**: 동일 메시지(예: NightBot 정기 메시지) 재번역 안 함, 최대 2,000개, `chrome.storage.local`에 영속화
- **Persistent claude session**: stream-json multi-message로 한 번 spawn 후 재사용 → 첫 호출 ~10초, 이후 ~3초
- **활성 visibility만 동작**: `document.hidden` 시 LLM 호출 skip
- **WARMUP**: 페이지 로드 직후 cold start 미리 시작
- **`--effort low`**: thinking 최소화, 응답 시간 추가 단축

### 안정성
- **모드 전환 대응**: "주요 채팅" ↔ "실시간 채팅" 전환 시 list 재부착 자동 감지
- **자동 스크롤 보정**: placeholder 삽입으로 인한 height 변화에 따라 즉시+rAF×2+setTimeout 4중 보정
- **확장 reload 안전**: `chrome.runtime.id` 사전 체크 + try/catch로 invalidated context 처리
- **세션 자동 재시작**: turn 누적 시 fresh context로 재시작 (기본 200 turn)

---

## popup UI

### 메인 탭
- **현재 채널**: 활성 탭의 channelId / channelName 자동 감지 (parent `/watch` 페이지의 `<meta itemprop="channelId">`)
- **이 채널 추가** 버튼: 현재 채널을 화이트리스트에 등록 (즉시 반영)
- **화이트리스트** 목록: 등록된 채널들, 개별 제거 버튼
- **옵션**:
  - **번역 대기 시간** (배치 윈도우): 5/10/15/20/30/60초
  - **세션 자동 재시작**: 100/200/500 turn / 사용 안 함
  - **세션 즉시 재시작** 버튼: claude process를 강제 재시작 → fresh context

### 디버그 탭
- **Ping host**: Native Host 연결 sanity check
- **Call claude -p**: 임의 prompt로 claude 호출 테스트

---

## 옵션 가이드

### 번역 대기 시간 (배치 윈도우)
짧을수록 번역이 빨리 표시되지만 LLM 호출 횟수가 증가해 **Max 한도 부담**.

| 값 | 권장 사용 케이스 |
|----|-----------------|
| 5초 | 메시지가 매우 빠르고 즉각 번역이 필요한 경우 |
| **15초** (기본) | 일반 라이브 |
| 30초 | $100 Max 플랜 한도가 빠듯한 경우 |
| 60초 | 풀타임 시청 |

### 세션 자동 재시작
context 누적으로 인한 모델 혼란 방지. 1 turn = 1 LLM 호출 = 1 배치.

| 값 | 의미 |
|----|------|
| 100 turn | ~1.5시간 단위 재시작 |
| **200 turn** (기본) | ~3시간 단위 |
| 500 turn | ~8시간 단위 |
| 사용 안 함 | 수동 재시작만, 200K 컨텍스트 한도까지 진행 |

재시작 시 cold start ~10초 1회 발생.

---

## 디렉토리 구조

```
youtube-chat-translator/
├── docs/
│   ├── DESIGN.md              # 아키텍처/설계
│   └── CHANGELOG.md           # 마일스톤 변경 이력
├── extension/                 # Chrome 확장 (MV3, TypeScript)
│   ├── manifest.json          # dist에 복사됨; 평면 경로 사용 (e.g. "background.js")
│   ├── package.json           # esbuild, typescript, @types/chrome
│   ├── tsconfig.json          # strict 모드
│   ├── build.mjs              # esbuild 번들러 (entry별 IIFE)
│   ├── dist/                  # 빌드 산출물 (gitignore, Chrome 로드 대상)
│   └── src/
│       ├── shared/
│       │   └── constants.ts   # ESM 공유 상수/타입 (MSG, KEY, ChannelInfo 등)
│       ├── background/
│       │   └── background.ts  # service worker, native bridge
│       ├── content/
│       │   ├── content.ts          # 채팅 감지 + 배치 + DOM 주입 (live_chat iframe)
│       │   ├── input-translator.ts # KO→JA 입력 미리보기 (live_chat iframe)
│       │   ├── channel-detector.ts # 채널 정보 추출 (/watch 페이지)
│       │   └── content.css
│       └── popup/
│           ├── popup.html     # 메인/디버그 탭 (dist에 복사됨)
│           └── popup.ts
└── native-host/               # Native Messaging Host (Node.js)
    ├── host.js                # 진입점
    ├── nm-protocol.js         # 4-byte length wire protocol
    ├── claude-runner.js       # one-shot `claude -p` (legacy fallback)
    ├── claude-session.js      # persistent stream-json session (M7)
    ├── manifest.json          # NMH 매니페스트 (install.ps1이 갱신)
    ├── install.ps1            # Windows 등록 스크립트
    └── package.json
```

---

## 트러블슈팅

### 번역이 표시되지 않음
1. **화이트리스트 확인**: popup 메인 탭에서 현재 채널이 등록되어 있는지. 비어있으면 모든 채널 OFF.
2. **콘솔 로그 확인**: 채팅 iframe 콘솔에 `[ylct] enabled = true ...` 가 보이는지.
3. **확장 reload 후 페이지 F5**: 확장만 reload하고 페이지 새로고침을 빼먹은 경우 `chrome.runtime.id` invalidated.

### `Specified native messaging host not found`
- `install.ps1` 정상 실행되었는지 확인
- 레지스트리: `Get-Item "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.ylct.translator"`
- 확장을 재로드 (`chrome://extensions`에서 reload 버튼)

### `Access to the specified native messaging host is forbidden`
- `manifest.json`의 `allowed_origins`가 실제 확장 ID와 일치하는지 확인
- 확장 ID가 바뀐 경우 → `install.ps1` 다시 실행

### `claude exited with code N`
- 터미널에서 `claude -p "안녕"`이 동작하는지 우선 확인
- Max 한도 초과 가능성 → `claude` 직접 실행해서 메시지 확인
- `claude` 명령이 PATH에 없으면 환경변수 `YLCT_CLAUDE_PATH`로 절대경로 지정

### popup의 "현재 채널" 카드가 "감지 실패"
- 활성 탭이 `https://www.youtube.com/watch?v=...` 페이지인지 확인 (`/live_chat` 단독 popout은 미지원)
- 페이지 로드가 끝났는지 (메타 태그 mount 후 popup 다시 열기)

### 자동 스크롤이 placeholder 시점에 동작 안 함
- 임계값 `SCROLL_BOTTOM_THRESHOLD`(기본 150px)이 작은 경우. content.js에서 조정 가능.

### 콘솔 에러: `Extension context invalidated`
- 확장 reload 후 페이지를 새로고침하지 않은 상태. **YouTube 페이지 F5**.

### Native Host stderr 로그 확인
`chrome://extensions` → 본 확장 → **"오류" / "Errors"** 패널에 host stderr가 누적됩니다. `[ylct-host]`, `[ylct-session]` prefix로 필터.

---

## 디버그 명령 (콘솔)

채팅 iframe 컨텍스트로 전환 후 (DevTools 콘솔 상단 좌측 드롭다운):

```js
window.__ylctStats()
// { seen, japanese, korean, noise, skip, pending, done, error,
//   cacheHits, hidden, self, cacheSize }

window.__ylctDebug()
// scroller 상태 (scrollTop, scrollHeight, isNearBottom 등)

window.__ylctEnabled
// true/false (현재 채널이 whitelist 통과했는지)

window.__ylctSentByMe
// 본인이 30초 내 전송한 텍스트 Set
```

---

## 환경 변수 (Native Host)

system 환경 또는 `host.bat`에 설정 가능:

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `YLCT_CLAUDE_PATH` | `claude` | claude CLI 실행 파일 경로 |
| `YLCT_MODEL` | `haiku` | 사용 모델 (haiku/sonnet/opus) |
| `YLCT_SESSION_MODE` | `1` | `0`이면 one-shot (M3 fallback) |
| `YLCT_SESSION_IDLE_MS` | `1800000` (30분) | idle 후 세션 종료 |
| `YLCT_REQUEST_TIMEOUT_MS` | `60000` | 단일 요청 타임아웃 |

---

## Storage 키 (chrome.storage.local)

| 키 | 스키마 |
|----|--------|
| `ylct:cache:v1` | `{version: 1, entries: [[정규화원문, 번역], ...]}` (LRU 순서, 최대 2000개) |
| `ylct:whitelist:v1` | `[{channelId, channelName, addedAt(ISO 8601)}]` |
| `ylct:settings:v1` | `{batchWindowMs: number, maxTurns: number}` |

---

## 제거(uninstall)

```powershell
Remove-Item "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.ylct.translator"
```
그 후 `chrome://extensions`에서 확장 제거. 캐시/화이트리스트 데이터는 chrome이 자동 정리합니다.
