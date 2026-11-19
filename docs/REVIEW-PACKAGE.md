# StoneHash Attest — 홈페이지 기획안 및 전체 시스템 아키텍처

**작성일** 2026-11-04 · **목적** 개발 착수 전 팀·대표 합의(consensus) 및 **이해 일치 확인**
**읽는 순서** 대표·기획: A → B → C / 개발: A → B → D
**관련 문서** [`DESIGN.md`](./DESIGN.md) (기술 설계) · [`SANDBOX-STRATEGY.md`](./SANDBOX-STRATEGY.md) (티어·환경 전략)

> 이 문서는 **승인 요청서**입니다. A절의 전제가 제가 잘못 이해한 것이라면
> 그 아래 전부가 틀어지므로, A절부터 검토해 주시기 바랍니다.

---

## A. 제가 이해한 전제 — 확인 요청

| # | 제가 이해한 내용 | 확인 |
|---|---|---|
| A1 | StoneHash를 **Attest(독립 검증 가능한 디지털 증거 인프라) 전문기업**으로 재포지셔닝한다. Settle·Mint는 메인에서 내린다 | ☐ |
| A2 | **기존 홈페이지 저장소·스택을 유지**하고 IA와 콘텐츠만 교체한다. 재작성하지 않는다 | ☐ |
| A2′ | **기존 톤앤매너(디자인 아이덴티티)를 그대로 유지한다.** 폰트·색상·레이아웃 문법·애니메이션을 바꾸지 않고, **콘텐츠 개편만** 한다 | ☐ |
| A3 | 홈페이지는 **BitGo처럼 제품 설명만** 담고 앱 기능을 두지 않는다. 체험·앱은 별도 호스트 | ☐ |
| A4 | **기존 SaaS(`bitcert-attest-module`)는 개발계 전용이며 상용화 시점 미정** → 참고 소스로만 쓰고 **Attest Core를 독립 구축**한다 | ☐ |
| A5 | Sandbox는 **포팅이 아니라 동일 코드의 다른 환경**이다 (BitGo·Fireblocks·Stripe 방식) | ☐ |
| A6 | 단, **검증기/SDK는 의도적으로 별개 구현체**다. 생산자와 검증자가 같은 코드면 버그가 상쇄되어 독립 검증이 무의미해진다 | ☐ |
| A7 | **앵커링은 전부 자체 파이프라인 · regtest로 연동한다** — signet 코인 조달 난이도 + 수익화 전 비용 억제. 메인넷 전환은 고객 구독 의사 확인 후 | ☐ |
| A7′ | **OTS(OpenTimestamps)는 당사 서비스에 넣지 않는다** — 타사 운영 공개 서비스이며, Simple Proof가 이미 OTS 기반이라 포지셔닝이 겹친다 | ☐ |
| A8 | 은행용 1-(2) 스테이블코인 증빙은 **전량 합성 데이터**로 하고, 실제 금융기관 연동·AML 판단은 범위 밖이다 | ☐ |
| A9 | 개발 자원은 **시니어 1명 + AI** 기준이다 | ☐ |
| A10 | 최우선 목표는 트래픽이 아니라 **은행·기업의 유료 PoC 의향 검증**이다 | ☐ |

### A7의 결과 — 체인 구성과 남은 결정

**OTS(OpenTimestamps)는 사용하지 않습니다.** OpenTimestamps 프로젝트가 운영하는 공개 서비스이므로
당사 제품에 넣는 것은 부적절합니다. 비용 이전에 **포지셔닝 문제가 더 큽니다** —
경쟁사 분석에서 확인했듯 **Simple Proof가 이미 OTS 기반**입니다. 개발자가 StoneHash에서 처음
테스트하는 것이 OpenTimestamps가 되면 "증거 인프라 전문기업"이 아니라 **OTS 재판매**로 보입니다.
자체 Merkle 집계·BC01 앵커·Evidence Package가 차별점인데 그것을 보여주지 못하게 됩니다.

**따라서 앵커링은 전부 자체 파이프라인으로만 합니다.** 체인 구성은 이렇게 됩니다.

| 티어 | 체인 | 확정 시간 | 성격 |
|---|---|---|---|
| T0 Instant Demo | 사전 생성 fixture | — | 정적 · 읽기만 |
| T1 Free Anchor | **regtest** | **즉시** | 자체 파이프라인 전 구간 체험 |
| T2 Sandbox | **regtest** | **즉시** | API 연동 평가 |
| T3 Live | mainnet | 10분~ | **구독 확보 후 (P3)** |

#### T1의 성격이 바뀝니다 (OTS → regtest)

T1은 여전히 **가입 없이 본인 파일로 직접 해보는 기능**이지만, 자체 regtest에 앵커링합니다.
오히려 **체험 품질은 더 좋아집니다.**

| | OTS 안 (폐기) | regtest 안 (확정) |
|---|---|---|
| 확정 시간 | 10분~수 시간 (`PENDING` 대기) | **즉시 (~1초)** |
| 보여주는 것 | OpenTimestamps 파이프라인 | **StoneHash 자체 파이프라인 전 구간** |
| 체험 흐름 | 해시 → 대기 → 나중에 다시 방문 | **해시 → 앵커 → 확정 → 번들 다운로드 → 오프라인 검증 (한 세션)** |
| 공개 체인 검증 | 가능 | 불가 |

