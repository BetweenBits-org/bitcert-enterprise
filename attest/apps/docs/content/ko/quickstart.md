# 빠른 시작

첫 기록을 앵커링하고 직접 검증해 보십시오. 첫 단계에는 계정이 필요 없고,
문서는 기기를 떠나지 않습니다.

아래 명령은 이 배포의 주소를 `$BASE` 로 적습니다 — 지금 이 페이지를 보고 있는
오리진이며, 미리 채워 두었습니다:

```bash
BASE={{ORIGIN}}
```

## 0. 먼저, 어떤 배포에 연결됐는지 확인

다른 무엇보다 먼저 읽으십시오. 이 배포가 어느 비트코인 네트워크에 앵커링하는지,
그리고 여기서 무엇이 증명되고 무엇이 증명되지 않는지를 말로 알려 줍니다.

```bash
curl -s $BASE/v1/meta
```

```jsonc
{
  "service": "stonehash-attest-core",
  "bitcoin_network": "regtest",
  "bundle_schema": "bitcert-proof-bundle/v1",
  "free_tier": { "endpoint": "/v1/public/anchors", "signup_required": false },
  "key_prefix": "sk_test_",
  "public_verifiability": "anchors are on a private regtest chain: links A, B and C1 verify offline, but public-chain inclusion (C2) cannot be confirmed by a third party"
}
```

`bitcoin_network` 은 모든 증명 파일에 **그대로** 기록됩니다. 따라서 regtest
증명을 mainnet 증명인 것처럼 내보일 수 없습니다 — 규격을 따르는 모든 검증기가
이 필드를 읽고 그대로 보고합니다.

## 1. 문서를 해시합니다

로컬에서. **파일은 업로드되지 않습니다.** 어디론가 보내는 단계가 아예 없으므로,
나중에 저희가 내놓을 수 있는 것도 없습니다.

```bash
sha256sum contract.pdf | cut -d' ' -f1
# 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```

```bash
# macOS
shasum -a 256 contract.pdf | cut -d' ' -f1
```

## 2. 앵커링 — 계정 없이

```bash
curl -s -X POST $BASE/v1/public/anchors \
  -H 'content-type: application/json' \
  -d '{"sha256":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"}'
```

```jsonc
{
  "id": "4f1e…",
  "sha256": "9f86d081…",
  "status": "accepted",
  "bundle_available": false,
  "bundle_url": null,
  "retrievable_until": "2026-12-05T00:00:00Z",
  "bitcoin_network": "regtest",
  "note": "accepted; it joins the next shared batch rather than its own transaction"
}
```

해시는 다음 공유 배치에 들어갑니다. 이는 무료 구간의 제약이 아니라 배치의
경제성입니다 — 호출자 한 명이 요청만으로 저희에게 트랜잭션 수수료를 쓰게 만들 수는
없습니다.

같은 해시를 두 번 보내면 오류가 아니라 **200** 과 함께 기존 기록이 돌아옵니다.

## 3. 체인에 닿는 과정 보기

```bash
ID=<2단계 응답의 "id">
curl -s $BASE/v1/public/anchors/$ID
```

`status` 는 `accepted → batched → submitted → confirmed` 순으로 움직입니다.
**실제로 도달한 단계**로 보고되며 참·거짓 하나로 합쳐지지 않습니다 — 플래그
하나였다면 어느 단계가 빠졌는지 가려졌을 것입니다.

## 4. 증명 파일을 받아 가기

3단계에서 `bundle_available: true` 가 보인 뒤에 실행하십시오 — 그 전에는 이 경로가
`409 not_batched` 를 돌려주며, `-f` 가 있어야 curl이 오류를 파일로 저장하는 대신 그
사실을 알립니다:

```bash
curl -sf -OJ $BASE/v1/public/anchors/$ID/bundle
```

이것이 이 과정 전체의 목적입니다. 증명 파일은 그 자체로 완결됩니다. 이 파일과
비트코인을 들여다볼 수 있는 아무 수단만 있으면, 누구든 **StoneHash에 연락하지
않고** 기록을 확인할 수 있습니다. 이곳의 기록은 `/v1/meta` 의 보존 기간이 지나면
사라지지만, 방금 내려받은 파일은 그렇지 않습니다.

## 5. 저희 없이 검증하기

