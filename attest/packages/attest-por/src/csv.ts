/**
 * A CSV reader for one job: reading an exchange's balance export without
 * guessing.
 *
 * The file this reads decides a liability total that is then signed and
 * anchored, so the reader's bias is the opposite of a spreadsheet's. A
 * spreadsheet shows something for every input; this stops, with the line
 * number, at the first thing it would otherwise have to interpret — a quote
 * in the middle of a field, text after a closing quote, bytes that are not
 * UTF-8. Every one of those is a file that two programs would read
 * differently, and "two programs read it differently" is how a total comes to
 * differ from the ledger it was exported from.
 *
 * Fed in pieces, because a ledger export does not fit comfortably in one
 * string: text arrives a chunk at a time and records are handed on as they
 * complete. Nothing here touches a file — the same parser runs on a server
 * and in the console's browser page. No dependency, like the rest of the
 * package — the SDK is delivered as source an exchange can read in an
 * afternoon, and a parser pulled from a registry would be the one part
 * nobody read.
 *
 * Dialect (RFC 4180, strictly):
 *   - UTF-8, with or without a byte-order mark;
 *   - records end in LF or CRLF; a blank line is skipped;
 *   - a field may be wrapped in double quotes, in which case it may contain
 *     the delimiter, line breaks and `""` for a literal quote;
 *   - outside quotes a `"` is an error, not a character.
 */
export interface CsvRecord {
  /** 1-based line of the file on which the record starts. */
  line: number;
  fields: string[];
}

export class CsvError extends Error {
  /** 1-based line, or 0 when the problem is with the file as a whole. */
  readonly line: number;
  readonly code: 'csv_syntax' | 'file_encoding';
  constructor(line: number, message: string, code: 'csv_syntax' | 'file_encoding' = 'csv_syntax') {
    super(line > 0 ? `line ${line}: ${message}` : message);
    this.line = line;
    this.code = code;
  }
}

/** One quoted field longer than this is an unbalanced quote, not data. */
const MAX_FIELD_CHARS = 1 << 20;

/**
 * The state machine, fed text in arbitrary pieces.
 *
 * Kept separate from the file handling so it can be driven with chunk
 * boundaries placed anywhere — between the CR and the LF, inside `""` — which
 * is exactly where a hand-rolled streaming parser goes wrong.
 */
export class CsvParser {
  private readonly delimiter: string;
  private field = '';
  private fields: string[] = [];
  /** Where the reader is inside the current field. */
  private state: 'start' | 'unquoted' | 'quoted' | 'quote-in-quoted' = 'start';
  /** A CR was the last character of the previous chunk. */
  private pendingCr = false;
  private line = 1;
  private recordLine = 1;
  private sawAnything = false;
  /** The current record has no field with content and no quote: a blank line. */
  private blank = true;

  constructor(delimiter = ',') {
    if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
      throw new Error('the delimiter must be a single character other than a quote or a line break');
    }
    this.delimiter = delimiter;
  }

  push(chunk: string): CsvRecord[] {
    const out: CsvRecord[] = [];
    let text = chunk;
    if (!this.sawAnything && text.length > 0) {
      this.sawAnything = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;

      if (this.pendingCr) {
        this.pendingCr = false;
        // CRLF is one line ending; the CR already ended the record.
        if (c === '\n') continue;
      }

      if (this.state === 'quoted') {
        if (c === '"') { this.state = 'quote-in-quoted'; continue; }
        if (c === '\n') this.line++;
        this.field += c;
        if (this.field.length > MAX_FIELD_CHARS) {
          throw new CsvError(this.recordLine, 'a quoted field never closes (check for an unpaired " in this record)');
        }
        continue;
      }

      if (this.state === 'quote-in-quoted') {
        if (c === '"') { this.field += '"'; this.state = 'quoted'; continue; }
        // The quote closed the field; only a delimiter or a line end may follow.
        if (c !== this.delimiter && c !== '\n' && c !== '\r') {
          throw new CsvError(this.line, `unexpected ${JSON.stringify(c)} after a closing quote (a quote inside a quoted field is written "")`);
        }
        this.state = 'unquoted';
        // fall through: the delimiter or line end is handled below
      }

      if (c === this.delimiter) {
        this.fields.push(this.field);
        this.field = '';
        this.state = 'start';
        this.blank = false;
        continue;
      }
      if (c === '\n' || c === '\r') {
        if (c === '\r') this.pendingCr = true;
        this.endRecord(out);
        this.line++;
        continue;
      }
      if (c === '"') {
        if (this.state !== 'start') {
          throw new CsvError(this.line, 'a " inside an unquoted field (wrap the whole field in quotes and write the quote as "")');
        }
        this.state = 'quoted';
        this.blank = false;
        continue;
      }
      this.field += c;
      this.state = 'unquoted';
      this.blank = false;
    }
    return out;
  }

  /** The end of the input: the last record need not end in a line break. */
  end(): CsvRecord[] {
    const out: CsvRecord[] = [];
    if (this.state === 'quoted') {
      throw new CsvError(this.recordLine, 'the file ends inside a quoted field (an unpaired " in this record)');
    }
    if (this.state === 'quote-in-quoted') this.state = 'unquoted';
    this.endRecord(out);
    return out;
  }

  private endRecord(out: CsvRecord[]): void {
    if (!this.blank) {
      this.fields.push(this.field);
      out.push({ line: this.recordLine, fields: this.fields });
    }
    this.field = '';
    this.fields = [];
    this.state = 'start';
    this.blank = true;
    this.recordLine = this.line + 1;
  }
}
