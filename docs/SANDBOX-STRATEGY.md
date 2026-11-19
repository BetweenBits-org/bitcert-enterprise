# Attest Core 독립 구축 · 무료체험/Sandbox 경계 설계

**작성일** 2026-11-04 · **상태** `DESIGN.md` 개정 (§2·§4·§11 대체)
**전제 변경** SaaS는 개발계에만 존재하며 상용화 시점 미정 → SaaS는 **참고 소스**로만 사용하고 Attest Core를 독립 구축

> ## ⚠ 개정 고지 (2026-11-04)
> **OTS(OpenTimestamps)는 사용하지 않기로 확정되었습니다** — 타사가 운영하는 공개 서비스이며,
> Simple Proof가 이미 OTS 기반이라 포지셔닝이 겹칩니다 (대표 결정).
> 따라서 본 문서의 **§2 T1 설계 · §4.4 앵커 백엔드 사다리 · §6 결정표 1·4번**은 폐기되었습니다.
> **T1은 OTS 메인넷이 아니라 자체 regtest로 변경**되었고, 앵커링은 전 구간 자체 파이프라인입니다.
> **대체 문서: [`REVIEW-PACKAGE.md`](./REVIEW-PACKAGE.md)** — A7절(체인 구성), D4(앵커 백엔드), D6(검증 범위).
> §0(환경 vs 검증기) · §1(경쟁사 조사) · §2.5(도메인 토폴로지) · §3(동일 백엔드 규칙) · §4.1~4.3(Core 구성)은 유효합니다.

---

## 0. 이전 설계안의 오류 정정

`DESIGN.md`는 P2 Live Sandbox를 **"기존 SaaS로 가는 얇은 프록시"** 로 설계했습니다.
SaaS가 상용화되지 않으면 이 경로는 성립하지 않으므로 폐기합니다.

또한 지적대로, 제가 세 가지 서로 다른 것을 하나로 묶어 설명했습니다. 분리하면 이렇습니다.

| 구성요소 | 코드를 공유해야 하는가 | 이유 |
|---|---|---|
| **환경** (Sandbox / Live) | **반드시 동일 코드** | BitGo · Fireblocks · Stripe 전부 그렇습니다. 샌드박스에서 통과한 코드가 운영에서 다르게 동작하면 샌드박스는 존재 의미가 없습니다 |
| **Instant Demo** | 공유 불필요 | 쓰기가 없습니다. 사전 생성된 fixture를 읽어 검증만 합니다 |
| **검증기 / SDK** | **절대 공유 금지** | 생산자와 검증자가 같은 코드면 버그가 서로 상쇄됩니다. "독립 검증"의 정의 자체가 제2 구현체입니다 |

> **환경은 코드를 공유해야 하고, 검증기는 공유해서는 안 됩니다.**

제 오류는 TS 포팅을 *"Playground의 엔진이 백엔드를 대체한다"* 로 설명한 것입니다.
올바른 위치는 **TS 포팅 = SDK/검증기**(정당한 독립 구현체)이고,
**Sandbox는 실제 Attest Core API와 통신**합니다. Live와 같은 코드로.

---

## 1. 경쟁·참고 업체의 실제 접근방식

| 업체 | 가입 없이 가능한 것 | 가입 후 | 게이트 방식 | 체인 |
|---|---|---|---|---|
| **OpenTimestamps** | **실제 메인넷 앵커링** (공개 calendar, 무료) | — | 게이트 없음 | mainnet |
| **OriginStamp** | 데모에서 파일 해싱 + 타임스탬프 생성, 계정 불필요 | REST API 키 | 셀프서브 | mainnet BTC + ETH, 24h 내 |
| **Simple Proof** | 공개 기록 검증 | 계약 | 영업 | OTS 기반 |
| **BitGo** | 없음 (문서만) | `app.bitgo-test.com` 가입 → **testnet enterprise 자동 생성**, OTP 면제, 장기 access token | **셀프서브 즉시** | 전 자산 testnet, faucet |
| **Fireblocks** | 없음 | 사전 충전 지갑 + API 유저 **기본 제공**, API 유저 5개, testnet 전용 | 신청 → **승인 대기** | testnet only |
| **Stripe** (참고) | 없음 | 가입 즉시 test mode, **동일 대시보드 토글** | 셀프서브 즉시 | — |

