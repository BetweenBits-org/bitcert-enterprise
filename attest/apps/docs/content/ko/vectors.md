# 공개 테스트 벡터

적합성 증명 파일 여덟 개. **다섯 개는 반드시 검증되고 세 개는 반드시 실패해야 합니다.**
여덟 개를 모두 통과하는 검증기는 너그러운 것이 아니라, 중요한 방향으로 고장 난
것입니다 — 변조된 기록을 받아들인다는 뜻이니까요.

이것들은 생산자 쪽이 직접 공개한 픽스처이고,
`attest-verify/test/conformance.test.ts` 가 빌드마다 전부 돌립니다. 생산자든
검증기든 한쪽이 어긋나면 빌드가 빨갛게 됩니다. 이 페이지가 현재 동작을 설명한다고
믿을 수 있는 유일한 근거가 그것입니다.

각 디렉터리에는 `bundle.json`, 판정을 적은 `expected.txt`, 그 사례가 무엇을
시험하는지 설명하는 `README.md`, 그리고 사례에 필요한 원본 산출물이 들어 있습니다.

## 반드시 검증되어야 하는 것

| # | 사례 | 시험하는 것 |
|---|------|-------------|
| **01** | 파일 산출물에 대한 증명 | `sha256-file` 로서의 문서 일치(`A`): 검증기가 귀사가 준 파일을 해시해 앵커된 리프와 같은지 확인합니다. 가장 단순한 전 구간 사례입니다. |
| **02** | 솔트 커밋먼트로 만든 일일 잔액 | `sha256-jcs-fields` 로서의 문서 일치(`A`). 리프는 `{asset, balance_minor, user_commitment}` 에 커밋하며, `user_commitment = SHA-256(salt ‖ account_id)` 입니다. **솔트는 고객의 비밀이며 증명 파일에 일부러 넣지 않습니다** — 공개하면 누구나 계정을 역추적할 수 있기 때문입니다. 비밀 없이도 자기 일관성은 검증되고, 특정 계정에 묶는 데에만 비밀이 필요합니다. |
| **05** | 일일 체인 거슬러 올라가기 | 거래소별 이틀치 체인. 이전 항목마다 자기 `payload_hash` 를 다시 계산해 맞아야 하고, 오늘의 `prev_entry_hash` 는 어제 것과 같아야 합니다 — 체인을 단순한 나열이 아니라 변조가 드러나는 구조로 만드는 해시 연결입니다. |
| **06** | 일일 `day_root` (스키마 v2) | 앵커가 맨 잔액 루트가 아니라 `day_root` 에 커밋합니다. 따라서 정산 자체가 앵커 옆에 주장되는 것이 아니라 앵커됩니다. |
| **07** | 원본 문서를 앵커 트랜잭션에 함께 실은 경우 | 트랜잭션 하나가 묶음 루트를 앵커하고(`output[0]` 이 `BC30(merkle_root)` 앵커) 감사용 PDF 자체를 BIP-342 tapscript 봉투(`witness[1]`)에 담습니다. |

## 반드시 실패해야 하는 것 — 그리고 올바른 검사에서 실패해야

실제로 일을 하는 쪽은 이 절반입니다. 세 사례 모두 앵커는 진짜이고 대부분의 검사도
여전히 통과합니다. 정확히 하나만 깨집니다. 뭉뚱그려 실패를 보고하는 검증기는 통과시키는
것과 거의 같은 정도로 쓸모가 없습니다 — 검토자가 *무엇이* 잘못됐는지 알 수 없으니까요.

| # | 사례 | 여전히 통과 | 실패 |
|---|------|-------------|------|
| **03** | 변조된 원본 | `B`, `C` — 앵커는 진짜 | **`A`, 문서 일치.** 문서가 더 이상 앵커된 리프로 해시되지 않습니다. 증명 파일은 진본이고, 파일이 그 증명이 가리키는 그 파일이 아닙니다. |
| **04** | 변조된 거래소별 체인 | `A`, `B`, `C` — 그날의 루트는 실제로 앵커됨 | **체인 단계.** 위조된 `payload_hash` 가 자기 역상에서 다시 계산되지 않습니다. |
| **08** | 함께 실린 문서가 변조된 경우 | txid 결합과 기록-루트 결합 | **실린 문서 단계.** 실린 PDF의 비트 하나가 뒤집혔습니다. 실린 바이트는 txid에 커밋되지 않으므로 txid와 앵커 출력은 그대로이고, 복원한 본문만 `record.leaf_bytes` 로 해시되지 않습니다. |

08번이 미묘한 사례이고, 이 모음이 이런 모양인 이유입니다. 네 검사 중 셋이 통과하고,
체인 위의 트랜잭션은 손대지 않았으며, 변조를 드러내는 것은 본문 해시를 다시 계산하는
것뿐입니다. txid만 믿는 검증기는 이것을 깨끗하다고 말할 것입니다.