#### 남은 결정 하나 — 홈 §2 Live Proof Strip용 메인넷 앵커 1건

현재 구성에는 **공개적으로 검증 가능한 증거가 한 건도 없습니다.** 포지셔닝 전체가
"StoneHash를 신뢰하지 않고도 검증 가능"에 걸려 있는데, regtest는 우리가 블록을 채굴하므로
그 주장을 지탱하지 못합니다.

여기서 제가 이전에 구분하지 못했던 점을 바로잡습니다.
**"메인넷 앵커링 서비스"와 "메인넷 앵커 1건"은 전혀 다른 작업입니다.**

| | 메인넷 앵커링 **서비스** (P3) | 메인넷 앵커 **1건** (수동) |
|---|---|---|
| 핫월렛 운영 | **필요** | 불필요 — 노트북에서 1회 |
| 키가 서비스에 들어가는가 | **들어감** | **들어가지 않음** |
| 수수료 정책·RBF·배치 주기 | **필요** | 불필요 |
| reorg 운영 절차 | **필요** | 불필요 (수년 전 블록으로 고정) |
| 비트코인 노드 운영 | **필요** | 불필요 (브로드캐스트만) |
| 비용 | 배치마다 반복 | **트랜잭션 1건 수수료, 1회로 끝** |
| 산출물 | 운영 기능 | **fixture JSON 1개 (영구 재사용)** |

구체적 작업: BC01 OP_RETURN 트랜잭션(약 200 vB) 1건을 로컬에서 구성 →
공개 브로드캐스트 엔드포인트로 1회 전송 → 확정 후 번들 내보내기 →
`fixtures/real-anchor-mainnet.json`으로 **동결**하고 저장소에 커밋. **이후 영구 재사용.**

> **기존 SaaS에 메인넷 앵커 실적이 이미 있으면 비용 0원입니다** —
> `verification` 서비스에서 번들만 내보내면 끝입니다 (F1·F2).

**제 권고: 이 1건을 포함하는 것(E6-ⓐ).** 수수료 1건으로 포지셔닝의 핵심 주장을 지탱합니다.
목표 고객(은행 심사역·감사인)이 정확히 이 지점을 확인하려는 사람들입니다.

**포함하지 않아도(E6-ⓑ) 설계·일정은 바뀌지 않습니다.** 바뀌는 것은 카피(C6)와 검증 범위 표(D6)뿐이며,
그 경우 "독립 검증 가능" → "검증 절차를 **재현** 가능", "Bitcoin에 앵커링" →
"**비공개 테스트 체인**(regtest)에 앵커링"으로 전 구간 하향합니다. 이 하향 문구는 이미 C6에 반영해 두었습니다.

### regtest가 주는 실질 이점 (전 구간 공통)

- 블록을 즉시 생성하므로 **첫 API 호출이 1초 안에 확정**됩니다 (signet 10분, mainnet 수십 분)
- **reorg를 우리가 일으킬 수 있습니다** — `Simulate reorg` · `Instant confirm` · `Fast-forward N blocks`.
  signet·mainnet으로는 제공 불가하며 경쟁사 샌드박스에 없는 테스트 기능입니다
- faucet 불필요, IBD 없음 → 노드 디스크·동기화 부담 사실상 0
- 외부 서비스 의존이 전혀 없습니다 — **장애가 개발·CI·데모를 막지 않습니다**

---

## B. 확정된 결정 로그

| # | 결정 | 확정 내용 | 근거 |
|---|---|---|---|
| B1 | 브랜드 | StoneHash 유지, Attest를 대표 제품으로 | 보고서 §01 |
| B2 | 홈페이지 | 기존 저장소 개편 (신규 구축 아님) | 보고서 §02 C안 |
| B2′ | 홈페이지 디자인 | **톤앤매너 100% 유지** — 비주얼 리디자인 아님 | 대표 결정 |
| B3 | 표면 분리 | **BitGo 모델** — 호스트명 분리, 홈페이지에 앱 기능 없음 | 대표 결정 |
| B4 | Attest Core | **독립 구축**, SaaS는 참고만 | A4 |
| B5 | Core 언어 | **TypeScript** (Core·SDK·Web 단일 툴체인) | `bc30.ts`가 경로 검증 |
| B6 | 앵커 포맷 | **BC01 (53바이트)** — v30 인코더는 특허로 제외 | `bundle-schema.md §4.1` |
| B7 | 체인 | **전 구간 regtest** (T1·T2 포함) | A7 · 대표 결정 |
| B7′ | OTS 사용 | **금지** — 타사 서비스 · 포지셔닝 중복 | A7′ · 대표 결정 |
| B8 | 메인넷 앵커 1건 (홈 §2용) | **미확정 — E6에서 결정 요청** (권고: 포함. 수수료 1건, 1회) | A7 |
| B9 | 메인넷 자체 앵커링 | **고객 구독 의사 확인 후 (P3)** | 최대 리스크를 매출 뒤로 · 대표 결정 |
| B9′ | 체인 전환 방식 | **`AnchorBackend` 구현체 교체 = 환경변수 1개.** 코드 수정 없음 | D4 |
| B10 | Sandbox 가입 | **셀프서브 즉시** (승인 게이트 없음) | Fireblocks 마찰 회피 |
| B11 | 검증기 | `bitcert-verifier` 그대로 채택 + TS SDK 공개 | A6 |