검증기는 아직 npm에 없습니다. [TypeScript SDK](#sdk) 페이지의 tarball 어느 것에서든
가져가십시오 — 의존성도, 빌드 단계도 없습니다 — 그리고 압축을 푼 디렉터리에서
경로로 import 하십시오. Node 22.18 이상이면 `.ts` 소스를 그대로 실행합니다(그보다
낮은 22.x는 `--experimental-strip-types` 를 붙이십시오):

```bash
curl -O $BASE/docs/download/attest-sign.tar.gz
curl -O $BASE/docs/download/attest-sign.sha256
sha256sum -c attest-sign.sha256 && tar xzf attest-sign.tar.gz
```

아래를 압축 푼 `packages/` 옆에 `verify.ts` 로 저장하고 `node verify.ts` 로
실행하십시오:

```ts
import { readFileSync } from 'node:fs';
import { verifyBundle } from './packages/attest-verify/src/index.ts';   // npm에 올라가면 '@stonehash/attest-verify'

const proof = JSON.parse(readFileSync('proof-4f1e.json', 'utf8'));
const report = verifyBundle(proof, { originalBytes: readFileSync('contract.pdf') });

console.log(report.links);
// { A: 'pass', B: 'pass', C1: 'pass', C2: 'skip' }
```

런타임 의존성이 0이고, 같은 모듈이 브라우저에서도 그대로 돕니다. 전체 API는
[TypeScript SDK](#sdk) 를 보십시오.

### 네 가지 검사, 그리고 왜 늘 따로 보고하는가

```
 원본 ──(문서 일치)──▶ 해시 ──(묶음 포함)──▶ 묶음 루트 ──(트랜잭션 결합)──▶ 비트코인
```

보고서는 이를 `A`, `B`, `C1`, `C2` 로 부릅니다:

| `links` | 질문 | 필요한 것 |
|------|------|-----------|
| **A** — 문서 일치 | 이 해시가 *귀사의* 문서인가? | 원본 파일 |
| **B** — 묶음 포함 | 그 해시가 이 묶음 루트 안에 있는가? | 증명 파일만으로 |
| **C1** — 트랜잭션 결합 | 앵커 바이트가 이 txid에 속하는가? | 증명 파일만으로 |
| **C2** — 체인 포함 | 그 txid가 공개 블록에 있는가? | **귀사가 고른** 비트코인 조회처 |

앞의 셋은 순수 산술이라 네트워크 없이, StoneHash를 신뢰하지 않고도 오프라인에서
증명됩니다. 체인 포함은 유일하게 체인에 의존하는 단계이고, 검증기는 이를 **대신 해
주지 않습니다**. 직접 노드나 탐색기에 물어 그 결과를 합치는 것입니다.

그 전까지 **`C2` 는 `skip` 으로 표시되며, 이는 "확인되지 않음"이지 "문제 없음"이
아닙니다.**

이 배포의 비공개 regtest 체인에서는 블록을 저희가 채굴하므로 체인 포함을 저희 외에는
아무도 확인할 수 없습니다. regtest 증명은 파이프라인 전 구간을 그대로 재현하지만
**공개적으로 검증 가능한 증명은 아닙니다.**

## 6. 한도를 올리기 — 샌드박스 계정

무료 구간은 주소당 상한이 있습니다. 샌드박스 계정은 그 상한을 올려 주며,
셀프서브입니다. 승인 대기도, 영업 통화도 없습니다.

**브라우저에서** [샌드박스 콘솔](../console/)을 열고 가입하십시오. 한 화면 뒤면 API
키와 월 1,000건의 한도, 그리고 앵커링 기록에 이미 들어 있는 한 건을 갖게 됩니다 —
첫 증명 내보내기에 내보낼 것이 있도록.

**터미널에서**, 계정을 아예 두고 싶지 않으시다면:

```bash
curl -s -X POST $BASE/v1/sandbox/keys \
  -H 'content-type: application/json' \
  -d '{"slug":"acme","name":"Acme Corp","label":"ci"}'
```

```jsonc
{
  "org": { "id": "…", "slug": "acme" },
  "api_key": "sk_test_…",
  "note": "Store this now — it is not recoverable. Sandbox anchors land on a private regtest chain."
}
```

키는 한 번만 표시되고, 저장되는 것은 해시뿐입니다. `sk_test_` / `sk_live_`
접두사가 키의 일부이므로, 로그나 설정 파일에서 샌드박스 키를 운영 키로 착각할 수
없습니다.

그다음에는 목록 조회·자체 디스크립터·조직 격리가 더해진 키 기반 API를 쓰십시오:

```bash
KEY=<응답의 api_key>
curl -s -X POST $BASE/v1/attestations \
  -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"leaf_bytes":"9f86d081…","content_type":"application/pdf","descriptor":{"ref":"invoice-2026-0041"}}'
```

모든 엔드포인트와 오류 형태, 그리고 실패했을 때 각각이 무엇을 하는지는
[API 레퍼런스](#api) 에 있습니다.

## 이 배포가 하지 않는 것

샌드박스와 운영은 **같은 코드**로 돕니다. 차이는 어느 데이터베이스 파일을 열고, 어느
앵커 백엔드를 구성하며, 어떤 키 접두사로 인증하는지뿐입니다. 환경에 따라 분기하는
코드는 없습니다 — 다른 코드로 도는 샌드박스는 운영에 대해 아무것도 말해 주지
않으니까요.

mainnet으로 옮기는 것은 자금이 있는 노드를 가리키는 백엔드 설정 변경입니다. 배치,
증명 생성, 검증은 손대지 않습니다.
