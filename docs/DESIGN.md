# StoneHash Attest — 홈페이지 개편 · Playground · Developer Hub 설계안

**작성일** 2026-11-04 · **상태** 개발 착수 전 기획·설계 (코드 미작성)
**근거 문서** `StoneHash_Attest_전문기업_전략_Playground_스테이블코인_증빙_개정확장보고서.docx` (2026-11-03), 사전 전략 대화
**조사 대상 코드** `/home/ubuntu/bitcert-attest/homepage`, `/home/ubuntu/SaaS/bitcert-attest-module`, `/home/ubuntu/SaaS/ann-core`, `/home/ubuntu/bitcert-verifier`

> ## ⚠ 개정 고지 (2026-11-04)
> SaaS가 개발계에만 존재하고 상용화 시점이 미정이므로, 본 문서의 **§2 원칙 일부 · §4.2 P2 아키텍처 ·
> §11 P2 일정**은 폐기되었습니다. P2를 "기존 SaaS로 가는 프록시"로 설계한 부분이 성립하지 않습니다.
> **대체 문서: [`SANDBOX-STRATEGY.md`](./SANDBOX-STRATEGY.md)** — Attest Core 독립 구축,
> 무가입/Sandbox 경계, 동일 백엔드 2환경 설계, 앵커 백엔드 사다리.
> §3(Core 참고 전략) · §5(홈페이지) · §6(Playground) · §8(은행 규칙) · §10(CI 가드레일)은 유효합니다.

---

## 0. 한 장 요약

| 질문 | 결론 |
|---|---|
| 홈페이지를 새로 만들까? | **아니요.** 기존 `stonehash-org/homepage` (정적 HTML + Express/cheerio i18n, 빌드 없음)를 그대로 쓰고 IA·콘텐츠만 교체 |
| Playground 스택? | **Vite + Preact + TS → 정적 `dist/`.** P0·P1은 **백엔드 0개, DB 0개.** **별도 호스트** `playground.stonehash.com` (→ `SANDBOX-STRATEGY.md §2.5`) |
| Attest Core를 어떻게 쓸까? | **읽기 경로만 TS로 포팅, 쓰기 경로는 손대지 않음.** 이미 존재하는 무의존성 구현 3개를 한 패키지로 묶음 |
| 새로 만들 암호 코드? | **거의 없음.** 약 1,000줄이 이미 작성·테스트 벡터 검증 완료 상태로 존재 |
| P1에서 진짜 새로 만드는 것? | 결정적 매칭 규칙 엔진 + 은행 심사역 UI (1-(2)) — 이것만 net-new |
| 기존 SaaS를 건드리나? | **참고 소스로만 사용.** 개발계 전용이므로 Attest Core는 독립 구축 → `SANDBOX-STRATEGY.md §4` |

**설계 한 줄:** 증명을 *만드는* 무거운 것은 기존 SaaS에 두고, 증명을 *검증하는* 가벼운 것만 꺼내서
브라우저에서 돌린다. 그 경계가 곧 고객이 직접 재현해야 하는 경계와 정확히 일치한다.

---

## 1. 무게 진단 — 기존 SaaS가 무거운 이유 (실측)

가볍게 만들자는 판단의 근거를 숫자로 먼저 고정합니다.

| 무게 요인 | 실측값 |
|---|---|
| 마이크로서비스 | 14개 (Rust 10 · Go 2 · Node 2), 약 **103,000줄** |
| 최대 서비스 | `exchange-por` 29,542줄 · `ingestion` 18,080줄 · `verification` 13,387줄 |
| DB 마이그레이션 | **116개 SQL**, 8개 스키마 |
| 빌드 전제조건 | `ann-core` · `ann-platform` · `ann-contracts`를 **형제 디렉터리로 클론**해야 빌드됨 (`[patch]` 오버라이드), CI는 SSH deploy key 필요 |
| 런타임 의존 | PostgreSQL, NATS JetStream, MinIO/S3, bitcoind, Kong, Helm/K8s, Stripe Meters |
| 모듈 계약 | `manifest.yaml` 25KB — Kong 라우트 17개, OAuth 클라이언트 2개, Stripe Meter 5개 |
| 빌드 오케스트레이션 | `Makefile` **52KB** |

핵심은 규모 자체가 아니라 **빌드 전제조건**입니다. `cargo build` 한 번을 돌리기 위해 저장소 4개와
배포 키가 필요합니다. 이 상태의 코드를 Playground가 링크로 참조하면 Playground도 똑같이 무거워집니다.
따라서 **링크(의존)가 아니라 포팅(복제)** 이 정답입니다. 아래 §3에서 그 포팅이 왜 "가짜 엔진"이 아닌지
증명합니다.

---

## 2. 설계 원칙 — 읽기/쓰기 경로 분리

모든 결정이 여기서 파생됩니다.