### 읽어낼 것 세 가지

1. **우리 카테고리(앵커링·타임스탬프)는 무가입 친화적입니다.**
   OTS와 OriginStamp 모두 계정 없이 *실제* 타임스탬프를 만들게 해줍니다.
   여기를 전부 가입 뒤로 숨기면, 우리가 넘어서려는 기존 업체보다 **덜 개방적으로** 보입니다.

2. **BitGo/Fireblocks가 가입을 요구하는 이유는 제품이 지갑이기 때문입니다.**
   계정 없이는 할 일이 없습니다. 우리는 다릅니다 — 계정 없이도
   "검증"과 "해시 앵커링"이라는 의미 있는 행동이 가능합니다.

3. **Fireblocks의 승인 게이트는 모방하면 안 됩니다.**
   커뮤니티에 "request not granted for developer sandbox" 문의가 올라올 정도의 마찰입니다.
   기술 신뢰도를 입증해야 하는 작은 회사에게 승인 대기는 전환 손실입니다.

> **결론: 무료 구간은 OTS·OriginStamp를 따르고, Sandbox는 BitGo·Stripe를 따르고,
> Fireblocks의 승인 게이트는 따르지 않습니다.**

---

## 2. 4단 티어 설계

### 경계선의 원칙

가입을 요구하는 지점은 마케팅 판단이 아니라 기술적 필요에서 나와야 합니다.

> **"우리가 상태를 보관해야 하는 순간"부터 가입을 요구합니다.**

T0·T1은 보관할 것이 없습니다(T1의 증거는 즉시 사용자에게 넘깁니다).
T2는 API 키·쿼터·웹훅 엔드포인트·보존기간이 필요하므로 신원이 **기술적으로** 필요합니다.

### T0 — Instant Demo · 가입 없음

| 항목 | 내용 |
|---|---|
| 기능 | 사전 앵커링된 실제 메인넷 샘플 · 변조 탐지 · 서명 검증 · Bitcoin Evidence Explorer · 독립 재검증 · 은행 5개 합성 시나리오 + 규칙 재실행 |
| 구현 | **100% 클라이언트.** 정적 fixture + WebCrypto |
| 비용 | 0 |
| 남용 표면 | **0** (쓰기가 없음) |
| 목표 | 보고서의 "첫 방문 30초 안에 기술 경험" |

### T1 — Free Anchor · 가입 없음, 레이트 제한 ★ 차별화 지점

| 항목 | 내용 |
|---|---|
| 기능 | **사용자 본인의 해시를 실제 메인넷에 앵커링.** 실제 `.ots` 증거 + 우리 bundle 래퍼 반환 |
| 백엔드 | **공개 OpenTimestamps calendar** (`alice/bob.btc.calendar.opentimestamps.org`) |
| 비용 | **0** — calendar가 무료이고 비트코인 노드·키·수수료가 전부 불필요 |
| 제한 | IP + Turnstile 레이트 제한, 해시만 수신(원본 미전송), 증거 TTL |
| 확정 | 10~60분 ~ 수 시간 (정직하게 `PENDING` 표시) |
| 표기 의무 | "무료 앵커링은 공개 OpenTimestamps calendar로 집계됩니다. StoneHash 운영 배치는 Sandbox·Live에서 제공됩니다." |

**T1을 포함할 것을 권합니다.** 근거:

- 한계비용이 사실상 0입니다. OTS calendar는 공개 무료 서비스입니다.
- 사이트 전체에서 **신뢰도가 가장 높은 순간**입니다 — "당신 파일을 지금 무료로 앵커링하고,
  우리 서버 없이 검증해 보십시오."
