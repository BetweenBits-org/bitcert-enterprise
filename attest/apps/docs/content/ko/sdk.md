# TypeScript SDK

**아직 npm에 올라가 있지 않습니다.** `npm i @stonehash/attest-verify` 는 실패하므로
안내하지 않습니다 — 404 나는 패키지명은 없느니만 못합니다.

대신 다운로드에서 가져가십시오 — 연동별 tarball 세 개가 각각 체크섬과
함께 제공되고, 필요한 의존성은 같은 제로 의존성 소스로 동봉됩니다:

| Tarball | 대상 | 포함 |
|---|---|---|
| `download/attest-sign.tar.gz` | 서명 앵커 | attest-sign + attest-verify |
| `download/attest-remit.tar.gz` | 은행(국경간 송금) | attest-remit(SDK, SWIFT 표본 전문) + attest-rules + attest-verify |
| `download/attest-remit-java.tar.gz` | 은행(국경간 송금, Java) | Java SDK의 jar · 소스 jar · pom, 소스와 시험 벡터, 예제(Spring 포함), SWIFT 표본 전문 |
| `download/attest-por.tar.gz` | 거래소(PoR) | attest-por(SDK, 예시 잔고 파일) + attest-rules + attest-verify |

아래의 `$BASE` 는 이 배포의 주소입니다 — 지금 이 페이지를 보고 있는 오리진이며,
미리 채워 두었습니다:

```bash
BASE={{ORIGIN}}
curl -O $BASE/docs/download/attest-sign.tar.gz
curl -O $BASE/docs/download/attest-sign.sha256
sha256sum -c attest-sign.sha256 && tar xzf attest-sign.tar.gz
ls packages/attest-sign/src
```

런타임 의존성이 0이고 빌드 단계도 없습니다. Node 22.18 이상은 `.ts` 소스를 그대로
실행하고(그보다 낮은 22.x는 `--experimental-strip-types` 를 붙이십시오), 한 번
컴파일하면 브라우저에서도 돕니다 — 플레이그라운드가 이것을 직접 가져다 쓰므로,
방문자가 돌아가는 모습을 보는 코드가 곧 여기서 가져갈 코드입니다. 압축을 푼
디렉터리에서 경로로 import 하십시오. 아래의 `@stonehash/…` 이름은 패키지가 npm에
올라간 뒤의 import 형태입니다.

## 왜 이쪽 절반만 공개하는가