```
┌─ 쓰기(WRITE) 경로 ─────────────────────────────┐   기존 SaaS에 그대로 둔다
│  증거 수납 · 서명키 · Merkle 배치 집계          │   · 특허 (OP_RETURN v30 인코딩)
│  OP_RETURN v30 인코딩 · bitcoind 브로드캐스트   │   · HSM/키 관리 · reorg 처리
│  reorg 감시 · 상태 전이 · 청구                  │   · P2에서 얇은 프록시로만 접근
└────────────────────────────────────────────────┘
                      │  산출물: Proof Bundle (JSON 1개 파일)
                      ▼
┌─ 읽기(READ) 경로 ──────────────────────────────┐   TS로 포팅해 브라우저에서 돌린다
│  SHA-256 · RFC 6962 Merkle 접기                │   · 무의존성
│  BC01/BC30 디코드 · 원시 TX 파싱 · txid 재계산  │   · 고객이 직접 재현해야 하는 범위
│  서명 검증 · JCS 정규화 · 규칙 평가 · 번들 내보내기│  · = 공개 SDK 산출물과 동일
└────────────────────────────────────────────────┘
```

**이 경계는 임의로 그은 선이 아닙니다.** 보고서가 요구하는 "StoneHash 서버 없이 검증 가능"의 범위와
정확히 같습니다. 즉 읽기 경로를 포팅하는 작업물이 그대로 Developer Hub의 공개 SDK가 됩니다.
하나를 만들어 세 곳에 씁니다 — Playground 엔진 · 공개 검증 SDK · Evidence Spec의 세 번째 적합성 구현체.

파생 원칙:

1. **P0·P1에 서버 사이드 암호 연산 0개.** 브라우저 WebCrypto가 전부 처리합니다.
2. **P0·P1에 DB 0개.** 모든 시나리오는 정적 fixture JSON 파일입니다.
3. **런타임 앵커링 0회.** 실제 비트코인 증거는 **1회 수동 생성**해 fixture로 동결합니다.
4. **인코더는 절대 포팅하지 않습니다.** OP_RETURN v30 인코딩은 특허 출원 중(2024-10-04)이며
   `anchoring-engine`에서도 의도적으로 미구현 상태입니다. 디코더만 포팅합니다 —
   디코드 바이트 레이아웃은 `bundle-schema.md §4.1`로 이미 공개된 규격입니다.

> **개정:** 위 "읽기/쓰기 분리"는 **Instant Demo와 검증기/SDK에만** 적용됩니다.
> **Sandbox·Live 환경은 반드시 동일 코드를 공유해야 합니다** (BitGo·Fireblocks·Stripe 전부 그러함).
> 환경은 코드를 공유하고, 검증기는 공유하지 않습니다 — `SANDBOX-STRATEGY.md §0`.

---

## 3. Attest Core 적용 전략 ★ 가장 중요한 절

### 3.1 발견: TS 포팅은 이미 이 코드베이스에서 검증된 패턴입니다

이 설계의 핵심 근거입니다. 아래 파일이 **이미 존재**합니다.

`bitcert-attest-module/apps/docs/components/bc30.ts` — **340줄, import 문 0개**

```
export sha256 / jcsCanonicalize / policyHash / recordBytes / issueMessage
       generateP256 / signEs256Der / rawSignatureToDer / compressedPublicKey
       keyPopMessage / subjectRefKey / bytesToHex / b64u ...
```

그리고 같은 디렉터리의 `scripts/kat-selfcheck.mjs`가 이 TS 구현을
**Rust 원본의 테스트 벡터에 직접 대조**합니다:

```
ann-core/crates/bc30-leaf/tests/vectors/bc30-v2-kat.json
```

주석이 그 이유를 명시합니다 — *"components/bc30.ts가 동결된 규격에서 1바이트라도 어긋나면
그것이 만든 모든 요청이 issuer_signature_invalid로 거부되고, 독자는 누구 잘못인지 알 수 없다.
그래서 엔진·검증기·콘솔이 모두 고정하는 동일한 정전 벡터에 대조한다."*

**즉 "Rust 코어를 TS로 포팅하고 Rust의 테스트 벡터로 교차검증한다"는 전략은
제가 제안하는 가설이 아니라, 이 팀이 이미 채택해 운영 중인 패턴입니다.**
우리는 그 패턴을 확장하기만 하면 됩니다.

### 3.2 이미 완성된 무의존성 자산 인벤토리 (실측)