---

# C. 홈페이지 기획안

> **전제: 이것은 콘텐츠·IA 개편이며 비주얼 리디자인이 아닙니다.**
> 아래 모든 섹션은 **현재 사이트에 이미 존재하는 CSS 컴포넌트로 구현**됩니다.
> 신규 폰트·신규 색상·신규 레이아웃 문법을 도입하지 않습니다.

## C0. 톤앤매너 보존 명세

### 변경하지 않는 것 (`css/variables.css` 그대로)

| 항목 | 현재 값 | 처리 |
|---|---|---|
| 서체 | `Red Hat Display` (400/500/700/900) + `Inter` | **유지** |
| Primary | `#00A8BA` (틸) | **유지** |
| Secondary | `#0074E8` (블루) | **유지** |
| 본문·보조 | `#4F5658` · `#424F51` · `#020D0F` | **유지** |
| 그레이 스케일 | `#B5B7B7` ~ `#EDEEEE` 6단계 | **유지** |
| 섹션 배경 | `--color-serve: #F7F9FA` | **유지** |
| 화살표·강조 | `--color-arrow: #2DA5B7` | **유지** |
| 타입 스케일 | H1 64px · p 18px · nav 16px | **유지** |
| 레이아웃 | container 1200px · header 80px · section-space 100px | **유지** |
| 곡률 | `--radius-btn: 10px` | **유지** |
| 스크롤 애니메이션 | AOS (`data-aos="fade-up"`) · sticky 레이어 | **유지** |
| PC/모바일 이미지 쌍 | `.only-pc` / `.only-mobile` · `*_mo.png` | **유지** |

### 검증 상태 색상 — 기존 팔레트에서 파생

증거 검증 UI에는 VALID/INVALID/NOT_CHECKED 표시가 필요합니다.
**신규 팔레트를 만들지 않고** 기존 토큰에서 가져옵니다.

| 상태 | 사용 토큰 |
|---|---|
| VALID / Verified | `--color-primary` `#00A8BA` |
| INVALID / Failed | `--color-red` `#FF0000` |
| NOT_CHECKED / 증거 부족 | `--color-gray` `#B5B7B7` — **의도적으로 무채색** (녹색 금지) |

> `variables.css`에 **추가를 제안하는 유일한 토큰**은 완화된 오류색(`#FF0000`은 다소 강함) 1개뿐이며,
> 이마저도 필요 없다고 판단되면 기존 값을 그대로 씁니다. 그 외 추가는 없습니다.

### 재사용할 기존 컴포넌트

| 컴포넌트 | 현재 용도 | 개편 후 용도 |
|---|---|---|
| `.main-section` `.main-title` `.main-desc` `.btn-demo` | 히어로 | **히어로** (카피만 교체) |
| `.solution-section` `.title-group` `.sub-label` `.grid-container` `.solution-card` | 솔루션 4카드 | **증명 기능 4카드 · 산업 4카드** |
| `.about-card` `.about-card-label` `.about-card-title` `.about-card-sub-stats` | 거래량·매출 카운터 | **Live Proof Strip** — Merkle Root / TXID / 블록 높이 |
| `.found-section-wrapper` `.found-item` `.found-icon` `.found-text-box` | 아이콘+텍스트 목록 | **"무엇을 증명하지 못하는가"** |
| `.architecture-section` `.layers-container` `.layer-1`~`.layer-7` `.arch-sticky` | 7단 레이어 스티키 스크롤 | **`/technology` 7계층 아키텍처** (계층 수가 정확히 일치) |
| `.serve-section` `.serve-grid` (bg `#F7F9FA`) | 보조 그리드 | **How it works 3스텝 · Developer strip** |
| `.black-card` | 다크 강조 카드 | **Banking 1-(2) 와이드 카드** |
| `.modal-overlay` `.modal-content` `.submit-btn` | 상담 모달 | **Talk to an Engineer** |
| `.sub-section` `.sub-title` `.sub-solution-card` | 하위 페이지 | **하위 페이지 전부** |

**새로 만들 비주얼 컴포넌트: 0개.** `.about-partners`(로고 월)와 카운터 숫자만 제거합니다.

---

## C1. 사이트맵

