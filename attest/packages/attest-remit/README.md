# attest-remit — bank SDK for cross-border settlement

Everything a bank's side of the corridor needs, as source that Node 22.18 or
later runs directly — no install, no build, no third-party dependency. It is
called from your own system's source:

    import { RemitClient } from './packages/attest-remit/src/index.ts';

    // the MT103, pacs.008 or pain.001 your payment system already writes
    const sent = await client.submitSwift(message);
    const report = await client.statusReport(sent.paymentId);   // pacs.002

| | |
|---|---|
| `src/client.ts` | `RemitClient` — `submitSwift()` for MT103 / pacs.008 / pain.001; quote, build and sign, submit, track, evidence |
| `src/swift/` | The message readers, the conversion table, and the `pacs.002` status report |
| `src/signer.ts` | Signing with a key held in an HSM or a KMS |
| `src/travelrule.ts` | Travel Rule mode B — party data encrypted on the bank's side |
| `src/verify.ts` | Independent re-verification of an evidence package |
| `samples/` | Sample messages (pacs.008, pain.001, MT103) and a customer-master extract |

The guide is on the developer hub of the deployment this was downloaded
from, under **Cross-border Settlement**.

The samples are synthetic: fictional companies, fictional institution codes.

---

은행 측 연동에 필요한 전부이며, 귀행 시스템의 소스에서 호출합니다. Node 22.18
이상이 소스를 그대로 실행합니다(설치·빌드·외부 의존성 없음). 안내서는 이 파일을
내려받은 배포의 개발자 허브 — **국경간 송금** — 에 있습니다. 표본 전문은 모두
합성 데이터입니다.