- 남용 위험이 작습니다. 해시 32바이트만 받고 원본을 저장하지 않습니다.
- 보고서가 명시합니다 — *"Playground를 한 번 체험했다고 바로 기업 연락처를 요구하지 않는 것이 좋습니다."*
- `.ots` 증거는 제3자 `ots verify`로 검증 가능하므로 독립 검증 주장이 강화됩니다.

**부수 효과 — 이것이 T1을 P1에 넣어야 할 진짜 이유입니다.**
T1은 `AnchorBackend` 인터페이스를 **가장 저렴한 비용으로 먼저 세우게 만듭니다.**
이후 signet·mainnet 백엔드는 같은 인터페이스에 끼워넣기만 하면 됩니다.

### T2 — Sandbox · 가입 필수, 셀프서브 즉시

| 항목 | 내용 |
|---|---|
| 가입 | 이메일 또는 GitHub/Google OAuth → **즉시 활성화. 영업 통화·승인 대기 없음** |
| 키 | `sk_test_*` — **가입 시 자동 발급** |
| 사전 구성 | 데모 발행자 테스트 키 1개 + 샘플 attestation 1건 **미리 생성** (Fireblocks의 좋은 아이디어 — 60초 안에 첫 호출이 성공) |
| 체인 | **signet** — 우리 Attest Core가 BC01 OP_RETURN을 직접 앵커링 |
| 기능 | 배치 API · 웹훅 · 발행자 서명 · 정책 버전 · 번들 내보내기 — **Live와 동일 API** |
| 쿼터 | 월 1,000건 수준 · 보존 기한 없음 (삭제 요청 전까지 보관, Live와 동일 — 2026-11-13 결정) |
| 가입을 요구하는 이유 | 쿼터 귀속 · 웹훅 엔드포인트 · 키 회전 · 남용 통제 — 전부 신원이 기술적으로 필요 |

### T3 — Live · 유료

| 항목 | 내용 |
|---|---|
| 키 | `sk_live_*` — **동일 코드**, `network=mainnet` |
| 초기 | OTS 백엔드 (자체 메인넷 핫월렛 없이 시작) |
| Enterprise | 자체 배치 앵커링 + SLA + 데이터 보관 요건 |

---

## 2.5 표면 분리 — 도메인 토폴로지 (BitGo 모델) · **확정**

> **대표 결정 (2026-11-04):** "StoneHash 홈페이지는 BitGo처럼 간다."
> 홈페이지는 **제품 설명만** 담고 앱 기능을 두지 않습니다. 체험과 앱은 별도 호스트로 분리합니다.

BitGo는 `bitgo.com`에서 제품 설명만 하고, 우측 Login을 누르면 `app.bitgo.com`으로 넘어갑니다.
테스트 환경은 또 다른 호스트인 `app.bitgo-test.com`입니다.
즉 **환경을 앱 내부 토글이 아니라 호스트명으로 선택**합니다.

| 모델 | 환경 선택 | 장점 | 판단 |
|---|---|---|---|
| **BitGo** | 호스트명 분리(`app` / `app-test`), 계정도 분리 | 테스트 키가 운영 세션에 섞일 수 없음. 샌드박스 인증 완화 가능(BitGo는 **OTP 면제**) | **확정** |
| Stripe | 단일 호스트·단일 계정·앱 내 토글 | 운영 고객이 자기 계정 설정 그대로 테스트 | 2차 (Live 고객 요구 시) |

우리 Sandbox는 **계약 전 기술 평가 도구**이지 운영 계정의 동반 기능이 아니므로 BitGo 모델이 단순하고 안전합니다.

### 세 개의 표면

```
stonehash.com                 제품 설명만 · 앱 기능 0 · 정적 · SEO
  ├ [Try Playground] ──▶ playground.stonehash.com    T0·T1 · 가입 없음
  ├ [Log in]         ──▶ app-sandbox.stonehash.com   T2 · 셀프서브 가입 · signet
  │                      app.stonehash.com           T3 · 계약 고객 · mainnet
  └ [Talk to an Engineer]

docs.stonehash.com            Developer Hub · OpenAPI · Evidence Spec
verify.stonehash.com          공개 검증기 (bitcert-verifier 호스팅)
api-sandbox.stonehash.com     T2 API
api.stonehash.com             T3 API · 동일 코드 · network=mainnet
```