```
stonehash.com                        기업 홈페이지 · 제품 설명 전용 · 앱 기능 0
├── /                                홈
├── /solutions                       산업별 솔루션 (4 도메인)
│   ├── /solutions/documents         전자계약·문서
│   ├── /solutions/audit             보안·감사
│   ├── /solutions/finance           디지털자산·준비금
│   ├── /solutions/media             미디어·출처
│   └── /solutions/banking     ★    스테이블코인 이동 증빙 (1-(2))
├── /technology                      기술·보안 + "증명하지 못하는 것"
├── /trust                           Evidence Spec · 테스트 벡터 · 정책 · Status
├── /company                         회사 소개
└── /legacy                          Settle · Mint (기존 고객 지원)

      ↓ 핸드오프 (별도 호스트)
playground.stonehash.com             T0·T1 — 가입 없음
app-sandbox.stonehash.com            T2 — 셀프서브 가입 · regtest
app.stonehash.com                    T3 — 계약 고객 · mainnet
docs.stonehash.com                   Developer Hub
verify.stonehash.com                 공개 검증기 (bitcert-verifier)
```

## C2. 글로벌 내비게이션 · CTA

```
┌──────────────────────────────────────────────────────────────────────┐
│ StoneHash    Solutions  Technology  Trust  Playground  Docs          │
│                                     Log in   [ Try Playground ]  🌐  │
└──────────────────────────────────────────────────────────────────────┘
```

- **강조 CTA 2개:** `Try Playground` (버튼) · `Talk to an Engineer` (히어로·푸터)
- **`Log in`은 조용한 텍스트 링크** — BitGo 패턴. 버튼으로 히어로 CTA와 경쟁시키지 않습니다
- `Playground`·`Docs` 내비 항목은 **외부 호스트로 나가는 링크**입니다
- 기존 `Contact Us` → `Talk to an Engineer`로 교체 (전문기업 포지셔닝)
- 상담 폼 수집 항목: 회사명 · 업종 · 증명 대상 데이터 · 예상 월 사용량 · 기존 시스템 · 도입 목적

## C3. 홈(`/`) 섹션 구성

**재사용 컴포넌트** 열이 톤앤매너 보존의 근거입니다 — 모든 섹션이 기존 CSS로 구현됩니다.

| # | 섹션 | 내용 | 재사용 컴포넌트 |
|---|---|---|---|
| 1 | **Hero** | H1 *Prove the Record. Verify the Source. Trust No Single Platform.*<br>서브: 데이터의 존재와 변경 여부, 발행자의 서명, 기록의 연속성을 **공개적으로** 검증할 수 있는 증명 인프라<br>CTA: `Try Playground` · `Talk to an Engineer` | `.main-section` `.main-title`<br>`.main-desc` `.btn-demo`<br><em>배경 슬라이더는 3장→1장 축소(선택)</em> |
| 2 | **Live Proof Strip** ★ | 실제 메인넷 앵커 **1건의 실데이터** 노출 — Merkle Root / TXID / 블록 높이 / 확정 수 + `Verify this yourself →` (verify.stonehash.com) | **`.about-card` 그대로**<br>카운터 숫자 자리에 실제 암호 데이터<br><em>첫 화면에 말이 아니라 증거를 둡니다</em> |
| 3 | **네 가지 증명 기능** | Timestamp · Sign & Seal · History · Verify — 각 카드에 "보장 범위"와 "별도 필요 범위"를 **함께** 표기 | `.solution-section`<br>`.grid-container` `.solution-card` |
| 4 | **산업별 진입** | Documents & Contracts · Audit & Security · Finance & Digital Assets · Media & Provenance (4카드) + **Banking 1-(2) 와이드 카드** | `.grid-container` `.solution-card`<br>+ `.black-card` (Banking) |
| 5 | **무엇을 증명하지 못하는가** ★ | 앵커링이 자동 보장하지 **않는** 것을 명시 (원본의 진실성 · 법적 신원 · AML 적합성 · 규제 승인 · 정밀 법정시각) | `.found-section-wrapper`<br>`.found-item` `.found-icon` |
| 6 | **How it works** | 3스텝: ① 브라우저에서 해시 (원본 미전송) → ② Merkle 집계 후 비트코인 앵커 → ③ **StoneHash 없이** 독립 검증 | `.serve-section` `.serve-grid` |
| 7 | **Developer strip** | Quick Start 코드 블록 1개 + `docs.stonehash.com` · GitHub 검증기 링크 | `.serve-section` (bg `#F7F9FA`) |
| 8 | **Closing CTA** | `Try Playground` · `Talk to an Engineer` | `.btn-demo` `.btn-contact` |

**제거 대상:** 기존 Custody/Lending·RWA·Lightning 병렬 노출, 미사용 고객사 로고 월
(실제 계약 없는 로고는 보고서 D-2 금지 사항), about 카운터(거래량·매출) — **Attest 실적과 혼동 금지**

## C4. 하위 페이지 기획

### `/solutions` — 4 도메인 허브
각 도메인 카드: 고객 문제 → 시연 내용 → 목표 구매자 → `Playground에서 체험` 링크

### `/solutions/banking` ★ — 1-(2) 스테이블코인 이동 증빙
| 섹션 | 내용 |
|---|---|
| 문제 정의 | 은행 심사역이 온체인 이동·지급 확인·은행 지시·상업 문서를 몇 단계로 확인하는가 |
| 6개 증거 요소 | ① 자금 이동 ② 지급 완료 ③ 은행 지시 ④ 상업 근거 ⑤ 매칭 결과 ⑥ 봉인 |
| 5개 테스트 | 정상 · 금액 불일치 · 서명 오류 · 문서 누락 · 분할 지급 |
| 한계 명시 | AML/CFT 적법성·규제 승인·자금 출처를 자동 증명하지 않음 |
| CTA | `Bank Review 체험` (playground) · `Talk to an Engineer` |
| 상단 고정 | **Synthetic Bank & Provider Data** 배너 |

