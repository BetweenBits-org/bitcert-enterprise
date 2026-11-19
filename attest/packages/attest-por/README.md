# attest-por — exchange SDK for proof of reserves

Everything an exchange's side of a reserve snapshot needs, as source that
Node 22.18 or later runs directly — no install, no build, no third-party
dependency. It is called from your own system's source:

    import { PorClient, anchorBalanceFile, openSnapshot } from './packages/attest-por/src/index.ts';

    // the balance file your ledger exports → an anchored snapshot, and one proof file
    const anchored = await anchorBalanceFile(client, 'balances.csv', { assets, amounts: 'decimal', asof, proofFile });
    // later, from the proof file and the same balance file: any customer's proof
    const proof = (await openSnapshot(proofFile, 'balances.csv')).proofFor('U-100008');

The balance file never leaves your machine: what is sent is a signed
statement of the root, the totals and the number of accounts. What you keep
is the balance file and the one proof file.

| | |
|---|---|
| `src/anchor.ts` | `anchorBalanceFile()` and `openSnapshot()` — the two calls |
| `src/client.ts` | `PorClient` — signing, submitting, reading a snapshot's state |
| `src/intake.ts` · `src/ledger.ts` | Reading and checking a balance file (CSV in three layouts, or JSON) |
| `src/snapshot-proof.ts` | The proof file: what is in it, and rebuilding a snapshot from it |
| `src/sumtree.ts` | The Merkle sum tree |
| `samples/` | An example balance file in the standard shape (`balances.wide.csv`) and in the three others, an asset list, and export queries per database |

The guide is on the developer hub of the deployment this was downloaded
from, under **Proof of Reserves**.

The samples are synthetic: fictional accounts and balances.

---

거래소 측 연동에 필요한 전부이며, 귀사 시스템의 소스에서 호출합니다. Node 22.18
이상이 소스를 그대로 실행합니다(설치·빌드·외부 의존성 없음). 잔고 파일은 귀사
서버를 떠나지 않고, 보관할 것은 잔고 파일과 증명 파일 하나입니다. 안내서는 이
파일을 내려받은 배포의 개발자 허브 — **준비금 증명** — 에 있습니다. 예시 파일은
모두 합성 데이터입니다.
