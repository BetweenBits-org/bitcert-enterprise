# 준비금 증명

사용자가 비트코인으로 직접 검증할 수 있는 부채 커밋을 발행하십시오 —
잔고 원장은 귀사의 기계를 떠나지 않습니다. 거래소가 SDK로 머클 **합**
트리를 로컬에서 만들고, 서명된 선언문(루트·자산별 총액·파라미터)만
제출하면, 플랫폼이 서명을 확인하고 선언문의 커밋이 일반 파이프라인으로
앵커됩니다. 거래소가 요청하면 트리에 대한 무작위 표본 확인(스팟체크)도
받을 수 있습니다.

연동은 귀사 시스템의 소스에서 SDK를 호출하는 것입니다. 원장에서 내보낸
잔고 파일을 SDK에 넘기면 스냅샷이 앵커링되고 **증명 파일 하나**가 남습니다.
보관할 것은 그 증명 파일과 잔고 파일, 두 가지이고 — 두 파일이 있으면
언제든 사용자 증명을 발급합니다.

## 나가는 것과, 절대 나가지 않는 것

기본으로 나가는 것: 선언문과 그 서명 — 루트, 총액, 계정 수이며, 개별
계정에 관한 것은 없습니다. 표본 확인을 요청했을 때에만 나가는 것: 플랫폼이
지정한 리프 8개의 개봉(가명 — 해시된 참조·솔트·잔고와 바로 옆 리프의
잔고, 계정 참조 없음). 절대 나가지 않는 것: 잔고 파일, 리프, 솔트 시드.
이 경계가 제품입니다.

## 트리

모든 노드가 해시와 자산별 합계 벡터를 함께 들고, 해시가 자식의 합계까지
커버합니다 — 32바이트 루트 하나가 리프 집합과 산술 총액에 동시에
커밋됩니다. 부채를 줄여 말하면 각주가 아니라 루트가 깨집니다. 잔고는
최소단위의 음수 불가 정수 문자열이며, 음수는 빌드와 검증 양쪽에서
거부됩니다. 리프와 합계에는 0이 아닌 값만 적습니다 — 거래소마다 다루는
자산이 다르고 수백 종을 상장하기도 하지만, 트리는 계정이 실제로 보유한
만큼만 커지고, 아무도 보유하지 않은 자산은 목록에 넣든 빼든 루트가
같습니다. 빈 자리는 합계가 없는 빈 노드로 채웁니다 — 복제 패딩은 잔고를
이중 계상하기 때문입니다.

```
leaf  = SHA256("STONEHASH-POR-LEAF-V1\n" ‖ salt ‖ user_ref_hash ‖ JCS(balances))
node  = SHA256("STONEHASH-POR-NODE-V1\n" ‖ L.hash ‖ R.hash ‖ JCS(L.sums) ‖ JCS(R.sums))
user_ref_hash = SHA256("STONEHASH-POR-USER-V1\n" + exchange_id + "\n" + user_ref)
commitment    = SHA256("STONEHASH-POR-V1\n" ‖ JCS(statement))
```

규격은 `@stonehash/attest-verify`(`merkle-sum.ts`)가 소유합니다 —
빌더가 검증기의 함수를 import하므로 양측이 어긋날 수 없고, 위 상수만으로
누구든 재구현할 수 있습니다. 선언문의 `tree.algo`가 형식을 밝힙니다:
지금 만드는 스냅샷은 `merkle-sum-sha256-v2`이고, 모든 자산을 0까지 적던
이전 형식 `merkle-sum-sha256-v1`의 스냅샷도 계속 접수·검증됩니다. 두
형식은 같은 식을 쓰며, 무엇을 적느냐만 다릅니다.

## 준비

아래 코드에 넣을 것과 그 출처입니다. API 키와 기관 ID, 서명키는
[콘솔](../console/)에서 나옵니다:

| 필요한 것 (아래 코드에서의 이름) | 어디서 |
|---|---|
| 플랫폼 주소 `STONEHASH_CORE` | 이 배포: `{{ORIGIN}}` |
| API 키 `STONEHASH_API_KEY` | 콘솔 **연동 → API 키** |
| 기관 ID `STONEHASH_INSTITUTION` | 콘솔 **구독** — Proof of Reserves를 활성화하면 표시됩니다 |
| 서명키 `key` | 활성화 때 등록한 공개키의 개인키. 콘솔이 만들어 준 키라면 그때 내려받은 `stonehash-por-signing-key.pem`, 운영에서는 귀사 키 보관 서버의 키 |
| 잔고 파일 | 귀사 원장에서 내보낸 파일 — [잔고 파일 준비](#por-data) |
| SDK | [attest-por.tar.gz](./download/attest-por.tar.gz) · [SHA-256](./download/attest-por.sha256) |

SDK는 패키지 저장소에 올라 있지 않습니다. 압축을 푼 자리의
`packages/attest-por/src/index.ts`를 경로로 import 하며, 설치·빌드 단계와
외부 의존성이 없습니다(Node 22.18 이상). 예시 잔고 파일이
`packages/attest-por/samples/`에 함께 들어 있습니다.

## 스냅샷 앵커링

잔고 파일을 넘깁니다. 파일 검사, 트리 구축, 서명, 제출, 증명 파일 쓰기가
호출 한 번입니다:

```ts
import { readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { PorClient, PorLedgerError, anchorBalanceFile } from './packages/attest-por/src/index.ts';

const client = new PorClient({
  core: process.env.STONEHASH_CORE!,
  apiKey: process.env.STONEHASH_API_KEY!,
  institutionId: process.env.STONEHASH_INSTITUTION!,
  institutionName: '귀사 거래소 이름',
  key: createPrivateKey(readFileSync('stonehash-por-signing-key.pem', 'utf8')),
});
await client.assertRegistered();                   // 등록된 키와 같은 키인가

try {
  // 귀사 원장에서 내보낸 잔고 파일 — 여기서는 SDK에 든 예시
  const anchored = await anchorBalanceFile(client, 'packages/attest-por/samples/balances.wide.csv', {
    assets: [{ symbol: 'BTC', decimals: 8 }, { symbol: 'ETH', decimals: 18 }, { symbol: 'USDT', decimals: 6 }],
    amounts: 'decimal',                            // 파일의 0.5는 0.5 BTC
    asof: '2026-11-18T00:00:00Z',                  // 잔고의 기준 시각
    proofFile: 'por-proof-2026-11-18.json',        // 남는 파일 — 이것 하나
  });
  console.log(anchored.snapshotId, anchored.root, anchored.totals, anchored.publicUrl);
} catch (e) {
  // 파일에 문제가 하나라도 있으면 만들지도, 쓰지도, 보내지도 않습니다
  if (e instanceof PorLedgerError) console.error(e.message, e.report?.problems);
  else throw e;
}
```

예시 경로를 귀사의 잔고 파일로, 자산 목록과 기준 시각을 귀사 값으로 바꾸면
됩니다. 플랫폼으로 가는 것은 선언문(루트·자산별 총액·계정 수)과 그
서명뿐입니다. `anchored.totals`를 귀사 원장의 총액과 대조하십시오 — 이
숫자가 서명되어 공개됩니다.

- **증명 파일이 먼저 쓰입니다.** 제출 전에 `proofFile`을 쓰고, 플랫폼이
  접수하면 스냅샷 ID를 채웁니다. 응답을 받지 못한 채 끊겼다면 같은 호출을
  다시 하십시오 — 같은 선언문을 다시 보내 끝내며, 스냅샷이 둘 생기지
  않습니다(`anchored.already`).
- **증명 파일은 덮어쓰지 않습니다.** `proofFile` 경로에 다른 스냅샷의 증명
  파일이 있으면 거부합니다. 스냅샷마다 경로를 달리하십시오.
- **표본 확인(선택).** 옵션에 `spotCheck: true`를 주면 플랫폼이 무작위로
  지정한 계정 8개의 개봉을 함께 보냅니다(해시된 식별자·솔트·잔고와 바로 옆
  계정의 잔고 — 계정 식별자 자체는 보내지 않습니다). 기본은 보내지
  않습니다.
- **앵커 확정까지 기다리기.** `waitAnchoredMs: 600_000`을 주면 앵커가
  확정된 뒤 돌아옵니다. 주지 않으면 접수 즉시 돌아오고, 상태는
  `client.status(anchored.snapshotId)`로 읽습니다.

## 사용자 증명 발급

플랫폼은 계정을 받지 않으므로 사용자 증명은 귀사만 발급할 수 있습니다.
증명 파일과 잔고 파일, 두 파일로 스냅샷을 다시 엽니다:

```ts
import { writeFileSync } from 'node:fs';
import { openSnapshot } from './packages/attest-por/src/index.ts';

const snapshot = await openSnapshot('por-proof-2026-11-18.json', 'packages/attest-por/samples/balances.wide.csv');

const proof = snapshot.proofFor('U-100008');       // 스냅샷에 없는 계정이면 null
if (proof) writeFileSync('proof-U-100008.json', JSON.stringify(proof, null, 2));

// 전원: <해시 앞 두 글자>/<해시된 식별자>.json 으로 나뉘어 저장됩니다
const count = await snapshot.writeAllProofs('proofs');
console.log(count, snapshot.snapshotId);
```

`openSnapshot`은 잔고 파일로 트리를 다시 계산해 루트·총액·계정 수가
앵커링된 것과 같을 때만 스냅샷을 돌려줍니다. 잔고 파일이 한 글자라도
다르면 아무것도 발급하지 않고, 무엇이 달랐는지와 그 파일이 증명 파일에
기록된 원본인지를 오류(`SnapshotRestoreError`)로 알려 줍니다. 사용자에게는
`proof`(JSON)와 스냅샷 ID를 전달하십시오.

## 사용자가 받는 것

사용자는 받은 증명을 오프라인으로 검증합니다 — `verifyPorInclusion`은
경로를 루트와 **선언된 총액에 동시에** 대조하므로, 총액을 달리 말한 루트는
통과하지 못합니다. 증명에는 그 사용자의 잔고와 함께 트리에서 바로 옆 계정의
잔고(식별자 없음)와 경로상의 소계가 들어 있습니다 — 합계 검증에 필요한
값입니다. [공개 검증 페이지](../playground/por.html)는 다섯 가지 검사 —
거래소 서명, 루트·총액 대비 포함, 참조와 해시의 일치, 커밋, 앵커 — 를
브라우저에서 수행하고 아무것도 업로드하지 않으며, 그 스냅샷이 표본 확인을
거쳤는지도 보여 줍니다.

## 준비금, 그리고 명시된 경계

선언된 준비금 주소는 플랫폼이 스냅샷을 접수하는 시점에 **온체인에서
실측**합니다 — 솔벤시 리포트는 `MEASURED`와 `DECLARED_ONLY`를 구분하며,
읽지 못한 것을 조용히 합산하지 않습니다. 표본 확인은 요청했을 때에만
이루어지며 말 그대로 표본입니다: 잘못 만든 트리를 높은 확률로 잡아내지만,
모든 리프가 실제 고객임을 증명하지는 않습니다. 표본 확인이 없는 스냅샷에
대해 플랫폼이 확인한 것은 거래소의 서명과 선언문 형식까지이고, 트리에
대해서는 아무것도 확인하지 않았습니다. 어느 쪽이든 트리는 거래소 사용자
각자의 포함증명으로 확인됩니다. 페이지와 API가 어느 쪽이었는지를
반올림하지 않고 그대로 말합니다.

## 샌드박스의 정직성

샌드박스 스냅샷은 사설 테스트 체인에 앵커되며 **공개 검증이 불가**합니다.
라이브 배포는 비트코인에 앵커합니다. 합성 부채는 어디서나 합성으로
표기됩니다.