### `/technology`
**기존 `.architecture-section` 7단 스티키 스크롤을 그대로 재사용** —
계층도 7개(Client / API & Tenant / Evidence Core / Transaction Evidence / Matching / Anchoring / Verification)가
기존 `.layer-1`~`.layer-7`과 **개수가 정확히 일치**하므로 신규 비주얼 작업이 없습니다. 그 외:
RFC 6962 Merkle 구성 · BC01 앵커 레이아웃 · 세 시점 분리(**Recorded / Signed / Anchored**) ·
RFC 3161 TSA와 비트코인 블록시각의 차이 · **"증명하지 못하는 것"** 상세

### `/trust`
Evidence Specification 공개 · 공개 테스트 벡터 · 독립 검증기 2종(브라우저·CLI) ·
보안·개인정보 정책 · 키 관리 · 데이터 보관·삭제 · Status · Changelog

### `/company`
회사 소개. **Attest 실적과 기존 P2P·Lightning 운영 실적을 분리 표기** (보고서 §12 요구)

### `/legacy`
Settle · Mint — 메인 내비에서 제외, 기존 고객·계약 지원용. 서비스 종료 여부는 별도 결정

## C5. 기존 페이지 처리

| 기존 | 처리 | 결과 |
|---|---|---|
| `main.html` | 콘텐츠 전면 교체 | `/` |
| `our_solutions.html` | 구조 재활용 + 콘텐츠 교체 | `/solutions` |
| `architecture.html` | 구조 재활용 + 콘텐츠 교체 | `/technology` |
| `serve.html` | 구조 재활용 + 콘텐츠 교체 | `/trust` |
| `about.html` | 유지 + 실적 표기 정리 | `/company` |
| `admin.html` | **그대로 유지** (번역 관리) | `/admin` |
| `popup.html` | 상담 모달로 재사용 | — |
| — | 신규 | `/solutions/banking`, `/legacy` |

`server.js`의 `routes` 맵과 `serve.json` `rewrites`에 신규 경로를 추가합니다.
`bust_cache.js` · cheerio i18n 주입 · `/admin`은 손대지 않습니다.

## C6. 카피 가이드 · 금지 표현

**원칙:** 기능을 나열하지 않고, 고객이 **직접 확인할 수 있는 것**과 **확인할 수 없는 것**을 구분해 말합니다.

| 쓰지 않을 표현 | 대체 표현 |
|---|---|
| "Proof of Reserves Verified" | "Reserve **Report Integrity** Verified" |
| "규제 준수 인증 API" | "Evidence Package & **Deterministic Validation** API" |
| "Verification success" (단일) | 축별 분리 — Integrity / Issuer / Anchor / Rules / Completeness |
| "W3C VC 100% 호환" | 적합성 시험 통과 전에는 사용 금지 |
| "은행이 승인했습니다" | 실제 계약·승인 없이는 사용 금지 |
| 미계약 고객사 로고 | 표시 금지 |
| **regtest 증거에 "Bitcoin에 앵커링" 단독 표기** | "**비공개 테스트 체인**(regtest)에 앵커링" — **regtest 증거 전부에 적용** |
| **regtest 증거에 "독립 검증 가능"** | "검증 절차를 **재현** 가능" (4개 링크 중 3개) |
| OTS · OpenTimestamps 기능 노출 | **사용하지 않음** (A7′) |
| E6-ⓑ 선택 시 사이트 전역 | "독립 검증 가능" · "Trust No Single Platform" **사용 불가** — 공개 검증 증거가 0건이므로 |

## C7. i18n

- **EN 기본 + KO** 병행. `vi`(베트남어)는 `/solutions` 계열만
- 신규·교체 페이지는 **의미 기반 키**(`home.hero.title`) — 기존 `main.txt_2` 평면 키는 그대로 보존
- 모든 개발 문서를 3개 언어로 관리하지 않습니다 (비용 과다)

---

# D. 전체 시스템 아키텍처

## D1. 네 개의 표면 + 백엔드

