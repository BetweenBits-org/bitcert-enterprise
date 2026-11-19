/**
 * `@stonehash/attest-evidence` — assembles the evidence archive.
 *
 * One file a reviewer can file, hand on, or keep: the sources, the exact policy,
 * the verdict, the proof files and a printable summary. Deterministic, so two
 * exports of the same evidence are byte-identical and a digest of the archive
 * means something.
 *
 * No third-party dependency. ZIP headers and the PDF are written here; DEFLATE
 * comes from the platform's `CompressionStream`. Both matter because the archive
 * is produced in a browser as well as on the server, and because a customer
 * auditing what they were given should not have to audit an archiver too.
 */
export { assembleEvidenceBundle, assembleFiles } from './bundle.ts';
export type { AssembledBundle, AssembleInput, BundleFile } from './bundle.ts';
export { crc32, writeZip } from './zip.ts';
export type { ZipEntry, ZipOptions } from './zip.ts';
export { renderPdf, toLatin1 } from './pdf.ts';
export type { FontName, PdfOptions, TextRun } from './pdf.ts';
export { buildReport } from './report.ts';
export type { ReportInput } from './report.ts';