| 자산 | 위치 | 규모 | 의존성 | 담당 범위 |
|---|---|---|---|---|
| **BC30 leaf TS 포팅** | `attest-module/apps/docs/components/bc30.ts` | 340줄 | **0개** | SHA-256, JCS 정규화, P-256 생성/서명/DER, leaf 직렬화, key-PoP |
| **KAT 자기검증** | `apps/docs/scripts/kat-selfcheck.mjs` | — | 0개 | 위 TS ↔ Rust 벡터 대조 |
| **브라우저 독립 검증기** | `bitcert-verifier/index.html` | 661줄 | **0개** (`file://` 동작) | Merkle 접기, BC01/BC30 디코드, TX 파싱, txid, witness envelope |
| **CLI 독립 검증기** | `bitcert-verifier/verify-cli/verify.py` | 676줄 | Python **표준 라이브러리만** | 위와 동일 (제2 구현체) |
| **와이어 계약 명세** | `bitcert-verifier/docs/bundle-schema.md` | 514줄 | — | `bitcert-proof-bundle/v1·v2` 권위 규격 |
| **검증 예제 세트** | `bitcert-verifier/examples/` | 8케이스 | — | 정상 5 / 변조 3, 각 `expected.txt` 포함, CI 검증 |
| **Merkle 규격 원본** | `ann-core/crates/merkle-batching` | 1,660줄 | Rust | RFC 6962 변형 규칙 (중복 말단 복제, 단일 리프) |

**합계 약 1,700줄이 무의존성 상태로, 2개 언어 구현체 + 고정 테스트 벡터와 함께 이미 존재합니다.**
P0에 필요한 암호 로직은 사실상 전부 여기 포함되어 있습니다.

> 고정 테스트 벡터 예: `H_leaf(0x00×32) = 7f9c9e31ac8256ca2f258583df262dbc7d6f68f2a03043d5c99a4ae5a7396ce9`
> (`bundle-schema.md §3`, "절대 드리프트 금지"로 명시)

### 3.3 포팅 결정표 — 무엇을 가져오고 무엇을 두는가

| 기능 | 결정 | 근거 |
|---|---|---|
| SHA-256 / JCS 정규화 | **포팅** (bc30.ts 그대로) | 이미 TS, KAT 검증됨 |
| P-256 서명 생성·검증 | **포팅** (bc30.ts 그대로) | WebCrypto, 무의존성 |
| RFC 6962 Merkle 접기·포함증명 | **포팅** (index.html/verify.py에서) | 15줄 수준, 2개 참조 구현 존재 |
| BC01 / BC30 **디코드** | **포팅** | 바이트 레이아웃이 `bundle-schema.md §4.1`로 공개 규격 |
| 원시 TX 파싱 + legacy txid 재계산 | **포팅** | 오프라인 바인딩에 필수, verify.py에 구현 존재 |
| Witness envelope 추출 | **포팅** (P1) | 문서 원본이 체인에 있는 경우 |
| Proof Bundle 검증 드라이버 | **포팅** | verify.py의 `verify_bundle()` 이식 |
| **OP_RETURN v30 인코딩** | ❌ **포팅 금지** | **특허 출원 중**(2024-10-04), `anchoring-engine`도 의도적 미구현 |
| Merkle 배치 집계 (쓰기) | ❌ 포팅 금지 | NATS 이벤트·DB 상태 전이와 결합 |
| bitcoind 브로드캐스트 / reorg | ❌ 포팅 금지 | 노드·키 필요, chain-monitor 영역 |
| 서명 **키 관리** | ❌ 포팅 금지 | HSM/WebAuthn, 기존 ingestion 영역 |
| 테넌트·과금·쿼터 | ❌ 포팅 금지 | P2에서 프록시로 위임 |

### 3.4 결과물: `@stonehash/attest-core`

```
packages/attest-core/          ─ 순수 TS, 런타임 의존성 0개, 브라우저 + Node 양쪽 동작
  src/
    hash.ts        sha256, sha256d, hexToBytes, bytesToHex       ← bc30.ts
    jcs.ts         RFC 8785 정규 JSON                              ← bc30.ts
    merkle.ts      H_leaf, H_node, verifyInclusion, buildTree     ← verify.py §3 / merkle-batching
    anchor.ts      decodeBC01, decodeBC30, parseTx, txidFromRaw   ← verify.py §4 (디코드 전용)
    witness.ts     tapscript envelope 추출                         ← verify.py §6
    signature.ts   P-256 검증, 서명↔신원 분리 판정                  ← bc30.ts
    bundle.ts      ProofBundle 타입 + verifyBundle()               ← verify.py verify_bundle()
    rules.ts       ★ 결정적 정산 매칭 엔진 (유일한 net-new)
    evidence.ts    Evidence Bundle 조립 (manifest/evidence/policy/…)
  test/
    vectors/       bitcert-verifier/examples/* + bc30-v2-kat.json  (심볼릭 복제)
    conformance.test.ts   8개 예제 전부 expected.txt와 일치해야 통과
```

**예상 신규 작성량: rules.ts를 뺀 나머지 약 200줄** (대부분 기존 코드의 재배치 + 타입 선언).
`rules.ts`가 약 300~400줄의 진짜 신규 작업입니다.

### 3.5 드리프트 방지 — "가짜 엔진" 우려에 대한 답

보고서는 *"데모 전용 가짜 엔진을 별도 구축하면 고객이 제품화 가능성을 오해하게 됩니다"* 라고
경고합니다. 타당한 경고이며, 아래 세 장치로 구조적으로 차단합니다.

