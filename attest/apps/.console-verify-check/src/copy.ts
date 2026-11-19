/**
 * Screen copy that is not generated from an API response.
 *
 * Its own module, with no DOM and no imports, so a test can read it in Node.
 * `api.ts` resolves the API base from a meta tag at load, which makes anything
 * importing it unloadable outside a browser — and the one thing worth pinning
 * here is coverage: every scenario the engine ships must have a line.
 */
/**
 * What each scenario is for, in the language of the screen.
 *
 * The engine ships its own `teaches` text and that stays English: it is a
 * library, read by tests and by whoever integrates it. This is the console's
 * own copy for the person evaluating the product, and `test/sandbox.test.ts`
 * fails if a scenario is added without a line here — so a new case can go
 * missing from the catalogue but cannot go silent on this page.
 */
export const SCENARIO_KO: Record<string, string> = {
  A: '여섯 곳에서 온 자료가 정책 아래 모두 일치합니다. 그런데도 결과는 사람의 검토를 요구합니다 — 데이터가 합성이고 키가 시연용이라, 발행 주체와 자금 확정은 충족될 수 없기 때문입니다.',
  B: '송금액이 지시 금액보다 2,000 모자랍니다. 허용 오차는 0입니다. 결과는 어느 필드가, 얼마에서 얼마로, 어떤 기준을 넘겼는지 적습니다 — "금액이 안 맞습니다"로는 담당자가 할 수 있는 일이 없습니다.',
  C: '해시도 체인 데이터도 그대로 검증됩니다. 깨진 것은 지급사 서명 하나뿐입니다. 무결성은 통과하는데 발행 기관이 실패하는 이 조합이, 초록 체크 하나로 덮이면 보이지 않는 바로 그 경우입니다.',
  D: '인보이스가 번호로만 언급되고 실물이 없습니다. 결과는 INVALID가 아니라 INCOMPLETE입니다 — 없는 서류는 요청할 일이고 위조된 서류는 보고할 일인데, 둘을 뭉치면 담당자가 엉뚱한 쪽으로 갑니다.',
  E: '40%, 그다음 60%. 이게 맞는 거래인지는 정책이 분할 합산을 허용하는지에 전적으로 달려 있습니다. 엔진은 그 판단을 하지 않습니다 — 정책이 하고, 어느 버전의 정책이었는지가 결과에 남습니다.',
  F: '같은 지급 영수증을 두 번 제출합니다. 문서에는 아무 문제가 없습니다 — 해시도 맞고 서명도 검증됩니다. 지급사가 실제로 서명한 그 영수증이니까요. 무결성과 발행 기관이 모두 통과하는데도 집행하면 안 됩니다. "문서가 진짜다"와 "거래를 승인한다"가 서로 다른 질문이라는 것을 보여주는 경우입니다.',
};

/** Scenario titles for the chips. The engine's English titles stay the ids' names. */
export const SCENARIO_TITLE_KO: Record<string, string> = {
  A: '정상 거래',
  B: '금액 불일치',
  C: '지급 서명 훼손',
  D: '인보이스 누락',
  E: '분할 지급',
  F: '중복 제출',
};

/**
 * The tamper catalogue, in the language of the screen.
 *
 * `asks` is the reason to press the button, not a description of it: nobody
 * needs to be told that "corrupt a signature" corrupts a signature. What is
 * worth knowing is which question the result answers.
 */
export const TAMPER_KO: Record<string, { label: string; asks: string }> = {
  amount: {
    label: '금액 바꾸기',
    asks: '승인 후 숫자가 수정되면 잡히는지, 그리고 결과가 어느 숫자인지까지 말해 주는지.',
  },
  signature: {
    label: '서명 훼손하기',
    asks: '발행 기관의 인장이 위조되면 무결성은 여전히 통과하는지, 그리고 실패가 문서가 아니라 발행 기관 쪽으로 귀속되는지.',
  },
  document: {
    label: '필수 서류 제거하기',
    asks: '없는 서류가 "무효"가 아니라 "누락"으로 보고되는지. 둘은 해야 할 일이 다릅니다.',
  },
  digest: {
    label: '해시 뒤의 문서 바꿔치기',
    asks: '서류는 그대로 두고 파일만 바꾸면 어느 고리가 끊어지는지.',
  },
  duplicate: {
    label: '같은 지급 두 번 제출하기',
    asks: '전부 검증되는데도 지급은 막아야 합니다. 결과가 "진짜 문서"와 "승인된 거래"를 구분합니까?',
  },
};
