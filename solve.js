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
// ---------------------------------------------------------------------------------------------
// The byte path: the same reading, taken over cases.json own bytes, with every answer JSON written
// as bytes. No JSON.parse, no JSON.stringify, and no string built for a field: a field is written as
// it is scanned, byte by byte, so nothing is read twice and nothing is thrown away but a CR out of
// quotes and a quote that never closes. JSON.stringify escapes a quote, a backslash and a line break,
// and escapes neither a comma nor U+FEFF, so the escapes the input already carries are the ones the
// answer needs: only a doubled quote (two quotes are one), a CR read as LF inside quotes, and the
// padding of a short row are written by hand. A character the input names in its u form (a lone
// surrogate, which this data has none of) is never a comma, a quote or a line break, and is copied.
// ---------------------------------------------------------------------------------------------

/** csv-reader 1.0.0 answers for the cases.json bytes, in the same order: the answers.json bytes. */
export function emitAnswers(buf) {
  const total = buf.length;
  // Room for the whole answer up front: a record copies its content byte for byte, at most one
  // written byte per read byte, and a padded field costs three. Every record still checks its own
  // worst case before it starts.
  let out = Buffer.allocUnsafe(total * 4 + 65536);
  let o = 0;
  let err = Buffer.allocUnsafe(1 << 14);
  let e = 0;
  let errCount = 0;

  let pos = 0; // the next byte of the current case text
  let line = 1; // the line that byte starts
  let recordLine = 1; // the line the record being read starts on
  let recordRow = -1; // its index in rows, or -1 for the header

  function reserve(n) {
    if (o + n <= out.length) return;
    let cap = out.length << 1;
    while (cap < o + n) cap <<= 1;
    const next = Buffer.allocUnsafe(cap);
    out.copy(next, 0, 0, o);
    out = next;
  }
  function reserveErr(n) {
    if (e + n <= err.length) return;
    let cap = err.length << 1;
    while (cap < e + n) cap <<= 1;
    const next = Buffer.allocUnsafe(cap);
    err.copy(next, 0, 0, e);
    err = next;
  }
  function puts(s) {
    reserve(s.length);
    o += out.write(s, o, "latin1");
  }
  function eput(b) {
    reserveErr(1);
    err[e++] = b;
  }
  function eputs(s) {
    reserveErr(s.length);
    e += err.write(s, e, "latin1");
  }
  function eputInt(n) {
    if (n === 0) {
      eput(0x30);
      return;
    }
    if (n < 0) {
      eput(0x2d);
      n = -n;
    }
    let digits = 0;
    for (let m = n; m >= 1; m = (m / 10) | 0) digits++;
    reserveErr(digits);
    for (let k = digits - 1; k >= 0; k--) {
      err[e + k] = 0x30 + (n % 10);
      n = (n / 10) | 0;
    }
    e += digits;
  }
  /** One error {code, line, row}, in the order met. */
  function addError(code) {
    if (errCount++ > 0) eput(0x2c);
    eputs(String.raw`{"code":"`);
    eputs(code);
    eputs(String.raw`","line":`);
    eputInt(recordLine);
    eputs(String.raw`,"row":`);
    if (recordRow < 0) eputs("null");
    else eputInt(recordRow);
    eputs("}");
  }

  /**
   * An unquoted field characters, written as they are read: returns 0 at a comma, 1 at a line break
   * and 2 at the end of the text. A prefix writes the literal quote of a quote that never closed.
   * The caller has made room for the record, so nothing here checks the output room.
   */
  function unquoted(prefix) {
    if (prefix) {
      out[o++] = 0x5c;
      out[o++] = 0x22;
    }
    for (;;) {
      if (pos >= total) return 2;
      const b = buf[pos];
      if (b === 0x2c) {
        pos++;
        return 0;
      }
      if (b === 0x22) return 2;
      if (b === 0x5c) {
        const c = buf[pos + 1];
        if (c === 0x6e) {
          pos += 2;
          line++;
          return 1;
        }
        if (c === 0x72) {
          if (buf[pos + 2] === 0x5c && buf[pos + 3] === 0x6e) {
            pos += 4;
            line++;
            return 1;
          }
          // a CR out of quotes, not followed by LF: dropped (stray_cr)
          pos += 2;
          addError("stray_cr");
          continue;
        }
        if (c === 0x75) {
          out[o++] = 0x5c;
          out[o++] = 0x75;
          out[o++] = buf[pos + 2];
          out[o++] = buf[pos + 3];
          out[o++] = buf[pos + 4];
          out[o++] = buf[pos + 5];
          pos += 6;
          continue;
        }
        out[o++] = 0x5c;
        out[o++] = c;
        pos += 2;
        continue;
      }
      out[o++] = b;
      pos++;
    }
  }

  /** A quoted field, its opening quote at pos: 0 at a comma, 1 at a line break, 2 at the end of the text. */
  function quotedField() {
    const open = pos;
    const openLine = line;
    const contentStart = o;
    pos += 2;
    let closed = false;
    for (;;) {
      if (pos >= total) break;
      const b = buf[pos];
      if (b === 0x22) break;
      if (b === 0x5c) {
        const c = buf[pos + 1];
        if (c === 0x22) {
          if (buf[pos + 2] === 0x5c && buf[pos + 3] === 0x22) {
            // two quotes inside quotes are one quote
            out[o++] = 0x5c;
            out[o++] = 0x22;
            pos += 4;
            continue;
          }
          pos += 2;
          closed = true;
          break;
        }
        if (c === 0x72) {
          // CRLF and a lone CR inside quotes are each one LF
          out[o++] = 0x5c;
          out[o++] = 0x6e;
          line++;
          pos += buf[pos + 2] === 0x5c && buf[pos + 3] === 0x6e ? 4 : 2;
          continue;
        }
        if (c === 0x6e) {
          out[o++] = 0x5c;
          out[o++] = 0x6e;
          line++;
          pos += 2;
          continue;
        }
        if (c === 0x75) {
          out[o++] = 0x5c;
          out[o++] = 0x75;
          out[o++] = buf[pos + 2];
          out[o++] = buf[pos + 3];
          out[o++] = buf[pos + 4];
          out[o++] = buf[pos + 5];
          pos += 6;
          continue;
        }
        out[o++] = 0x5c;
        out[o++] = c;
        pos += 2;
        continue;
      }
      out[o++] = b;
      pos++;
    }
    if (!closed) {
      // the quote never closes: a literal character, and the text after it read again as unquoted
      pos = open + 2;
      line = openLine;
      o = contentStart;
      addError("unterminated_quote");
      return unquoted(1);
    }
    if (pos >= total) return 2;
    const b = buf[pos];
    if (b === 0x22) return 2;
    if (b === 0x2c) {
      pos++;
      return 0;
    }
    if (b === 0x5c) {
      const c = buf[pos + 1];
      if (c === 0x6e) {
        pos += 2;
        line++;
        return 1;
      }
      if (c === 0x72 && buf[pos + 2] === 0x5c && buf[pos + 3] === 0x6e) {
        pos += 4;
        line++;
        return 1;
      }
    }
    // what follows the closing quote is appended as it stands (quote_junk, when the field ends)
    const junkFrom = o;
    const ended = unquoted(0);
    if (o > junkFrom) addError("quote_junk");
    return ended;
  }

  /** One case answer, {columns, rows, errors}, written from the text at ts; returns where the text ended. */
  function emitCase(ts, header) {
    pos = ts;
    line = 1;
    recordLine = 1;
    recordRow = -1;
    e = 0;
    errCount = 0;
    if (buf[pos] === 0xef && buf[pos + 1] === 0xbb && buf[pos + 2] === 0xbf) pos += 3;

    let width = -1;
    let columnsDone = false;
    let rowsWritten = 0;

    puts(String.raw`{"columns":`);
    if (!header) puts(String.raw`null,"rows":[`);
    for (;;) {
      // a line with no characters is no record
      for (;;) {
        if (pos >= total) break;
        if (buf[pos] !== 0x5c) break;
        const c = buf[pos + 1];
        if (c === 0x6e) {
          pos += 2;
          line++;
          continue;
        }
        if (c === 0x72 && buf[pos + 2] === 0x5c && buf[pos + 3] === 0x6e) {
          pos += 4;
          line++;
          continue;
        }
        break;
      }
      if (pos >= total || buf[pos] === 0x22) break;

      recordLine = line;
      recordRow = header && !columnsDone ? -1 : rowsWritten;

      // Room for this record worst case: every byte left of the text copies itself, and a field
      // framed or padded costs eight more.
      reserve(total - pos + (width < 0 ? 32 : width + 4) * 8 + 64);

      const rowStart = o;
      if (rowsWritten > 0) out[o++] = 0x2c;
      out[o++] = 0x5b;

      let count = 0;
      let quotedLast = false;
      let firstFrom = o;
      let atWidth = -1;
      for (;;) {
        quotedLast = buf[pos] === 0x5c && buf[pos + 1] === 0x22;
        if (count === 0) firstFrom = o;
        if (count > 0) out[o++] = 0x2c;
        if (count === width) atWidth = o;
        out[o++] = 0x22;
        const ended = quotedLast ? quotedField() : unquoted(0);
        out[o++] = 0x22;
        count++;
        if (ended !== 0) break;
      }

      // a line that held only stray CRs is left with no characters: no record (its errors stay)
      if (count === 1 && !quotedLast && o - firstFrom === 2) {
        o = rowStart;
        continue;
      }
      if (width < 0) width = count;
      if (header && !columnsDone) {
        columnsDone = true;
        out[o++] = 0x5d;
        puts(String.raw`,"rows":[`);
        continue;
      }
      if (count < width) {
        if (errCount++ > 0) eput(0x2c);
        eputs(String.raw`{"code":"short_row","line":`);
        eputInt(recordLine);
        eputs(String.raw`,"row":`);
        eputInt(recordRow);
        eputs(String.raw`,"fields":`);
        eputInt(count);
        eputs("}");
        for (let k = count; k < width; k++) {
          out[o++] = 0x2c;
          out[o++] = 0x22;
          out[o++] = 0x22;
        }
      } else if (count > width) {
        const extraFrom = atWidth;
        const extraTo = o;
        if (errCount++ > 0) eput(0x2c);
        eputs(String.raw`{"code":"long_row","line":`);
        eputInt(recordLine);
        eputs(String.raw`,"row":`);
        eputInt(recordRow);
        eputs(String.raw`,"extra":[`);
        reserveErr(extraTo - extraFrom);
        out.copy(err, e, extraFrom, extraTo);
        e += extraTo - extraFrom;
        eputs("]}");
        o = extraFrom - 1;
      }
      out[o++] = 0x5d;
      rowsWritten++;
    }
    if (header && !columnsDone) puts(String.raw`[],"rows":[`);
    puts(String.raw`],"errors":[`);
    if (e > 0) {
      reserve(e);
      err.copy(out, o, 0, e);
      o += e;
    }
    puts("]}");
    return pos;
  }

  out[o++] = 0x5b;
  let at = buf.indexOf(String.raw`"text":"`);
  let first = true;
  while (at >= 0) {
    const ts = at + 8;
    const h = buf.indexOf(String.raw`"header":`, ts);
    if (h < 0) break;
    const header = buf[h + 9] === 0x74;
    if (!first) out[o++] = 0x2c;
    first = false;
    const end = emitCase(ts, header);
    at = buf.indexOf(String.raw`"text":"`, end + 1);
  }
  out[o++] = 0x5d;
  return out.subarray(0, o);
}
