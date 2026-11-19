/**
 * Documents for the cases of the inscription routes.
 *
 * The Java service of a comparison run may hold a wallet that can pay, so a
 * document that passed every check would really be inscribed — coins spent,
 * a document put on a chain. A case about a refusal must therefore never
 * rest on that one refusal alone: were the rule under test broken in a build
 * (on purpose, to see that the comparison notices), the document has to be
 * refused by another rule further on.
 *
 * `overLimit` is the document for that: longer than this deployment
 * inscribes, and short enough to be read whole (the upload ceiling is the
 * limit plus 64 KiB). The size is the last thing checked before the wallet
 * is asked — after the door, the allowance, the duplicate and the content
 * type — so such a document answers every earlier refusal exactly as a small
 * one would, and cannot be inscribed whichever of them fails.
 */
export const overLimit = (label, limit) => Buffer.concat([Buffer.from(`${label}\n`, 'utf8'), Buffer.alloc(limit, 0x61)]);
