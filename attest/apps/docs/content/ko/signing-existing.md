# 기존 서명 도구·HSM/KMS 사용

연동 메뉴에 등록한 공개키와 짝이 되는 개인키를 그대로 사용합니다. 키를 새로 생성하거나 플랫폼에 개인키를 보낼 필요가 없습니다. 콘솔의 공개키 선택은 서명 도구 선택과 별개입니다.

## 1. 공개키 등록과 요청 파일 준비

문서 앵커링을 구독한 조직에서 **연동 → 공개키 등록**으로 ES256(P-256) 공개키를 등록하십시오. 이미 등록했다면 해당 키를 사용합니다. HSM/KMS에서는 공개키만 내보내 등록합니다. 파일 형태의 개인키에서 공개키를 추출할 때는 귀사 장비에서 다음 명령을 실행합니다.

```bash
openssl pkey -in issuer-private.pem -pubout -out issuer-public.pem
```

콘솔의 **문서 앵커링 → 발행인 서명 붙이기**에서 문서를 고르고 등록 키의 라벨·지문을 확인한 뒤 **서명 요청 파일 다운로드**를 누릅니다. 파일명은 `signing-request.json`입니다. 문서 해시·공개키·발행 시각이 들어 있고 문서 원본과 개인키는 들어 있지 않습니다. 문서나 키를 바꿨다면 요청 파일을 다시 받아 서명하십시오.

## 2. 서명할 바이트 준비

[발행인 서명](#signing)에서 도구와 체크섬을 받습니다. Node 22.18 이상에서 다음 명령을 실행하십시오.

```bash
sha256sum -c attest-sign.sha256
tar xzf attest-sign.tar.gz
```
```bash
node packages/attest-sign/src/cli.ts prepare \
  --statement signing-request.json --input-out signing-input.bin
```

`signing-input.bin`은 도메인 구분자와 정규화된 요청 내용을 포함합니다. 문서 해시 문자열만 직접 서명하면 이 프로토콜의 서명이 되지 않습니다. 요청 파일의 공개키가 실제 서명 키와 대응하는지 확인하십시오.

## 3. 보유한 개인키로 서명

ES256(P-256) 기준으로 `signing-input.bin` 전체에 SHA-256을 적용하는 ECDSA 서명을 만듭니다. PEM 개인키를 보유한 장비에서는 다음과 같습니다.

```bash
openssl dgst -sha256 -sign issuer-private.pem \
  -out signature.der signing-input.bin
```

HSM/KMS에서는 귀사의 서명 API나 어댑터로 같은 바이트를 서명하고 결과를 `signature.der`에 저장합니다. 개인키를 도구나 콘솔로 내보내지 않습니다. 장비의 입력이 원문인지 이미 계산한 해시인지 확인하여 중복 해싱을 피하십시오. ES256의 DER 서명과 64바이트 raw 서명 모두 결합 도구가 처리합니다.

## 4. 결과 결합과 콘솔 검증

```bash
node packages/attest-sign/src/cli.ts assemble \
  --statement signing-request.json --signature signature.der --out signed.json
```

결합 도구는 요청의 공개키로 서명을 검증하고 `signed.json`을 만듭니다. 콘솔에서 같은 문서·등록 키를 선택한 상태로 **서명 결과 파일 선택**을 누르거나 JSON 전체를 붙여 넣으십시오. 문서 일치, 선택한 공개키 일치, 서명 유효성이 모두 통과해야 앵커링할 수 있습니다. 서버에서도 키가 현재 조직의 활성 등록 키인지 다시 확인합니다.

키가 폐기됐거나 다른 조직의 키이면 접수되지 않습니다. 다른 키로 바꿨다면 새 요청을 내려받아 다시 서명하십시오. **개인키 파일은 업로드하지 마십시오.**
