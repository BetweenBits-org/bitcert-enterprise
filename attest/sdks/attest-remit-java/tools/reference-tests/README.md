# Generators of the written-down expectations

Some Java tests of the `swift` package hold their expected values as literals,
"written down, not computed" — and every one of those values came out of the
TypeScript reference (`packages/attest-remit`). These are the scripts that
produced them. When the reference changes, run the script again and paste what
it prints; do not edit an expectation by hand.

| Script | Writes |
|---|---|
| `mt/gen.ts` (cases in `mt/cases.ts`) | `Mt103ReferenceTest.java` — the whole file |
| `iso/answers.ts` | `Iso20022Answers.java` — the whole file |
| `mapping/fingerprints.ts` (cases in `mapping/expect.ts`) | the `CASES` table of `SwiftMappingTest.java` |
| `mapping/expect.ts <section>` | the values the other `SwiftMappingTest` methods assert |

`node <script>` runs them (Node 22.18 or later runs TypeScript directly). They
import the reference, and read its samples and the golden vectors of
`src/test/resources/golden/`, by paths relative to themselves, so they run
from any checkout or copy of this tree. Where each writes: `mt/gen.ts` the
Java test in place (or `--out <file>`); `iso/answers.ts` to standard output;
`mapping/fingerprints.ts`, `mapping/expect.ts` and `mapping/hardening.ts` print
what is pasted; `mapping/gen2.ts` and the `iso` fuzzers write only to the
files named as arguments; `mapping/rows-check.ts` reads the Java test in
place (or the copy named as its argument). Regenerate the golden vectors
first: several of these read them.

`iso/fuzz.ts`, `iso/fuzzbytes.ts`, `iso/structfuzz.ts` (with `iso/FuzzDriver.java`)
and `mt/review.ts`, `mt/large-inputs.ts`, `mt/bytes.ts` are the checks the
ports were held to beside the vectors: the same inputs through both readers.
The general one is `tools/diff-fuzz.mjs`.