```
┌─ 표면 1 ─────────────────────────────────────────────────────────┐
│  stonehash.com            제품 설명 전용 · 앱 기능 0               │
│  기존 Express + cheerio i18n + PM2 · 빌드 단계 없음               │
└──────────────────────────────────────────────────────────────────┘
      │ [Try Playground]              │ [Log in]
      ▼                               ▼
┌─ 표면 2 ──────────────────────┐  ┌─ 표면 3 ───────────────────────┐
│ playground.stonehash.com      │  │ app-sandbox / app              │
│ T0 Instant Demo (정적)         │  │ T2 Sandbox   T3 Live           │
│ T1 Free Anchor  (regtest)     │  │ 동일 코드 · env 분기             │
│ Vite + Preact · 가입 없음      │  │ API Key · 쿼터 · 웹훅            │
└───────────────────────────────┘  └────────────────────────────────┘
      │                                      │
      │ @stonehash/attest-verify             │ REST
      │ (무의존성 TS SDK · 검증 전용)           ▼
      │                            ┌─ Attest Core (독립) ───────────┐
      │                            │  api/     Fastify              │
      │                            │  worker/  batch→merkle→anchor  │
      │                            │  db/      Postgres (8 테이블)   │
      │                            └────────────────────────────────┘
      │                                      │
      ▼                                      ▼
┌─ 표면 4 ──────────────────────┐  ┌─ AnchorBackend ────────────────┐
│ verify.stonehash.com          │  │ Regtest  자체 노드 · 전 구간     │
│ bitcert-verifier (무의존성)     │  │ Mainnet  P3 · 구독 확보 후       │
│ 브라우저 + Python CLI          │  │ (OTS 사용하지 않음)              │
│ StoneHash 서버 호출 없음        │  └────────────────────────────────┘
└───────────────────────────────┘
```

## D2. Attest Core 내부

| 모듈 | 역할 | 시점 |
|---|---|---|
| `api/attest` | 해시·문서 수납, 발행자 서명 검증, attestation 생성 | P2 |
| `api/proof` | Merkle 포함증명 · Proof Bundle 조립·내보내기 | P2 |
| `api/verify` | 서버측 검증 (편의 기능 — 독립 검증을 대체하지 않음) | P2 |
| `api/keys` | API Key 발급·회전·쿼터 | P2 |
| `worker/batcher` | 배치 플러시 (최대 1024 리프 또는 시간 트리거) → Merkle Root | P2 |
| `worker/anchor` | `AnchorBackend.submit()` → 상태 전이 | P1 |
| `worker/confirm` | 확정 감시 · 상태 전이 · reorg 처리 | P1 / P2 |
| `rules/` | **결정적 정산 매칭 엔진** (은행 1-(2)) — 순수 함수, 정책은 데이터 | P1 |

**DB 테이블 7개:** `orgs` · `api_keys` · `attestations` · `batches` · `merkle_proofs` ·
`anchor_txs` · `issuer_keys`  *(기존 SaaS는 약 40개)*

## D3. 환경 분리

| | Sandbox (T2) | Live (T3) |
|---|---|---|
| 호스트 | `app-sandbox` / `api-sandbox` | `app` / `api` |
| 키 | `sk_test_*` | `sk_live_*` |
| 체인 | **regtest** (자체 노드) | mainnet |
| 앵커 백엔드 | `RegtestBackend` | `RegtestBackend` → `MainnetBackend` (P3 구독 후) |
| DB 스키마 | `attest_test` | `attest_live` |
| 쿼터 | 월 1,000건 · 보존 기한 없음 | 계약 · 보존 기한 없음 (2026-11-13 결정) |
| 코드 | **동일** — `if (sandbox)` 분기 금지 | **동일** |

**정직성은 와이어 포맷에 내장됩니다.** `bundle-schema.md`가 `bitcoin_network`를 필수 필드로
요구하므로, regtest 번들은 스스로 `"regtest"`라고 말하고 제3자 검증기가 그것을 보고합니다.
→ **샌드박스 증거를 메인넷으로 위장하는 것이 구조적으로 불가능합니다.**

## D4. AnchorBackend 사다리

```ts
interface AnchorBackend {
  submit(root: Uint8Array): Promise<AnchorHandle>
  poll(handle: AnchorHandle): Promise<AnchorState>
}
```

| 백엔드 | 네트워크 | 비용 | 키 | 비트코인 보유 | 확정 시간 | 공개 검증 |
|---|---|---|---|---|---|---|
| `RegtestBackend` | regtest (자체) | **0원** | 무가치 키 | ❌ | **즉시** | ❌ |
| `MainnetBackend` | mainnet | 수수료 | **핫월렛** | ✅ | 10분~ | ✅ |

### 단계별 적용

| 단계 | T0 Demo | T1 Free Anchor | T2 Sandbox | T3 Live |
|---|---|---|---|---|
| **개발 기간** | `Regtest` | `Regtest` | `Regtest` | — |
| **P0·P1 공개 시점** | **E6 결정** | **E6 결정** | `Regtest` | — |
| **P2** | ↑ 유지 | ↑ 유지 | `Regtest` | — |
| **P3 · 구독 확보 후** | ↑ 유지 | ↑ 유지 | `Regtest` | `Mainnet` |

**이 표가 `AnchorBackend` 추상화의 존재 이유입니다.** 어느 칸을 바꾸더라도
교체되는 것은 구현체 1개이며, `api/` · `worker/batcher` · `rules/` · 번들 조립 ·
검증 SDK는 **전혀 수정되지 않습니다.** 전환은 환경변수 1개입니다.

```
ANCHOR_BACKEND=regtest | ots | mainnet
```

### 메인넷 전환 체크리스트 (구독 의사 확인 시)