**가짜 엔진**은 임의의 TXID와 날조된 Merkle Proof를 보여주는 것입니다.
**공개된 와이어 계약의 제2 적합성 구현체**는 그 반대 — 독립 검증 주장의 *증거*입니다.
보고서 스스로 이것을 요구합니다(*"규제기관이나 감사인이 다른 검증기를 만들 수 있어야"*).

| 장치 | 내용 |
|---|---|
| **공유 테스트 벡터** | `attest-core`의 CI가 `bitcert-verifier/examples/` 8케이스를 그대로 돌립니다. 정상 5건 통과 + 변조 3건 **실패**까지 일치해야 green |
| **3중 교차검증** | 동일 벡터를 Rust(producer) · Python(verify.py) · TS(attest-core)가 모두 통과. 어느 하나가 드리프트하면 CI가 깨짐 |
| **규격이 단일 진실** | 세 구현체 모두 `bundle-schema.md`를 참조. 코드가 아니라 **규격**이 계약 |

그리고 Playground가 보여주는 번들은 전부 **기존 SaaS의 `verification` 서비스가 실제로 내보낸 파일**입니다.
Playground는 그것을 *검증만* 합니다. 만들어내지 않습니다.

---

## 4. 시스템 아키텍처 (단계별)

### P0 · P1 — 백엔드 0개

```
        브라우저
 ┌──────────────────────────────────────────┐
 │  Playground (정적 JS)                     │
 │   └─ @stonehash/attest-core (무의존성)    │
 │        WebCrypto: SHA-256 / P-256 검증    │
 └──────────────────────────────────────────┘
        │ fetch (정적 파일만)      │ 선택 · 사용자가 고른 체인 소스
        ▼                          ▼
 ┌──────────────────┐      ┌──────────────────────┐
 │ /fixtures/*.json │      │ mempool.space 등      │
 │  실제 앵커 번들 1 │      │ (StoneHash 아님)      │
 │  은행 합성 5케이스│      └──────────────────────┘
 └──────────────────┘
        ▲
 ┌──────┴──────────────────────────────────────────┐
 │ playground.stonehash.com  정적 호스팅 (CDN/Express) │
 └──────────────────────────────────────────────────┘

 ┌──────────────────────────────────────────────────┐
 │ stonehash.com  기존 Express · i18n · 제품 설명만    │
 │  앱 기능 0 — [Try Playground] / [Log in] 핸드오프   │
 └──────────────────────────────────────────────────┘
```

DB 없음 · NATS 없음 · Kong 없음 · 암호 연산 서버 없음. **프로세스 1개.**

### P2 — ~~얇은 프록시~~ → 독립 Attest Core (폐기 · 대체됨)

~~기존 SaaS로 가는 프록시~~ — SaaS가 상용화되지 않으므로 성립하지 않습니다.

**대체 설계:** Attest Core를 독립 구축합니다. Fastify API 1개 + 워커 1개 + Postgres(테이블 약 8개),
앵커 백엔드는 `OtsCalendarBackend`(무료·메인넷·키 불필요) → `SignetBackend`(Sandbox) →
`MainnetBackend`(유료 확보 후)의 사다리로 구성합니다.
전문은 **[`SANDBOX-STRATEGY.md §4`](./SANDBOX-STRATEGY.md)**.

---

## 5. 홈페이지 개편 설계

### 5.1 현재 상태 (실측)

| 항목 | 값 |
|---|---|
| 저장소 | `github.com/stonehash-org/homepage` (main) |
| 스택 | 정적 HTML 7개 + Express 5 + cheerio i18n 주입 + PM2, **빌드 단계 없음** |
| i18n | `data/translations.json` 51KB, 평면 키 (`main.txt_2` 형태), `/admin`에서 편집 |
| 현재 nav | Solutions · Serve · Architecture · About + Contact |
| 포트 | 3010 (`start.sh`) |

**스택은 이미 충분히 가볍습니다. 교체하지 않습니다.** IA와 콘텐츠만 바꿉니다.

### 5.2 신규 IA

| 신규 경로 | 기존 파일 | 처리 | 내용 |
|---|---|---|---|
| `/` | `main.html` | 콘텐츠 교체 | Hero: *Prove the Record. Verify the Source. Trust No Single Platform.* / CTA 2개만 |
| `/solutions` | `our_solutions.html` | 콘텐츠 교체 | 4개 도메인: Documents & Contracts · Audit & Security · Finance & Digital Assets · Media & Provenance |
| `/solutions/banking` | 신규 | 신규 | 1-(2) 스테이블코인 이동 증빙 — Bank Review로 연결 |
| `/technology` | `architecture.html` | 콘텐츠 교체 | Evidence Core · Merkle · Bitcoin Anchor · 독립 검증 + **"증명하지 못하는 것"** 섹션 |
| `/trust` | `serve.html` 재활용 | 콘텐츠 교체 | Evidence Spec · 테스트 벡터 · 보안·개인정보 정책 · Status |
| `/company` | `about.html` | 유지 + 정리 | 회사 소개 (Attest 실적과 기존 P2P·Lightning 실적 **분리 표기**) |
| `/legacy` | 신규 | 신규 | Settle · Mint — 메인 nav에서 제외, 기존 고객 지원용 |
| `playground.stonehash.com` | — | **별도 호스트** | §6 — 홈페이지 경로가 아니라 분리된 앱 |
| `docs.stonehash.com` | — | **별도 호스트** | §7 |
| `app-sandbox` / `app` | — | **별도 호스트** | T2·T3 — 우측 상단 *Log in* 핸드오프 |