`@stonehash/attest-verify` 는 **검증기**이고, [증빙 규격](#spec)의 **두 번째 독립
구현체**로 일부러 그렇게 만들었습니다 — 생산자와 공유하는 라이브러리가 아닙니다.
같은 코드가 증명을 만들고 또 검사한다면 버그가 서로 상쇄되어 "독립적으로 검증
가능"이라는 말은 아무 뜻도 없게 됩니다. 공개된 규격을 보고 따로 작성된 두 구현이
실제 바이트에서 일치하는 것이 증거입니다. 한 구현이 자기 자신과 일치하는 것은
증거가 아닙니다.

`apps/core` 는 이 패키지를 devDependency로만 참조합니다. 따라서 배포되는 코드가
검증기를 import 할 수 없습니다.

앵커링 엔진은 공개하지 않습니다. 이는 특허 입장이지 투명성의 공백이 아닙니다 —
증명을 *검증*하는 데 필요한 모든 것이 여기 있고, 감사 가능해야 하는 쪽은 그
절반입니다.

## 증명 파일 검증

```ts
import { readFileSync } from 'node:fs';
import { verifyBundle } from './packages/attest-verify/src/index.ts';   // npm에 올라가면 '@stonehash/attest-verify'

const proof = JSON.parse(readFileSync('proof.json', 'utf8'));
const report = verifyBundle(proof, { originalBytes: readFileSync('contract.pdf') });

report.verified   // 차단 검사들의 논리곱
report.links      // { A, B, C1, C2 } — 문서 일치 · 묶음 포함 · 트랜잭션 결합 · 체인 포함, 각각 따로 보고
report.checks     // 순서가 있는 상세 내역, 화면 표시용
```

`originalBytes` 를 빼면 `A`(문서 일치)는 실패가 아니라 `skip` 으로 보고됩니다. 원본이
없으면 해시할 것이 없고, 그때는 "확인되지 않음"이 정직한 답입니다.

### `links` 읽는 법

| 값 | 뜻 |
|----|-----|
| `pass` | 산술이 성립한다 |
| `fail` | 산술이 성립하지 않는다 — 이 증명 파일은 자기가 주장하는 바를 말하지 못한다 |
| `skip` | **확인하지 않았다.** "문제 없음"이 아니다 |

`verifyBundle` 은 체인 포함(`C2`)을 절대 수행하지 않습니다. 할 수도 없습니다. 그것은
"이 txid가 공개 블록에 있다"는 뜻이고, 그것을 *귀사가* 고른 비트코인 조회처 — 직접
돌리는 `bitcoind`, 공개 탐색기, 자체 호스팅한 것 — 를 통해 확인한다는 것이 설계의
핵심입니다. 검증기가 블록을 대신 가져온다면 이 설계가 제거한 신뢰받는 제3자를 그대로
되살리는 셈입니다.

그래서 `C2` 는 `skip` 으로 도착하고, 귀사의 확인 결과를 거기에 합치는 것입니다.

## 브라우저에서

```html
<script type="module">
  import { verifyBundle } from './vendor/attest-verify/index.js';

  const report = verifyBundle(bundle, { originalBytes: new Uint8Array(buf) });
</script>
```

번들러가 필요 없습니다. 이 패키지는 의존성이 없고 명시적 경로로 형제 모듈만
import 하며, `test/portability.test.ts` 가 이를 강제합니다 — `src/` 안에 `node:`
import, `require`, `process`, `Buffer` 가 없음을 단언하므로 브라우저 빌드가 소리 없이
썩을 수 없습니다.

## 직접 검증기를 쓰신다면, 기본 요소들

증명 파일을 검사하는 데 이것들이 필요하지는 않습니다. 그리고 규격을 독립적으로 구현하는
것이 목표라면 **쓰지 마십시오** — 직접 작성하셔야 합니다. 부분적으로 다시 계산해
보는 것이 감사자가 실제로 원하는 경우가 많아서 내보내 둔 것입니다.

| 내보내는 것 | 쓰임 |
|-------------|------|
| `sha256`, `sha256d` | 해시, 그리고 비트코인의 이중 SHA-256 |
| `jcs`, `jcsString` | RFC 8785 정규 JSON — 기록이 바이트가 되는 방식 |
| `leafHash`, `nodeHash`, `verifyInclusion` | RFC 6962 Merkle 구성 (`B`, 묶음 포함) |
| `parseEnvelope`, `extractWitnessItems` | 트랜잭션 파싱 — 트랜잭션에 실린 데이터 포함 |
| `verifyPreimage` | `A`(문서 일치) 단독 |
| `verifyChainLinks`, `payloadHash` | 거래소별 체인 거슬러 올라가기 |
| `dayRoot`, `assetsHash`, `deriveUserCommitment`, `reconCommitment` | 일일 정산 커밋먼트 |
| `SUPPORTED_SCHEMAS` | 이 빌드가 받아들이는 증명 파일 스키마 버전 |

`sha256` 은 NIST 벡터, 규격의 고정 벡터, 그리고 `node:crypto` 와의 차등 비교로
검증합니다 — 검증 라이브러리 안의 손으로 쓴 해시는 그 정도로 못 박아 두어야만
신뢰할 수 있습니다.

## 적합성

직접 만든 구현을 신뢰하기 전에, 그리고 저희 것을 누구에게 신뢰해 달라 하기 전에,
공개된 벡터로 돌려 보십시오. **다섯 개는 반드시 통과하고 변조된 세 개는 반드시
실패해야** 합니다. 여덟 개를 전부 통과하는 검증기는 더 위험한 방향으로 고장 난
것입니다.

픽스처와 각각이 무엇을 시험하는지는 [테스트 벡터](#vectors) 를 보십시오.

## 은행 SDK, 호출별로

`download/attest-remit.tar.gz`는 [국경간 송금](#corridor)의 은행 쪽 절반입니다.
모든 것은 `packages/attest-remit/src/index.ts`에서 내보냅니다:

| 호출 | 하는 일 |
|---|---|
| `new RemitClient({ core, apiKey, institutionId, institutionName, key })` | 프로세스 안의 키로 서명하는 클라이언트 — HSM·KMS라면 `key` 대신 `signer`를 넘깁니다 |
| `new RemitClient({ core, apiKey, institutionId, institutionName, readOnly: true })` | 서명키 없이 읽기만 하는 클라이언트 — 상태, 상태 보고, 원장, 증빙. 서명하거나 보내는 호출은 거절합니다 |
| `client.assertRegistered()` | 이 키가 Trust Registry에 등록된 기관 키와 같은지 확인 |
| `client.quote(amount)` | USD 무역금액에 대한 견적 |
| `client.buildInstructionAsync(quote, parties, options)` | 서명된 지급지시. `buildInstruction()`은 프로세스 안의 키를 위한 동기 형태 |
| `client.submit(body)` · `client.status(id)` · `client.track(id)` | 보내고, 읽고, 끝까지 따라가기 |
| `client.submitSwift(message, options)` | MT103·pacs.008·pain.001에서 시작하는 전 과정 — 판독, 변환, 견적, 서명, 제출 |
| `client.inspectSwift(message)` · `client.instructionFromSwift(message)` | 변환 내역만, 그리고 보내지 않은 서명된 지급지시 |
| `client.swiftStatus(id)` · `client.statusReport(id)` | 상태를 ISO 20022 상태코드로, `pacs.002` 보고로 |
| `client.answerRfi(id, answers)` · `client.cancel(id, reason)` | 은행만이 내릴 수 있는 두 가지 결정 |
| `client.submitDailyManifest(date, ids)` | 하루치 지급지시 목록을 서명해 제출 |
| `client.evidence(id)` · `verifyEvidencePackage(evidence)` | 증빙 패키지와 네 가지 독립 재검증 |
| `client.verifyWebhook(body)` | Webhook 전달의 서명 검증 |
| `parseSwiftMessages(message)` · `mapSwiftPayment(payment)` | 클라이언트 없이 쓰는 전문 판독과 변환 |
| `swiftStatusOf(view)` · `buildPacs002(view)` | 클라이언트 없이 송금 조회 결과에서 상태를 만들기 |
| `commandSigner({ publicKey, command })` | 명령을 실행하는 서명기 — OpenSSL, PKCS#11 도구, KMS 래퍼 |