| # | 항목 | 메인넷 앵커 **1건** (수동) | 메인넷 앵커링 **서비스** (P3) |
|---|---|---|---|
| 1 | 환경변수 교체 | ✅ 끝 | ✅ |
| 2 | 핫월렛 생성·자금 투입 | 불필요 | **필요** |
| 3 | 수수료 정책 (배치 주기·RBF) | 불필요 | **필요** |
| 4 | reorg 대응 운영 절차 | 불필요 | **필요** |
| 5 | 키 보관 (KMS/HSM) | 불필요 | **필요** |
| 6 | 비트코인 노드 운영 | 불필요 | **필요** |
| 7 | 홈페이지 카피 상향 | **가능** | 가능 |

> **수동 1건은 1·7번만 해당합니다.** 키가 서비스에 들어가지 않고, 수수료 1건으로 끝나며,
> 산출물은 영구 재사용되는 fixture JSON 1개입니다.

## D5. 데이터 흐름

```
원본 문서 ──(브라우저 SHA-256, 원본 미전송)──▶ 해시 32B
    │
    ├─ 발행자 서명 (P-256, WebCrypto)
    ▼
[Attest Core] attestation 생성 ──▶ 배치 집계 ──▶ Merkle Root (RFC 6962 변형)
                                                      │
                                                      │
                                                      ▼
                                       AnchorBackend.submit()
                                       BC01 OP_RETURN (약 200 vB)
                                       regtest (전 구간) / mainnet (P3)
                                                      │
                                                      ▼
                                          확정 감시 · 상태 전이
                                                      ▼
                                   Proof Bundle (JSON 1 파일) + Evidence ZIP
                                                      ▼
                        독립 검증 — bitcert-verifier / attest-verify SDK / ots verify
                              (StoneHash 서버를 호출하지 않음)
```

**상태는 절대 하나로 합치지 않습니다:**
`Accepted → Signed → Batched → Submitted → Confirmed → Independently Verified`

## D6. 티어별 검증 가능 범위 ★ 가장 중요한 표

과장 방지의 핵심입니다. regtest 결정의 영향이 여기에 정확히 드러납니다.

#### 개발 기간 (전 구간 regtest)

| 검증 단계 | T0 | T1 | T2 | 비고 |
|---|---|---|---|---|
| **Link A** 원본 → leaf (SHA-256) | ✅ | ✅ | ✅ | 순수 수학 · 오프라인 재현 |
| **Link B** Merkle 포함증명 | ✅ | ✅ | ✅ | 순수 수학 · 오프라인 재현 |
| **Link C-1** txid 오프라인 바인딩 | ✅ | ✅ | ✅ | 순수 수학 · 오프라인 재현 |
| **Link C-2** 공개 체인 포함 확인 | ❌ | ❌ | ❌ | **전부 비공개 체인** |

→ **4단계 중 3단계는 완전히 독립 검증 가능합니다.** Link C-2만 비공개입니다.
→ 이 상태에서는 "독립 검증 가능"이 아니라 **"검증 절차를 재현 가능"** 까지만 주장합니다.

#### E6-ⓐ — 홈 §2용 메인넷 앵커 1건을 포함한 경우 (권고)

| 검증 단계 | T0 | T1 | T2 | T3 (P3) |
|---|---|---|---|---|
| **Link A / B / C-1** | ✅ | ✅ | ✅ | ✅ |
| **Link C-2** 공개 체인 확인 | ✅ **제3자 가능** | ❌ | ❌ | ✅ |
| 네트워크 | **mainnet** (고정 fixture) | regtest | regtest | mainnet |
| 가입 | 불필요 | 불필요 | 필수 | 계약 |

→ **"공개 검증 가능" 주장은 T0의 메인넷 앵커 1건이 지탱합니다.**
→ T1·T2는 **자체 파이프라인 전 구간을 즉시 체험**하는 역할이며, 공개 검증은 주장하지 않습니다.

**정직성은 와이어 포맷이 자동으로 보장합니다.** `bundle-schema.md`가 `bitcoin_network`를
필수 필드로 요구하므로, regtest 번들은 스스로 `"regtest"`라고 말하고 **어떤 제3자 검증기든 그것을 보고합니다.**
라벨을 숨기는 것이 구조적으로 불가능합니다.

regtest를 쓰는 모든 화면에 고정 배너를 둡니다 —
`Regtest — 비공개 테스트 체인. 공개 검증 불가` (§10 CI 가드레일이 이 배너 누락을 빌드 실패로 처리)

### regtest가 Sandbox에 주는 고유 기능

| 기능 | signet·mainnet으로 가능? |
|---|---|
| `Instant confirm` — 즉시 블록 생성, 첫 호출이 1초 안에 확정 | ❌ |
| `Simulate reorg` — reorg 처리 코드를 고객이 직접 테스트 | ❌ |
| `Fast-forward N blocks` — 확정 수 조건 테스트 | ❌ |
| faucet 불필요 | ❌ |

경쟁사 샌드박스에 없는 기능입니다. 연동 평가라는 Sandbox의 **실제 목적**에는 더 적합합니다.

## D7. 저장소 · 배포 맵