**신규 nav:** `Solutions · Technology · Trust · Playground · Docs`
**강조 CTA 2개:** `Try Playground` · `Talk to an Engineer` + 우측 상단에 **조용한 `Log in` 텍스트 링크** (BitGo 패턴)
**홈페이지 자체는 앱 기능을 담지 않습니다** — 모든 인터랙션은 `playground.*` / `app*.*`로 핸드오프.

### 5.3 i18n 처리

현재 `main.txt_2` 같은 평면 키는 전면 콘텐츠 교체 시 추적이 불가능합니다.
전량 마이그레이션은 비용이 크므로 **점진 전환**을 권합니다.

- 신규·교체 페이지는 **의미 기반 키**로 작성: `home.hero.title`, `solutions.banking.lead`
- 기존 키는 손대지 않고 남겨둠 (admin 대시보드 호환 유지)
- 언어: **EN 기본 + KO**. `vi`(베트남어)는 `/solutions` 계열만 추가 (보고서 권고)
- `bust_cache.js` · `/admin` · cheerio 주입 파이프라인은 그대로 사용

### 5.4 운영 주의

`start.sh`가 **포트 3010**을 쓰는데, attest-module의 `widget` 서비스도 3010입니다.
같은 호스트에 올릴 계획이면 한쪽을 옮겨야 합니다.

---

## 6. Playground 설계

### 6.1 스택 결정

| 후보 | 판단 |
|---|---|
| Next.js (admin-web·fakeex-portal 방식) | ❌ React 19 + Tailwind + SSR — "가볍게" 요구에 역행 |
| 순수 DOM 조작 | ❌ 6요소 증거 카드 + 연결 그래프 + 규칙 재실행 상태관리에 부적합 |
| **Vite + Preact + TS → 정적 dist** | ✅ **권고.** gzip 약 15~20KB, 빌드 산출물이 정적 파일, SSR·DB 불필요 |

CSS는 홈페이지의 `css/variables.css` 토큰을 공유해 디자인 일관성을 확보합니다 (Tailwind 미도입).
배포는 **`playground.stonehash.com` 단일 호스트로 확정**했습니다(`SANDBOX-STRATEGY.md §2.5`).
자산 경로는 상대 경로로 빌드해 호스팅 수단(CDN · 오브젝트 스토리지 · Express)에 종속되지 않게 합니다.

### 6.2 4개 모드 (보고서 F01~F10 매핑)

| 모드 | 대상 | 기능 | 출시 |
|---|---|---|---|
| **Explore** | 비기술 구매자 | F01 파일/해시 증명 · F02 변조 탐지 · F03 서명 검증 · F04 Bitcoin Evidence Explorer | P0 |
| **Bank Review** | 은행 심사역·컴플라이언스 | F09 6요소 증거 검토 · F10 내보내기 (§8) | P1 |
| **Build** | 개발자 | F07 배치·API 테스트 · API Key (P2) | P1/P2 |
| **Verify** | 제3자·감사인 | F05 독립 재검증 — 번들 + 원본 드롭 | P0 |

F06 History & Versioning, F08 Industry Templates는 P1 후반.

### 6.3 상태 표시 규칙 (제품 신뢰의 핵심)

보고서의 강제 요구사항입니다. **단일 녹색 체크를 절대 쓰지 않습니다.**

```
Accepted → Signed → Batched → Submitted → Confirmed → Independently Verified
```

각 검증 축을 **독립된 행**으로 표시:

| 축 | 값 |
|---|---|
| Document Integrity | VALID / INVALID / NOT_CHECKED |
| Issuer Signature | VALID / INVALID / UNKNOWN_ISSUER |
| Issuer **Identity** | **항상 별도 행** — P0/P1은 `DEMO KEY · 공인 CA 아님` |
| Merkle Inclusion | VALID / INVALID |
| Bitcoin Anchor | CONFIRMED / UNCONFIRMED / NOT_CHECKED (오프라인 시 SKIPPED) |
| Evidence Status | 정상 / 검증 실패 / **증거 부족** (위조와 구분) |

`Signature Valid`와 `Identity Verified`의 분리는 보고서가 명시적으로 요구한 사항이며,
Woleet 류와 경쟁하기 위한 최소 수준입니다.

### 6.4 실제 비트코인 증거 조달

P0는 "사전 앵커링된 **실제** Bitcoin TX"를 요구합니다. 런타임 앵커링은 하지 않습니다.

