# 당사 Docker·SDK 사용

당사 도구로 귀사 환경에서 서명합니다. Docker 사용 여부와 관계없이 콘솔에서 선택한 등록 공개키와 짝이 되는 개인키가 필요합니다. 이미 사용하는 키를 매번 새로 생성하지 마십시오.

## 1. 도구 받기

[발행인 서명](#signing)에서 소스와 체크섬을 다운로드한 뒤 확인·압축 해제합니다. Node 경로는 22.18 이상을 사용합니다.

```bash
sha256sum -c attest-sign.sha256
tar xzf attest-sign.tar.gz
```
```bash
docker build -t attest-sign -f packages/attest-sign/Dockerfile .
```

명령의 이미지는 받은 소스로 직접 만든 로컬 이미지입니다. Docker 대신 Node로 같은 CLI를 실행해도 됩니다. 외부 PEM 개인키 또는 HSM/KMS를 사용한다면 [기존 서명 도구 가이드](#signing-existing)를 따르십시오.

## 2. 키 준비와 공개키 등록

당사 도구로 생성한 `issuer.key.json`이 있고 해당 공개키를 이미 등록했다면 이 단계를 건너뜁니다. 키가 없는 경우에만 새 키 쌍을 만들고 공개키만 별도 파일로 추출합니다.

```bash
docker run --rm --network=none -v "$PWD:/work" \
  attest-sign keygen --out /work/issuer.key.json
node --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs"; const key=JSON.parse(readFileSync("issuer.key.json","utf8")); writeFileSync("issuer-public.txt",key.publicKeySpkiBase64+"\n");'
```

`issuer.key.json`은 개인키가 포함된 파일로 귀사 환경에 보관합니다. 콘솔 **연동 → 공개키 등록**에는 `issuer-public.txt` 내용만 입력합니다. 개인키 파일은 등록하거나 업로드하지 마십시오. 공개키 등록 후 문서 앵커링 화면으로 돌아가 문서와 등록 키를 선택하고 `signing-request.json`을 다운로드합니다.

## 3. 요청 파일에 서명

선택한 공개키에 대응하는 `issuer.key.json`과 콘솔에서 받은 요청 파일을 같은 작업 디렉터리에 준비합니다.

```bash
docker run --rm --network=none -v "$PWD:/work" \
  attest-sign sign --key /work/issuer.key.json \
  --statement /work/signing-request.json --out /work/signed.json
```

Docker를 사용하지 않는 경우:

```bash
node packages/attest-sign/src/cli.ts sign --key issuer.key.json \
  --statement signing-request.json --out signed.json
```

`--statement`를 사용하면 콘솔에서 준비한 해시·공개키·발행 시각 그대로 서명합니다. 문서나 키를 바꾼 경우에는 요청 파일도 다시 내려받으십시오. 다른 키로 서명하면 콘솔 검증을 통과하지 못합니다.

## 4. 서명 결과 가져오기

콘솔에서 `signed.json`을 선택하거나 파일의 JSON 전체를 붙여 넣습니다. 문서·등록 공개키·서명의 세 검증을 확인한 뒤 **서명과 함께 앵커링**을 누릅니다. 서명 결과만 전달되며 개인키와 원본 문서는 전달되지 않습니다. 서버는 선택한 키의 소유 조직과 폐기 여부도 확인합니다.