## 돌려 보기

픽스처 파일은 아직 이 허브에서 내려받을 수 없습니다. 비공개인 저장소와 함께 배포되며,
요청하시면 제공합니다. 작업 사본에서:

```bash
cd attest && pnpm install
pnpm --filter @stonehash/attest-verify test
```

직접 만든 구현에 대해서는, 계약이란 디렉터리 배치뿐입니다:

```ts
import { readFileSync } from 'node:fs';
import { verifyBundle } from '@stonehash/attest-verify';

for (const dir of ['01-attestation-file', '03-tampered-original']) {
  const bundle = JSON.parse(readFileSync(`fixtures/conformance/${dir}/bundle.json`, 'utf8'));
  const expected = readFileSync(`fixtures/conformance/${dir}/expected.txt`, 'utf8');
  const report = verifyBundle(bundle, { originalBytes: /* 사례의 산출물 */ undefined });

  // expected.txt 는 "VERIFIED (exit 0)" 또는 "FAILED (exit 1)" 로 시작합니다
  console.log(dir, report.verified, expected.split('\n')[0]);
}
```

## 이 벡터들이 만들어진 네트워크에 대하여

이 픽스처들의 앵커는 비공개 regtest 체인 위에 있습니다. 수학적 검사 — 문서 일치,
묶음 포함, 트랜잭션 결합 — 는 거기서 mainnet과 똑같이 검증됩니다. 산술이고, 어느
체인인지는 무관하기 때문입니다.

**regtest에서 체인 포함 여부는 저희 외에 아무도 확인할 수 없습니다. 블록을 저희가
채굴하기 때문입니다.** 따라서 이 벡터들은 검증 로직을 완전히 시험하지만 공개적으로
검증 가능한 증명은 *아닙니다*. 모든 증명 파일이 자기 `bitcoin_network` 를 스스로
적으므로, 규격을 따르는 검증기는 귀사가 나중에 알게 두지 않고 이 사실을 보고합니다.

## 은행 증빙 픽스처

정산 규칙 엔진은 자체 픽스처와 정책을 함께 배포하며, `/v1/settlements/*`
엔드포인트와 SDK의 `verifyEvidencePackage()` 가 둘 다 이것을 씁니다 — 양쪽이 같은
엔진이고, 그래서 SDK로 정책을 다시 돌려도 서버와 같은 답이 나옵니다.

| 파일 | 쓰임 |
|------|------|
| `packages/attest-rules/fixtures/a-normal-trade-payment.json` | 정상적인 무역 대금 지급 |
| `packages/attest-rules/policies/settlement-match-v1.json` | 정산 대조 규칙 모음 |
| `packages/attest-rules/fixtures/corridor-vn-sg-normal.json` | VN→SG 코리도 사례 |
| `packages/attest-rules/policies/corridor-vn-sg-v1.json` | 코리도 규칙 모음 |

이 픽스처들은 **실제로 서명되어 있습니다.** 거래 상대방마다 자기 ECDSA P-256
시연용 키가 있고, 서명은 각 증빙 요소의 정규 바이트를 덮으며, 공개키는 패키지와 함께
배포됩니다 — 따라서 금액을 고치면 서명이 깨지고, 검증은 상태 필드가 그렇게 적혀
있어서가 아니라 **암호학적 이유로** 실패합니다. 이 패키지의 테스트는
`tools/sign-fixtures.mjs --check` 를 먼저 돌려, 다시 서명하지 않고 픽스처를 고치면
빌드를 실패시킵니다.

개인키도 `packages/attest-rules/keys/` 에 함께 공개합니다. 의도적입니다 — 누구나 이
서명을 위조할 수 있으므로, 이 중 하나의 서명은 *누군가가* 서명했다는 것만 증명합니다.
신뢰 등급이 `DEMO` 로 고정되어 있어 어떤 정책이 요구할 수 있는 수준보다 낮고, 그래서
모든 서명이 검증되더라도 발행 기관 축은 `UNKNOWN_ISSUER` 로 보고됩니다.

이 증빙은 전부 **합성 데이터**입니다. `dataMode: "SYNTHETIC"` 을 달고 있으며, 이는
약속이 아니라 강제됩니다. 합성 증빙은 `PRESENT` 나 `VERIFIED_BY_SOURCE` 에 절대
도달할 수 없고, 합성 배너를 빠뜨린 렌더러는 테스트에 실패하며,
`regulatoryDecision` 은 `NOT_EVALUATED` 로 고정됩니다. 실존 금융기관의 데이터, 로고,
인증은 어디에도 나오지 않습니다.
