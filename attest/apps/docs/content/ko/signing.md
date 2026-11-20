# 발행인 서명

앵커링은 문서가 어느 블록 높이 시점에 존재했음을 증명합니다. **누가** 발행했는지는
말하지 않습니다 — 파일은 누구나 해시할 수 있으니까요. 발행인 서명이 그 간극을 메우고,
이 페이지는 그 방법입니다.

서명은 **선택**입니다. `POST /v1/attestations` 는 그대로이고 여전히 기본이며,
아래 내용 중 어느 것도 문서를 앵커링하는 데 필요하지 않습니다.

## 콘솔에서 시작하기

등록된 공개키 선택 → 서명 요청 파일 다운로드 → 귀사 환경에서 서명 → 결과 JSON 가져오기 순서입니다. 실행 명령은 아래 두 가이드에서 확인하십시오.

- [기존 서명 도구·HSM/KMS 사용](#signing-existing): 보유한 개인키로 서명합니다.
- [당사 Docker·SDK 사용](#signing-tool): 도구 설치, 필요한 경우 키 생성·공개키 등록, 요청 파일 서명을 안내합니다.

콘솔 경로는 조직에 등록된 활성 공개키를 선택해야 합니다. 아래의 해시 직접 서명 예시는 API 연동용이며, 콘솔에서는 다운로드한 요청 파일에 서명하는 가이드를 따르십시오.

## 단 하나의 규칙

**개인키는 저희에게 오지 않습니다.** 개인키를 받는 엔드포인트가 없고, 저장할 수 있는
컬럼도 없습니다. 저희가 만들 수 있었던 서명은 귀사에 대해 아무것도 증명하지
못합니다. 그래서 키는 귀사 장비에 남고, 이 페이지는 그것을 말뿐이 아니라 실행
가능하게 만들기 위해 있습니다.

보내는 것은 **서명된 서명문(statement)** 입니다: 문서의 해시, 귀사의 공개키, 그리고 서명.
그 외에는 없습니다.

## 다운로드

<!-- DOWNLOADS -->

### 받은 것을 확인하기

```bash
sha256sum -c attest-sign.sha256
tar xzf attest-sign.tar.gz
```

설치 단계 없이 그대로 돕니다 — 이 패키지는 의존성이 없습니다. Node 22.18 이상은 `.ts` 소스를 그대로 실행합니다(그보다 낮은 22.x는 `--experimental-strip-types` 를 붙이십시오):

```bash
node packages/attest-sign/src/cli.ts --help
```

### 컨테이너 빌드

**공개 레지스트리에 이미지를 두지 않았습니다.** 의도적입니다. 받아 오는(pull)
이미지는 신뢰해야 하는 이미지이고, 이것은 개인키를 만드는 도구입니다. 방금 체크섬을
확인한 소스로 직접 빌드하십시오.

```bash
docker build -t attest-sign -f packages/attest-sign/Dockerfile .
```

빌드는 파일을 복사할 뿐 다른 일을 하지 않습니다 — 번들러도, 미니파이어도, 패키지
관리자도, 네트워크도 없습니다. 따라서 같은 소스로 두 번 빌드하면 같은 이미지가 나오고,
남의 말을 믿는 대신 digest를 대조하시면 됩니다.

무엇을 실행하려는지 직접 읽어 보실 수도 있습니다:

```bash
docker run --rm --entrypoint cat attest-sign /app/src/index.ts
```

인터넷이 없는 장비 — 서명 키가 있어야 할 올바른 자리입니다 — 로 옮기시려면 이미지를
직접 들고 가십시오:

```bash
docker save attest-sign | gzip > attest-sign-image.tar.gz   # 약 50 MB
# 오프라인 장비에서:
docker load -i attest-sign-image.tar.gz
```

## 사용법

### 1 — 키 만들기, 한 번만

```bash
docker run --rm --network=none -v "$PWD:/work" \
  attest-sign keygen --out /work/issuer.key.json
```

`--network=none` 은 장식이 아닙니다. 이 도구는 소켓을 열지 않고 — 저장소의 테스트가
그것을 단언합니다 — 네트워크를 끊고 실행하면 그 주장을 받아들이는 대신 **관찰**하게
됩니다. `--offline-check` 는 한 걸음 더 나아가, 네트워크가 닿으면 도구가 아예
**실행을 거부**합니다.

개인키는 지정하신 경로에 `0600` 으로 쓰이고 다른 어디에도 쓰이지 않습니다. 저희는
받지 않으며 복구할 수도 없습니다.

### 2 — 해시에 서명

콘솔이 고르신 문서의 해시를 보여 줍니다. 그 64글자를 서명하는 장비로 옮기십시오 —
**문서가 아니라**:

```bash
docker run --rm --network=none -v "$PWD:/work" \
  attest-sign sign --key /work/issuer.key.json \
    --digest 7cda0d6f4184f4c79476d675aee469a0d847b987f595b566b0ddb8f1156643ba
```

가능한 것 중 가장 안전한 구성입니다. 키를 쥔 장비가 문서를 아예 보지 않습니다. 서명은
애초에 해시에 대한 것이었으므로, 파일을 옮기지 않아도 잃는 것이 없습니다.

문서가 *그* 장비에 있다면 `--file contract.pdf` 가 해시와 서명을 한 번에 합니다.
출력된 해시를 `sha256sum` 과 직접 대조해 보십시오.

### 3 — 결과를 붙여 넣기

콘솔이 **귀사의 브라우저에서**, 아무것도 보내기 전에 검사합니다: 서명이 서명문을
덮는지, 그리고 서명문의 해시가 고르신 문서와 맞는지. 실수가 몇 달 뒤 받는 쪽에서가
아니라 고칠 수 있는 사람 앞에서 드러납니다.

## 라이브러리로

npm에는 없습니다 — 위 tarball에서 가져가십시오. 의존성이 없으므로 설치할 것도
없습니다:

```ts
import { generateKey, signStatement } from './packages/attest-sign/src/index.ts';   // npm에 올라가면 '@stonehash/attest-sign'

const key = await generateKey();            // 기본 ES256, 'RS256' 도 가능
const statement = await signStatement(key, {
  documentSha256: '7cda…',
  contentType: 'application/pdf',
});
// { statement } 를 /v1/attestations/signed 로 POST
```

`generateKey` 는 플랫폼 CSPRNG에서 난수를 받아 **유일한 사본**을 돌려줍니다. 그것이
어디로 가는지는 귀사의 결정입니다 — HSM, KMS, 오프라인 장비의 파일. 라이브러리는
일부러 고르지 않으며, 파일시스템을 아예 건드리지 않습니다.

## HSM·KMS로 서명하기

은행의 서명 키는 하드웨어 안에 살고 밖으로 나오지 않습니다 — 그것이 맞고, 여기의
어느 것도 그 반대를 요구하지 않습니다. 이 도구는 서명을 두 반쪽으로 나눠 키가
파일로 존재할 필요 자체를 없앱니다: 서명할 바이트를 만드는 일은 키 없이 여기서,
그 바이트에 서명하는 일은 키가 있는 곳에서 일어납니다.

이 용도만을 위한 전용 키를 쓰십시오 — 같은 하드웨어에서, 같은 절차로 새로 만들되,
이미 다른 것에 서명하는 키는 아닙니다. 키 하나에 임무 하나: 공유된 키는 이
시스템의 보안을 다른 시스템에 결속시키고, 등록 항목을 그쪽 인증서 수명주기에
묶어 버립니다.

### 1 — 준비

```bash
node packages/attest-sign/src/cli.ts prepare \
  --digest 7cda0d6f4184f4c79476d675aee469a0d847b987f595b566b0ddb8f1156643ba \
  --public-key issuer-public.pem
```

`--public-key` 는 공개 반쪽만 받습니다 — PEM, DER, base64, 또는 이 도구가 만든
키 파일. 두 파일이 나옵니다: 서명문인 `prepared.json`, 그리고 서명할 바이트
그 자체인 `signing-input.bin`. 알고리즘은 키에서 읽어내며, `--algorithm` 으로
덮어쓸 수 있습니다.

### 2 — 키가 있는 곳에서 서명

`signing-input.bin` 전체에 대해 ECDSA P-256 + SHA-256, 또는 RSA PKCS#1 v1.5 +
SHA-256:

```bash
# OpenSSL — HSM 앞의 PKCS#11 엔진 포함
openssl dgst -sha256 -sign issuer.key -out sig.der signing-input.bin

# AWS KMS
aws kms sign --key-id <key-id> --message fileb://signing-input.bin \
  --message-type RAW --signing-algorithm ECDSA_SHA_256 \
  --output text --query Signature | base64 -d > sig.der
```

원시 `r‖s` 와 DER 모두, 바이너리·base64·hex 모두 받습니다 — 장비마다 제각각인
부분이므로, 묻는 대신 다음 단계가 알아서 가려냅니다.

### 3 — 결합, 그리고 틀린 채로는 나가지 않음

```bash
node packages/attest-sign/src/cli.ts assemble \
  --statement prepared.json --signature sig.der --out signed.json
```

서명은 **무엇이든 쓰여지기 전에** 서명문 안의 공개키로 검증됩니다. 엉뚱한
바이트에 서명했거나 별칭이 가리킨 키가 실은 다른 키였던 장비는 여기서 — 운영자
앞에서 — 실패합니다. 몇 달 뒤 수신자 앞에서가 아니라. 나오는 것은 완성된 서명된
서명문입니다: 콘솔에 붙여 넣거나, `{ "statement": … }` 로
`POST /v1/attestations/signed` 에 보내십시오.

## 무엇에 서명하는가

```
"stonehash:attestation:sig:v1\n" ‖ JCS(서명을 뺀 statement)
```

`JCS` 는 [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) 정규 JSON입니다. 도메인
구분자가 있으므로 여기서 만든 서명이 이 시스템이 해시하는 다른 어떤 것에 대한
서명으로 재사용될 수 없습니다.

**직접 구현하지 말고 SDK를 쓰십시오.** 키 순서나 숫자 표기가 조금만 다른
정규화기(canonicaliser)는 읽을 가치도 없는 진단과 함께 검증에 실패하는 서명을
만들어 냅니다. SDK도 이것을 다시 구현하지 않습니다 — 검증기가 쓰는 바로 그 모듈을
가져다 쓰므로 서명자와 검사자가 어긋날 수 없습니다.

## 체인이 커밋하는 것

```
leaf_bytes = sha256(JCS(서명을 *포함한* statement))
```

비대칭에 주목하십시오. 서명은 서명문에서 **서명을 빼고** 덮고, 앵커링은 **서명을
포함해서** 덮습니다. 그것이 서명에 시각을 붙이는 방식입니다. 블록 높이 하나가 문서가
존재했다는 것, 귀사가 서명했다는 것, 그리고 그 둘이 그 블록 시점에 이미 참이었다는
것을 함께 증명합니다.

추가 비용은 없습니다. 서명된 기록은 다른 모든 기록과 같은 묶음에 들어갑니다 —
추가 온체인 데이터도, 별도 트랜잭션도, 추가 수수료도 없습니다.

체인이 담지 *않는* 것은 서명문의 본문이고, 해시만 올라갑니다. 증명 파일을
보관하십시오. 그것이 읽을 수 있는 사본이고, 기한이 없습니다.

## 등록된 키, 그리고 서명이 증명하지 않는 것

서명문은 자기 공개키를 들고 다닙니다. 따라서 유효한 서명은 **그 키를 가진 자가**
서명했음을 증명할 뿐, 그 키가 누구 것인지는 증명하지 않습니다. 키는 누구나 만들 수
있습니다.

공개키 쪽을 저희에게 등록하는 것이 그 간극을 메웁니다. 등록 후 그 키로 서명된 기록은
이렇게 보고됩니다:

| `issuer_trust` | 뜻 |
|---|---|
| `registered` | 그 기록이 만들어지기 전에 귀사의 조직이 보증한 키입니다. |
| `unregistered` | 서명은 산술적으로 멀쩡하고, 그 키가 누구 것인지는 아무것도 증명하지 않습니다. |

`unregistered` 는 **약한 `registered` 가 아닙니다.** 다른 진술이고, 콘솔도 체크
표시 대신 그렇게 보고합니다.

키를 폐기하면 *앞으로의* 기록이 보고되는 방식이 바뀝니다. 이미 앵커된 기록은
만들어질 당시의 신뢰 상태를 그대로 유지합니다 — 증명은 자기 블록 높이 시점의 사실을
진술하는 것이고, 그것을 소급해 고쳐 쓰면 기록이 하지 않은 말을 하게 됩니다.

등록은 콘솔의 **연동 → 서명 공개키 · 기관**에서 로그인한 사람이 하거나, 귀사 서버에서
`POST /v1/issuer-keys` 를 호출해 합니다. 어느 쪽이든 보내는 것은 공개키 쪽뿐입니다. 키를 보증하는
일은 거버넌스 행위이고, 개인키는 귀사를 떠나지 않습니다.

## 알고리즘

`ES256`(P-256)이 기본입니다. WebCrypto·WebAuthn과 대부분의 KMS 제품이 쓰는 것이고,
서명이 64바이트입니다.

`RS256` 도 받습니다. 은행은 자기 사정에 맞춰 바꿀 수 없는 하드웨어 안에 RSA 키를
갖고 있기 때문입니다. 한 가지 단서: 브라우저는 보안 컨텍스트 밖에서 WebCrypto를
내주지 않고, 검증기의 순수 JavaScript 대체 경로는 P-256만 다룹니다 — 따라서
브라우저에서 RSA 서명을 검사하려면 페이지가 HTTPS로 제공되어야 합니다. 서버 쪽
검증은 영향받지 않습니다.