**BitGo와 우리의 결정적 차이:** BitGo의 마케팅 사이트에는 인터랙티브 데모가 **전혀 없습니다**.
우리는 그 규율(홈페이지는 설명만)은 가져오면서, BitGo에 없는 `playground.*`
(무가입 체험 + 실제 무료 앵커링)를 추가합니다. 이것이 앵커링 카테고리에서의 차별점이고
동시에 OTS·OriginStamp와의 개방성 동급을 확보합니다.

**nav / CTA:** 강조 CTA 2개(*Try Playground* · *Talk to an Engineer*) +
우측 상단에 **조용한 텍스트 링크 *Log in***. Login이 버튼으로 히어로 CTA와 경쟁하지 않게 합니다.

---

## 3. Sandbox / Live를 "동일 백엔드"로 만드는 구현 규칙

지적하신 핵심입니다. 포팅이 아니라 환경 분기로 갑니다.

| # | 규칙 | 상세 |
|---|---|---|
| 1 | **`env`는 설정이지 분기가 아님** | 비즈니스 로직에 `if (sandbox)` 금지. 달라지는 것은 `AnchorBackend` 선택과 쿼터 정책뿐 |
| 2 | **키 프리픽스를 눈에 보이게** | `sk_test_` / `sk_live_` — Stripe의 교훈. 운영 사고 1위(테스트 키/운영 키 혼동) 방지 |
| 3 | **데이터 하드 분리** | Postgres 스키마 분리 (`attest_test` / `attest_live`). 교차 조회 경로 없음. 보고서의 "샌드박스·실사용 분리" 요건 |
| 4 | **네트워크 정직성을 와이어 포맷에 내장** | `bundle-schema.md`가 `bitcoin_network`를 **필수 필드**로 요구합니다. signet 번들은 스스로 `"signet"`이라고 말하고 제3자 검증기가 그것을 보고합니다. → **샌드박스 증거를 메인넷으로 위장하는 것이 구조적으로 불가능** |
| 5 | **동일 OpenAPI · 동일 SDK** | base URL만 다름: `api.stonehash.com` ↔ `api-sandbox.stonehash.com` |
| 6 | **Sandbox는 데모가 아님** | 산출물이 공개 체인(signet)의 실제 증거이며 `mempool.space/signet`에서 제3자가 확인 가능. 이것이 가입을 요구할 자격을 줍니다 |

### 우리가 BitGo·Fireblocks보다 유리한 지점

그들의 샌드박스는 그들의 API로만 확인됩니다.
우리 샌드박스 증거는 **고객이 메인넷에 쓸 것과 똑같은 `bitcert-verifier`로**, 우리 서버 없이 검증됩니다.
같은 검증기 · 같은 규격 · 다른 네트워크. 샌드박스 자체가 독립 검증 주장의 증명이 됩니다.

### Sandbox 체인 선택: signet

| 후보 | 판단 |
|---|---|
| regtest | ❌ 우리가 블록을 채굴 → **공개 검증 불가 → 독립 검증 서사가 붕괴** |
| testnet4 | △ 공개 체인이나 블록 간격 불규칙, faucet 고갈 빈번, testnet5 논의 진행 중 |
| **signet** | ✅ **권고.** ~10분 안정 간격, `mempool.space/signet` 탐색기 지원, faucet 안정, 공개 검증 가능 |

---

## 4. 독립 Attest Core 설계

### 4.1 SaaS에서 무엇을 가져오고 무엇을 버리는가

