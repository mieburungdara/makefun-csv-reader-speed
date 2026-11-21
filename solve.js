// A faster drop-in for csv-reader 1.0.0: run(input) returns its answer {columns, rows, errors} for {text, header},
// byte for byte the same value, by the same policy read in one left-to-right pass. The reference builds every field a
// character at a time; this one keeps a field's characters in place and slices them out once the field ends, and only
// assembles pieces for the two cases that change the text: a doubled quote inside a quoted field and a CR read as LF.
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

/** How a field ended: at a comma (the record goes on), at a line break or at the end of the text (the record ends). */
const COMMA = 1;
const LINE_BREAK = 2;
const END = 3;

/** The reading of one CSV input, {text, header}: {columns, rows, errors} (the header). */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  const len = text.length;
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field read last.
  let field = '';

  /** The field holding the text[a..b) after every dropped CR in `cuts` is left out, prefixed with `prefix`. */
  function join(prefix, a, b, cuts) {
    if (cuts === null) return prefix.length === 0 ? text.slice(a, b) : prefix + text.slice(a, b);
    let s = prefix;
    let prev = a;
    for (let i = 0; i < cuts.length; i++) {
      const cut = cuts[i];
      if (cut > prev) s += text.slice(prev, cut);
      prev = cut + 1;
    }
    if (b > prev) s += text.slice(prev, b);
    return s;
  }

  // Reads unquoted characters onto `field`, from `prefix`: a CR not followed by LF is dropped (stray_cr).
  function readUnquoted(prefix) {
    const a = pos;
    let cuts = null;
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        field = cuts === null ? (prefix.length === 0 ? text.slice(a, pos) : prefix + text.slice(a, pos)) : join(prefix, a, pos, cuts);
        pos += 1;
        return COMMA;
      }
      if (c === 10) {
        field = cuts === null ? (prefix.length === 0 ? text.slice(a, pos) : prefix + text.slice(a, pos)) : join(prefix, a, pos, cuts);
        pos += 1;
        line += 1;
        return LINE_BREAK;
      }
      if (c === 13) {
        if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
          field = cuts === null ? (prefix.length === 0 ? text.slice(a, pos) : prefix + text.slice(a, pos)) : join(prefix, a, pos, cuts);
          pos += 2;
          line += 1;
          return LINE_BREAK;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (cuts === null) cuts = [];
        cuts.push(pos);
        pos += 1;
        continue;
      }
      pos += 1;
    }
    field = cuts === null ? (prefix.length === 0 ? text.slice(a, pos) : prefix + text.slice(a, pos)) : join(prefix, a, pos, cuts);
    return END;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let pieces = null;
    let a = pos + 1;
    pos += 1;
    let closed = false;
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 34) {
        if (pos + 1 < len && text.charCodeAt(pos + 1) === 34) {
          if (pieces === null) pieces = [];
          pieces.push(text.slice(a, pos), '"');
          pos += 2;
          a = pos;
          continue;
        }
        if (pieces === null) pieces = [text.slice(open + 1, pos)];
        else pieces.push(text.slice(a, pos));
        pos += 1;
        closed = true;
        break;
      }
      if (c === 13) {
        // CRLF and a lone CR inside quotes are each one LF.
        if (pieces === null) pieces = [];
        pieces.push(text.slice(a, pos), '\n');
        line += 1;
        pos += pos + 1 < len && text.charCodeAt(pos + 1) === 10 ? 2 : 1;
        a = pos;
        continue;
      }
      if (c === 10) line += 1;
      pos += 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    field = pieces === null ? text.slice(open + 1, pos - 1) : pieces.join('');
    if (pos >= len) return END;
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return COMMA;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return LINE_BREAK;
    }
    if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return LINE_BREAK;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    const quoted = field;
    const ended = readUnquoted(quoted);
    if (field.length > quoted.length) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return ended;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    let ended;
    do {
      quoted = text.charCodeAt(pos) === 34;
      ended = quoted ? readQuoted() : readUnquoted('');
      fields.push(field);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