| 저장소 | 상태 | 배포 대상 |
|---|---|---|
| `stonehash-org/homepage` | **기존 · 개편** | `stonehash.com` (PM2, 현행 유지) |
| `stonehash-org/attest-web` | 신규 · pnpm workspace | — |
| └ `packages/attest-verify` | 신규 | npm 공개 (무의존성 TS 검증 SDK) |
| └ `apps/playground` | 신규 | `playground.stonehash.com` (정적) |
| └ `apps/docs` | 신규 | `docs.stonehash.com` (정적) |
| └ `apps/console` | 신규 | `app-sandbox` / `app` (동일 코드) |
| └ `fixtures/` `policies/` | 신규 | 실제 앵커 1건 + 은행 5케이스 + 정책 |
| `stonehash-org/attest-core` | 신규 | `api-sandbox` / `api` (동일 코드, env 분기) |
| `BetweenBits-org/bitcert-verifier` | **기존 · 채택** | `verify.stonehash.com` |
| `BetweenBits-org/bitcert-attest-module` | **기존 · 참고만** | 수정하지 않음 |

**배포 게이트:** `attest-verify`의 적합성 테스트 8케이스
(정상 5 통과 + **변조 3 실패**)가 깨지면 전체 배포 차단.

## D8. 만들지 않는 것 (명시적 제외)

NATS · Kong · Helm/K8s · Stripe Meters · `manifest.yaml` 모듈 계약 · zk-por ·
exchange-por · OP_RETURN v30 인코더(특허) · 메인넷 핫월렛(P3까지) ·
자체 블록 탐색기(regtest TX는 Console에서 자체 노드 데이터로 렌더) ·
실제 은행/지급기관 API · AML 판단 · 공인 CA/TSA 연계 · Settle/Mint 개편

---

## E. 검토 체크리스트 — 승인 필요 항목

| # | 항목 | 승인 |
|---|---|---|
| E1 | **A1~A10 전제가 정확한가** (틀리면 아래 전부 재검토) | ☐ |
| E1′ | **톤앤매너 100% 유지 · 신규 비주얼 컴포넌트 0개** (C0) | ☐ |
| E2 | 홈 8개 섹션 구성, 특히 **§2 Live Proof Strip**(첫 화면에 실제 TXID 노출) | ☐ |
| E3 | **§5 "무엇을 증명하지 못하는가"를 홈에 두는 것** | ☐ |
| E4 | 기존 고객사 로고 월 · about 카운터 **제거** | ☐ |
| E5 | Settle·Mint를 `/legacy`로 이동 | ☐ |
| **E6** ★ | **홈 §2 Live Proof Strip용 메인넷 앵커 1건**<br>ⓐ **포함 (권고)** — 수동 1회 · 수수료 1건 · 핫월렛 불필요 · 키가 서비스에 안 들어감 · "독립 검증 가능" 카피 사용 가능<br>ⓑ **미포함** — 전 구간 regtest · 카피 전면 하향 · 공개 검증 가능한 증거 0건 | ⓐ ☐&nbsp;&nbsp;ⓑ ☐ |
| E7 | Sandbox **셀프서브 즉시 가입** (영업 승인 게이트 없음) | ☐ |
| E8 | `@stonehash/attest-verify` **npm·GitHub 공개** 승인 | ☐ |
| E9 | 호스트 신설: `playground` `app-sandbox` `app` `docs` `verify` `api-sandbox` `api` | ☐ |
| E10 | **D6 검증 범위 표를 대외 문서에 그대로 공개**하는 것 | ☐ |

### 착수 전 확인이 필요한 사실

| # | 항목 | 담당 |
|---|---|---|
| F1 | **기존 SaaS에 메인넷 앵커 실적이 있는가?** 있으면 번들 내보내기만으로 E6-ⓐ 달성 (**비용 0원**). 없으면 수동 1회 앵커링 (수수료 1건) | 개발책임자 |
| F2 | 기존 SaaS `verification`의 번들 내보내기를 지금 실행 가능한가 (DB·bitcoind 기동) | 개발책임자 |
| F3 | OP_RETURN v30 특허 범위가 **디코더 공개**까지 제한하는가 | 법무 |
| F4 | 홈페이지 포트 3010이 widget 서비스와 충돌 — 호스트 분리 시 정리 | 인프라 |

---

## 다음 단계 (승인 후)

| 순서 | 작업 | 산출물 |
|---|---|---|
| 1 | F1·F2 검증 (1~2일) | 실제 앵커 번들 1건 확보 여부 확정 |
| 2 | `attest-verify` 스캐폴딩 + **적합성 테스트 8케이스 먼저 green** | 드리프트 방지선 |
| 3 | 홈페이지 IA·Hero·Live Proof Strip | 브랜드 전환 가시화 |
| 4 | Playground T0 (Verify → Explore) | P0 데모 |
| 5 | `AnchorBackend` 인터페이스 확립 + `RegtestBackend` + T1 무가입 앵커링 | 아키텍처 강제 |
| 6 | 은행 규칙 엔진 → Bank Review UI → 내보내기 | P1 |
| 7 | Attest Core + T2 Sandbox (regtest) | P2 |

**2번을 첫 코드 작업으로 두는 이유:** 적합성 테스트가 먼저 서 있어야
이후 모든 UI가 "진짜 엔진 위에서" 돌아간다는 것이 자동으로 보장됩니다.