| 분류 | 대상 |
|---|---|
| **그대로 채택** | `bundle-schema.md` (와이어 계약 514줄) · `bitcert-verifier` (검증기, MIT, 무의존성) · `bc30.ts` (TS 암호 340줄) · **BC01 페이로드 레이아웃** (53바이트, 단순) |
| **참고 후 재구현** | `merkle-batching`의 RFC 6962 변형 규칙 (중복 말단 복제 · 단일 리프 예외 · 중복 삽입 금지) → 약 150줄 · OTS calendar 클라이언트 **정책** (재시도·calendar allowlist·404는 정상) · DB 스키마 아이디어 |
| **버림** | BC30/v30 인코더 (**특허**, SaaS도 미구현) · zk-por 전체 (테이블 44개) · NATS · Kong · Helm · manifest.yaml · Makefile 52KB · exchange-por |

**앵커 포맷은 BC01을 씁니다.** 53바이트 = magic + version + merkle_root + batch_id.
`bundle-schema.md §4.1`로 이미 공개된 규격이고, `bitcert-verifier`가 이미 디코드합니다.
특허 얽힘도 witness envelope 복잡성도 없습니다.

> OTS calendar 클라이언트의 정책 주석은 반드시 읽을 가치가 있습니다 —
> *"calendar의 404는 에러가 아니다. 첫 한두 시간 동안의 정상 응답이며,
> 이를 실패로 처리하면 재시도 예산을 태운다."* 이런 운영 지식이 재구현의 핵심 가치입니다.

### 4.2 언어: TypeScript

| 근거 | 내용 |
|---|---|
| 단일 언어 | Core · SDK · Playground · 홈페이지가 한 언어 · 한 툴체인 · 한 `pnpm` 워크스페이스 |
| 검증된 경로 | `bc30.ts` 340줄이 **이미** Rust 테스트 벡터를 통과하는 TS 암호 구현임을 증명 |
| `.ots` 코덱 | 공식 `opentimestamps` npm 패키지 존재 (**직접 구현 금지** — varint·fork marker가 미묘하게 틀리면 고객의 `ots verify`에서 실패) |
| 비트코인 TX | `@scure/btc-signer` — BC01 OP_RETURN 수준에는 충분 |
| 1인 + AI | Rust 대비 반복 속도 우위. 암호 자체는 WebCrypto가 담당 |

### 4.3 구성 — 배포 단위 2개

```
attest-core/
  api/            Fastify 1개 — attestations · batches · proof · verify · keys
  worker/         배치 플러시 → Merkle → AnchorBackend → 확정 감시
  db/             Postgres, 테이블 약 8개 (SaaS는 약 40개)
                  attestations · batches · merkle_proofs · anchor_txs
                  ots_proofs · issuer_keys · api_keys · orgs
```

Postgres 1개 + 프로세스 2개. NATS·Kong·K8s 없음.

### 4.4 핵심 결정: 앵커 백엔드 사다리

```ts
interface AnchorBackend {
  submit(root: Uint8Array): Promise<AnchorHandle>
  poll(handle: AnchorHandle): Promise<AnchorState>
}
```

| 백엔드 | 네트워크 | 비용 | 키 필요 | 쓰이는 곳 | 시점 |
|---|---|---|---|---|---|
| `OtsCalendarBackend` | mainnet | **0** | **없음** | T1 무료 · T3 초기 | **P1** |
| `SignetBackend` | signet | 0 (faucet) | signet 키 | T2 Sandbox | P2 |
| `MainnetBackend` | mainnet | 수수료 | **핫월렛** | T3 Enterprise | **P3 · 유료 확보 후** |

> **가장 중요한 비용·리스크 절감: 유료 고객이 요구할 때까지 메인넷 핫월렛을 만들지 않습니다.**
> 메인넷 키 보관 · 수수료 관리 · reorg 처리가 전체에서 가장 위험한 구성요소입니다.
> 그런데 OTS calendar 덕분에 **첫날부터 "실제 비트코인 앵커링"은 사실입니다.**
> 자체 메인넷 브로드캐스터는 배치 제어·SLA를 돈 내고 요구하는 고객이 생긴 뒤에 만듭니다.

---

## 5. 일정 영향 (정직한 재산정)

`DESIGN.md`는 P2를 "SaaS 프록시 약 8 M/D"로 잡았습니다. 독립 구축으로 바뀌면서 증가합니다.