1. 기존 SaaS에 메인넷 앵커가 이미 있으면 → `GET /proof/:id/bundle`로 **1회 내보내기**
2. 없으면 → SaaS로 **1회 수동 앵커링** 후 내보내기
3. 결과 JSON을 `fixtures/real-anchor-mainnet.json`으로 **동결**, 저장소에 커밋

이후 Playground는 이 파일을 읽어 검증만 합니다. 서버 비용·대기시간·키 노출이 전부 0이 됩니다.
→ **확인 필요 사항:** 현재 메인넷 앵커 실적 존재 여부 (§11)

---

## 7. Developer Hub 설계

### 7.1 현재 상태

`attest-module/apps/docs`는 Nextra 기반이지만 **`public/openapi.yaml`이 `paths: {}` 빈 상태**
("TODO: populate paths"). 즉 **재사용 가능한 OpenAPI 스펙은 없고 새로 써야 합니다.**
반대로 `components/ApiTester.tsx`(861줄)와 `IssuanceSigner.tsx`(716줄)는 실제 동작하는
브라우저 서명·API 테스트 UI이므로 **UI 레퍼런스로 활용** 가치가 큽니다.

### 7.2 구성

| 항목 | 조달 방법 | 비용 |
|---|---|---|
| Quick Start | 신규 작성 | 소 |
| **OpenAPI 3.1 Reference** | **신규 작성** + Scalar/Redoc 단일 JS로 렌더 (Docusaurus 미도입) | 중 |
| **Evidence Specification** | `bundle-schema.md` **그대로 공개** | **거의 0** |
| **독립 검증기** | `bitcert-verifier` **그대로 링크** (브라우저 + CLI) | **0** |
| **공개 테스트 벡터** | `bitcert-verifier/examples/` 8케이스 + 은행 5케이스 | 소 |
| **TypeScript SDK** | `@stonehash/attest-core`의 검증 절반을 npm 공개 | **0** (§3.4의 부산물) |
| Bank Scenario SDK | 5개 fixture + 규칙 재실행 코드 | P1 |
| Security & Privacy | 신규 작성 | 소 |
| Changelog / Status | 정적 페이지 | 소 |

**Developer Hub P0는 대부분 "이미 있는 것을 공개하는 일"입니다.** 신뢰도 대비 비용이 가장 낮은 항목입니다.

> 공개 범위: 검증기·규격·테스트 벡터·검증 SDK는 공개. **앵커링 엔진과 v30 인코더는 비공개 유지**(특허).

---

## 8. Bank Evidence Review (1-(2)) 설계 — 유일한 net-new 영역

### 8.1 규칙 엔진

```ts
// rules.ts — 순수 함수, I/O 없음, 정책 버전 고정
evaluate(evidence: SettlementEvidence, policy: Policy): MatchingResult
```

**동일 입력 + 동일 정책 버전 → 항상 동일 판정.** 결과 패키지에 정책 전문을 그대로 기록해
제3자가 재현할 수 있게 합니다.

### 8.2 6개 판정 축 (부록 A-4) — 절대 하나로 합치지 않음

| 축 | 결과값 |
|---|---|
| Integrity | `VALID` / `INVALID` / `NOT_CHECKED` |
| Issuer | `VALID` / `INVALID` / `UNKNOWN_ISSUER` |
| Matching | `MATCH` / `MISMATCH` / `PENDING` |
| Completeness | `COMPLETE` / `INCOMPLETE` |
| Regulatory mapping | `PRESENT` / `MISSING` / `REVIEW_REQUIRED` |
| Business finality | `VERIFIED_BY_SOURCE` / `UNVERIFIED` / `DEMO_ONLY` |

### 8.3 정책을 데이터로

```jsonc
// policies/settlement-match-v1.json
{
  "policyVersion": "settlement-match-v1",
  "currencies": ["USD", "USDC"],
  "amountTolerance": "0.00",
  "fxReference": null,
  "settlementWindow": "P3D",
  "fees": { "deductible": true, "maxBps": 50 },
  "splitPayments": { "allowed": true, "aggregate": true },
  "partyIDMatch": "exact",
  "sourceTrustLevel": "DEMO"
}
```

### 8.4 5개 시나리오 fixture

| 코드 | 시나리오 | 기대 판정 |
|---|---|---|
| A | 정상 무역대금 (Invoice 50,000 USD ↔ 50,000 USDC) | Integrity VALID · Matching MATCH · Regulatory REVIEW_REQUIRED |
| B | 금액 불일치 (50,000 ↔ 48,000, 허용오차 초과) | Matching **MISMATCH** + 기준값/실제값/오차 표시 |
| C | 지급확인 서명 오류 | Issuer **INVALID** (해시·체인은 VALID 유지 — 분리 표시의 핵심) |
| D | 인보이스 누락 | Completeness **INCOMPLETE** (위조와 구분, 요청할 증거 명시) |
| E | 분할 지급 40%+60% | 합산 정책 ON → MATCH / OFF → PENDING |

`Change Amount` · `Break Signature` 버튼은 fixture에 대한 **순수 변환 함수**이며,
변환 후 동일 정책 버전으로 규칙을 재실행합니다. **서버 왕복 0회.**

### 8.5 데모 서명키

빌드 시점에 P-256 데모 발행자 키쌍을 생성해 fixture에 서명하고 **공개키를 함께 배포**합니다.
브라우저가 WebCrypto로 검증합니다. `Identity` 행은 P0/P1 내내 `DEMO KEY — 공인 CA 아님`으로 고정됩니다.

### 8.6 Evidence Bundle 내보내기

기존 `bitcert-proof-bundle`을 **확장**합니다 (새 포맷을 발명하지 않습니다).

```
stonehash-evidence.zip
 ├── manifest.json            dataMode, 생성시각, 구성 목록
 ├── evidence.json            6요소 원천 데이터
 ├── source-hashes.json
 ├── issuer-signatures.json
 ├── policy.json              정책 전문 (버전 포함)
 ├── matching-results.json    6축 판정 + 근거
 ├── merkle-proof.json  ┐
 ├── bitcoin-anchor.json┘     = bitcert-proof-bundle/v1 호환
 └── verification-report.pdf
```

Merkle/anchor 부분이 기존 번들과 호환되므로 **`bitcert-verifier`로도 그대로 검증됩니다.**

---

## 9. 리포지토리 · 배포 구조

```
stonehash-org/homepage              기존·유지 → stonehash.com
  html/ css/ js/ data/ server.js     ← IA·콘텐츠 교체 · 앱 기능 없음

stonehash-org/attest-web            신규 · pnpm workspace
  packages/attest-verify/            ← 무의존성 TS 검증 SDK (npm 공개)
  apps/playground/                   → playground.stonehash.com
  apps/docs/                         → docs.stonehash.com
  apps/console/                      → app-sandbox / app   (T2·T3, 동일 코드)
  fixtures/                          ← 실제 앵커 1건 + 은행 5케이스
  policies/                          ← settlement-match-v1.json

stonehash-org/attest-core           신규 · 독립 백엔드
  api/ worker/ db/                   → api-sandbox / api   (동일 코드, env 분기)

BetweenBits-org/bitcert-verifier     기존·유지 → verify.stonehash.com
BetweenBits-org/bitcert-attest-module 기존 · 참고 소스만 · 수정 없음
```

배포: 호스트별 분리(`SANDBOX-STRATEGY.md §2.5`). 홈페이지는 기존 PM2 그대로,
Playground·Docs는 정적 산출물, Console·API는 Core와 함께.
CI: `attest-web` push 시 `pnpm build` → 호스트별 산출물 배포.
**`attest-verify`의 적합성 테스트(8케이스, 변조 3건 실패 포함)가 깨지면 배포 차단.**

---

## 10. 과장 방지를 CI 테스트로 강제

보고서 부록 D-2의 "대외홍보 금지 사항"은 문서상 약속으로 두면 지켜지지 않습니다.
**테스트로 바꿉니다.**

| 금지 사항 | 강제 테스트 |
|---|---|
| 합성 데이터를 실제처럼 표시 | fixture에 `dataMode: "SYNTHETIC"`이면 렌더 결과에 배너가 **반드시** 존재. 없으면 테스트 실패 |
| 서명 검증 ≠ 신원 확인 혼동 | `Issuer Signature`와 `Issuer Identity`가 **별개 DOM 노드**인지 검사 |
| 없는 증거를 녹색 표시 | `NOT_CHECKED` / `INCOMPLETE` 상태가 success 색상 클래스를 쓰면 실패 |
| 변조본이 통과 | 변조 fixture 3건이 **반드시 FAIL**해야 CI green |
| 규제 준수 자동 보증 암시 | `regulatoryDecision`이 `NOT_EVALUATED`가 아닌 값을 가지면 실패 (P0/P1) |

이 5개는 `attest-core`와 Playground의 테스트 스위트에 넣습니다. 마케팅 문구가 아니라 빌드 조건입니다.

---

## 11. 일정 — 보고서 WBS 대비 재산정

보고서 기준(시니어 1명 + AI, 총 182 M/D, P0 52 M/D · P1 48 M/D)에 §3의 재사용을 반영합니다.

### P0 (보고서 52 M/D → 약 40 M/D)