| 신규 작업 | M/D |
|---|---|
| Attest Core API (Fastify, 엔드포인트 일체) | 10 |
| Merkle 배처 + 워커 | 5 |
| `OtsCalendarBackend` (제출 · 폴링 · upgrade · `.ots` 보관) | 6 |
| `SignetBackend` (BC01 구성 · 서명 · 브로드캐스트 · 확정 감시) | 10 |
| 인증 · API 키 · 쿼터 · 환경 분리 | 8 |
| Postgres 스키마 + 마이그레이션 | 3 |
| 운영 (배포 · Esplora/mempool API 연동 · 모니터링) | 6 |
| **합계** | **48** |

| 단계 | 이전안 | 개정안 | 내용 |
|---|---|---|---|
| P0 | 8~11주 | **8~11주 (변동 없음)** | T0 전부 정적 — Core 불필요 |
| P1 | 17~23주 | **18~24주 (+6 M/D)** | T0 + 은행 심사 + **T1 (OTS 무료 앵커링)** |
| P2 | 27~35주 | **35~43주 (+8주)** | **독립 Attest Core + T2 Sandbox (signet)** |
| P3 | — | +6~10주 | T3 Live · 메인넷 자체 앵커링 (유료 확보 후) |

**P2가 약 8주 늘어나는 것이 SaaS가 상용이 아닌 데서 오는 정직한 비용입니다.**
P0·P1이 영향받지 않는 이유는 그 구간이 Core를 필요로 하지 않도록 설계되어 있기 때문입니다 —
영업 데모와 은행 평가는 일정 변동 없이 진행할 수 있습니다.

운영 비용 선택: 초기에는 **자체 bitcoind를 운영하지 않고** Esplora/mempool.space API로
브로드캐스트·조회를 처리할 것을 권합니다. 노드 운영은 메인넷 자체 앵커링과 함께 P3로 미룹니다.

---

## 6. 확정이 필요한 결정 (권고안 포함)

| # | 결정 | 권고 | 영향 |
|---|---|---|---|
| 1 | T1(가입 없는 실제 무료 앵커링) 포함? | **포함** | 비용 ≈ 0, 신뢰도 최대, OTS·OriginStamp와 동급 개방성 |
| 2 | Core 언어 | **TypeScript** | 단일 툴체인, `bc30.ts`가 경로 검증 완료 |
| 3 | Sandbox 체인 | **signet** | 공개 검증 가능 + 안정적 블록 간격 |
| 4 | 메인넷 자체 앵커링 시점 | **유료 고객 확보 후 (P3)** | 최대 리스크를 매출 뒤로 이동 |
| 5 | Bitcoin 노드 | **초기 Esplora/mempool API, P3에 자체 노드** | 운영 부담 이연 |
| 6 | Sandbox 가입 방식 | **셀프서브 즉시 (승인 게이트 없음)** | Fireblocks의 마찰을 피함 |
| 7 | 앵커 포맷 | **BC01 (53B)** | 특허 비얽힘 + 기존 검증기가 이미 지원 |
| 8 | 환경 노출 방식 | **BitGo 모델 (호스트명 분리)** — 확정 | 테스트/운영 혼동 차단, 샌드박스 인증 완화 가능 |

---

## 7. 변경되지 않는 것

- `bitcert-verifier`는 그대로 채택합니다 (검증기는 독립이어야 하므로 — §0)
- `bundle-schema.md`가 와이어 계약의 단일 진실입니다
- 적합성 테스트 8케이스(정상 5 + **변조 3 실패**)가 배포 게이트입니다
- 홈페이지는 기존 저장소·스택 유지, IA·콘텐츠만 교체 (`DESIGN.md §5`) — 단 **앱 기능은 담지 않음** (§2.5)
- Playground는 Vite + Preact 정적 빌드 (`DESIGN.md §6`) — 단 **`playground.stonehash.com` 별도 호스트** (§2.5)
- 과장 방지 5개 항목을 CI로 강제 (`DESIGN.md §10`)
- 은행 규칙 엔진은 순수 함수, 정책은 데이터 (`DESIGN.md §8`)