| 분야 | 작업 | 보고서 | 조정 | 근거 |
|---|---|---|---|---|
| 공통 | 기존 코드·API 재사용 조사 | 4 | **2** | 본 문서가 인벤토리 완료 |
| 브랜드 | IA·홈·Solution 4개·Trust | 9 | 9 | 변동 없음 |
| 기본 | 로컬 해시·증거 카드·변조 데모 | 7 | **5** | `bc30.ts` 해시·JCS 그대로 |
| 서명 | 발행자 서명·검증·신원 상태 | 7 | **5** | `bc30.ts` P-256 + WebCrypto |
| BTC | 증명 재사용·Root/TX Explorer | 7 | **4** | `verify.py` 디코드·txid 이식 |
| Verify | 검증 ZIP·독립 검증 UI | 7 | **4** | `bitcert-verifier`가 곧 산출물 |
| 문서 | Quick Start·기술페이지·FAQ | 5 | 5 | 변동 없음 |
| QA | UI·접근성·오류·배포 | 6 | 6 | 변동 없음 |
| | **합계** | **52** | **약 40** | **약 23% 절감** |

### P1 (보고서 48 M/D → 약 44 M/D)

규칙 엔진·은행 UI·fixture는 **대부분 net-new라 절감 여지가 작습니다.**
내보내기(6 M/D)만 기존 번들 확장으로 약 4 M/D 절감됩니다. 과도한 기대는 금물입니다.

### 누적

| 단계 | 보고서 | 조정 |
|---|---|---|
| P0 공개 MVP | 10~13주 | **8~11주** |
| P1 은행용 1-(2) | 20~26주 | **17~23주** |
| P2 Live 제한공개 | 28~36주 | **35~43주** (독립 Core 구축 +48 M/D → `SANDBOX-STRATEGY.md §5`) |

**절감은 전부 "다시 만들지 않는 것"에서 나옵니다.** 기존 자산이 제가 확인한 상태 그대로일 때만
성립합니다 (직접 읽고 확인했으나, 실제 빌드·실행 검증은 착수 시 1~2일 내에 마쳐야 합니다).
AI 생산성을 근거로 추가 절감을 가정하지 않았습니다.

### 12주 내 영업 데모가 급한 경우 (축소안)

홈 핵심 페이지 + 실제 BTC Proof 1건 + 은행 3케이스(정상·불일치·서명오류) + 샘플 보고서 다운로드.
→ 10~12주 가능. 단 이 단계는 **제품화된 Live Sandbox가 아니라 영업 데모**임을 내부에서 명확히 해야 합니다.

---

## 12. 확인 필요 사항 · 가정

### 착수 전 확인 (블로커)

| # | 항목 | 담당 | 영향 |
|---|---|---|---|
| 1 | **메인넷 실제 앵커 실적이 존재하는가?** 없다면 1회 수동 앵커링 필요 | 개발책임자 | P0의 "실제 Bitcoin 증거" 주장 성립 여부 |
| 2 | `verification` 서비스의 번들 내보내기를 **지금 실행 가능한가?** (DB·bitcoind 기동 필요) | 개발책임자 | fixture 조달 경로 |
| 3 | OP_RETURN v30 **특허 범위가 디코더 공개까지 제한하는가?** | 법무 | §3.3 결정표 (현재는 `bundle-schema.md`로 이미 공개된 상태로 판단) |
| 4 | `@stonehash/attest-core` 검증 절반의 **OSS 공개 승인** | 경영진 | Developer Hub 신뢰도의 핵심 |

### 본 설계가 전제한 가정

- 기존 `homepage` 저장소를 계속 쓰며 재작성하지 않는다
- Playground는 P0·P1 동안 **로그인·DB·서버 암호연산 없이** 동작한다
- 은행 데이터는 전량 합성이며 실제 금융기관 로고·인증 문구를 쓰지 않는다
- 서브도메인 vs 경로는 리버스 프록시에서 결정하며 코드는 양쪽 모두 지원한다
- ~~기존 SaaS는 P2 이전까지 수정하지 않는다~~ → **SaaS는 참고 소스로만 사용하고 Attest Core를 독립 구축한다**

### 범위 밖 (명시적 제외)

실제 은행/지급기관 API 연동 · AML/CFT 적법성 판단 · 공인 CA/TSA 연계 · 자금 이동 ·
현지 법률 검토 · 외부 침투테스트 · Settle/Mint 개편.

---

## 13. 착수 순서 (권고)

| 순서 | 작업 | 산출물 |
|---|---|---|
| 1 | §12의 확인사항 1·2 검증 (1~2일) | 실제 앵커 번들 1건 확보 여부 확정 |
| 2 | `attest-core` 스캐폴딩 + 8개 적합성 테스트 **먼저** green | 드리프트 방지선 선확보 |
| 3 | Verify 모드 (가장 단순, 코어만으로 동작) | 코어 실증 |
| 4 | 홈페이지 IA·Hero·Solutions 4종 | 브랜드 전환 가시화 |
| 5 | Explore 모드 (F01~F04) | P0 데모 완성 |
| 6 | Developer Hub (기존 자산 공개 중심) | 기술 신뢰도 |
| 7 | 규칙 엔진 → 은행 UI → 내보내기 | P1 |

**2번을 1번째 코드 작업으로 두는 것이 중요합니다.** 적합성 테스트가 먼저 서 있어야
이후 모든 UI 작업이 "진짜 엔진 위에서" 돌아간다는 것이 자동으로 보장됩니다.
