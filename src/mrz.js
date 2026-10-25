// Passport MRZ (two lines of 44 characters) parser with check-digit validation.
// Built for imperfect input: junk before the line, a stray or missing character, or a line
// cut off by the edge of the photo. Whatever can be read is returned, and every field that
// could not be confirmed is listed in `doubt`.
// Pure functions, no browser APIs, so the same file runs in tests.

const WEIGHTS = [7, 3, 1];

function charValue(c) {
  if (c === '<') return 0;
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 55;
  return -1;
}

export function checkDigit(s) {
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    const v = charValue(s[i]);
    if (v < 0) return -1;
    sum += v * WEIGHTS[i % 3];
  }
  return sum % 10;
}

// Characters OCR commonly confuses. Used to repair a position that must be a digit or a letter.
const TO_DIGIT = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', G: '6', B: '8', T: '7' };
const TO_LETTER = { '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '6': 'G', '8': 'B' };
const fixDigits = (s) => s.replace(/[A-Z]/g, (c) => TO_DIGIT[c] || c);
const fixLetters = (s) => s.replace(/[0-9]/g, (c) => TO_LETTER[c] || c);

function cleanLine(raw) {
  return (raw || '')
    .toUpperCase()
    .replace(/[«‹＜]/g, '<')
    .replace(/[^A-Z0-9<]/g, '');
}

function parseDate(yymmdd, kind, today) {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = +yymmdd.slice(0, 2);
  const mm = +yymmdd.slice(2, 4);
  const dd = +yymmdd.slice(4, 6);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const nowYY = today.getFullYear() % 100;
  let year;
  if (kind === 'birth') year = yy > nowYY ? 1900 + yy : 2000 + yy; // birth dates are in the past
  else year = 2000 + yy; // expiry dates are in this century
  const iso = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const d = new Date(iso + 'T00:00:00Z');
  if (d.getUTCMonth() + 1 !== mm || d.getUTCDate() !== dd) return null;
  return iso;
}

// If the passport number's check digit fails, try swapping look-alike characters until
// exactly one variant passes. Passport numbers are letters first, then digits, so only swaps
// in that direction are tried (a digit among the first two characters may become a letter;
// a letter later on may become a digit).
function repairWithCheck(field, check) {
  if (checkDigit(field) === +check) return field;
  const candidates = new Set();
  for (let i = 0; i < field.length; i++) {
    const alt = i < 2 ? TO_LETTER[field[i]] : TO_DIGIT[field[i]];
    if (!alt) continue;
    const v = field.slice(0, i) + alt + field.slice(i + 1);
    if (checkDigit(v) === +check) candidates.add(v);
  }
  return candidates.size === 1 ? [...candidates][0] : field;
}

// ---- line 2 -------------------------------------------------------------
// Layout: number(9) check nationality(3) birth(6) check sex expiry(6) check personal(14) check final
// The line is slid along the text to find where these fields sit, scoring by passing checks.

function readAt(S, s, today) {
  const at = (i) => (s + i >= 0 && s + i < S.length ? S[s + i] : '?');
  const span = (a, b) => { let o = ''; for (let i = a; i < b; i++) o += at(i); return o; };
  let number = span(0, 9);
  const numberCheck = fixDigits(at(9));
  const dobRaw = fixDigits(span(13, 19));
  const dobCheck = fixDigits(at(19));
  let sex = at(20);
  if (sex === 'H') sex = 'M';
  const expRaw = fixDigits(span(21, 27));
  const expCheck = fixDigits(at(27));
  const nat = fixLetters(span(10, 13));

  const numberWhole = !number.includes('?');
  const numberRead = number;
  if (numberWhole) number = repairWithCheck(number, numberCheck);
  const repaired = number !== numberRead;
  const numOk = numberWhole && /\d/.test(numberCheck) && checkDigit(number) === +numberCheck;
  const dob = parseDate(dobRaw, 'birth', today);
  const expiry = parseDate(expRaw, 'expiry', today);
  const dobOk = !!dob && /\d/.test(dobCheck) && checkDigit(dobRaw) === +dobCheck;
  const expOk = !!expiry && /\d/.test(expCheck) && checkDigit(expRaw) === +expCheck;
  const checks = (numOk ? 1 : 0) + (dobOk ? 1 : 0) + (expOk ? 1 : 0);
  // The fixed shape of the line (three letters, then M or F between two dates) decides where
  // the fields sit; check digits then confirm the values. Counting checks alone is not safe:
  // three can pass by chance at a wrong position.
  const sexOk = sex === 'M' || sex === 'F';
  const natOk = /^[A-Z]{3}$/.test(span(10, 13));
  const score = (sexOk ? 2 : 0) + (natOk ? 1.5 : 0) + checks + (dob ? 0.3 : 0) + (expiry ? 0.3 : 0);
  const good = checks === 3 && sexOk && natOk;
  return { s, S, score, checks, good, repaired, numOk, dobOk, expOk, number, numberCheck, numberWhole, nat, dob, dobRaw, dobCheck, sex, expiry, expRaw, expCheck };
}

// The rest of the line after the expiry check: personal number, its check, and the overall check.
function tail(a) {
  const rest = a.S.slice(a.s + 28);
  const personal = rest.slice(0, 14);
  const personalCheck = fixDigits(rest[14] || '');
  const finalCheck = fixDigits(rest[15] || '');
  const whole = a.s >= 0 && rest.length >= 16;
  const personalEmpty = /^<*$/.test(personal);
  const personalOk = personal.length === 14 && personalCheck !== '' &&
    (personalEmpty ? personalCheck === '<' || personalCheck === '0' : checkDigit(personal) === +personalCheck);
  const overall = whole && /\d/.test(finalCheck) &&
    checkDigit(a.number + a.numberCheck + a.dobRaw + a.dobCheck + a.expRaw + a.expCheck + personal + personalCheck) === +finalCheck;
  return { personal, personalOk, overall, whole };
}

function alignLine2(S, today) {
  let best = null;
  const scan = (str) => {
    for (let s = -2; s + 28 <= str.length; s++) {
      const r = readAt(str, s, today);
      if (!best || r.score > best.score + 1e-9) best = r;
    }
  };
  if (S.length >= 26) scan(S);
  // A stray character inside the line: try removing each one. A removal is accepted only when
  // every check on the line then passes, including the personal-number and overall checks,
  // because one check alone passes by chance one time in ten.
  if (best && !best.good && S.length >= 44 && S.length <= 60) {
    let fixed = null;
    for (let i = 0; i < S.length && !fixed; i++) {
      const str = S.slice(0, i) + S.slice(i + 1);
      for (let s = 0; s + 44 <= str.length; s++) {
        const r = readAt(str, s, today);
        if (r.good && tail(r).overall && tail(r).personalOk) { fixed = r; break; }
      }
    }
    if (fixed) best = fixed;
  }
  return best;
}

// How strongly a piece of text looks like MRZ line 2 (0 to 7.1; 3.5 or more is a real candidate).
export function line2Score(raw, today = new Date()) {
  const a = alignLine2(cleanLine(raw), today);
  if (!a) return 0;
  return a.checks >= 1 ? a.score : a.score * 0.5; // right shape but nothing confirmed: not a candidate
}

// ---- line 1 -------------------------------------------------------------

// Trailing filler '<' is often misread as K, C, L, E or S. Drop name parts that look like that.
function cleanNamePart(part) {
  const words = part.split('<').filter(Boolean);
  while (words.length > 1) {
    const w = words[words.length - 1];
    if (/^[KCLES]+$/.test(w) && (w.length === 1 || /^(.)\1+$/.test(w) || w.length >= 4)) words.pop();
    else break;
  }
  return words.map(fixLetters).join(' ');
}

function parseLine1(raw, natCode) {
  const l1 = cleanLine(raw);
  if (l1.length < 8) return { surname: '', given: '', issuing: '', anchored: false, found: false };
  let start = -1;
  let issuing = '';
  // Normal start: P, a filler, then the three-letter country code.
  const m = /P[<A-Z]([A-Z0-9]{3})/.exec(l1.slice(0, 10));
  if (m && l1[m.index + 1] === '<') {
    start = m.index + 5;
    issuing = fixLetters(m[1]);
  } else if (natCode) {
    // Start misread or cut: look for the country code near the beginning (one letter may differ).
    for (let i = 0; i <= Math.min(6, l1.length - 3) && start < 0; i++) {
      let same = 0;
      for (let k = 0; k < 3; k++) if (fixLetters(l1[i + k]) === natCode[k]) same++;
      if (same === 3 || (same === 2 && i >= 1 && i <= 3)) {
        start = i + 3;
        issuing = natCode;
      }
    }
  }
  const anchored = start >= 0;
  let zone = anchored ? l1.slice(start) : l1;
  // Start unreadable: a short scrap before the first single filler is the damaged "P<XXX".
  if (!anchored) {
    const f = zone.indexOf('<');
    if (f > 0 && f <= 4 && zone[f + 1] !== '<' && zone.indexOf('<<') > f) zone = zone.slice(f + 1);
  }
  const sep = zone.indexOf('<<');
  let surname = '';
  let given = '';
  let givenUnsure = false;
  if (sep === -1) surname = cleanNamePart(zone);
  else {
    surname = cleanNamePart(zone.slice(0, sep));
    // Given names are separated by single fillers and followed only by fillers to the end of
    // the line. Anything after a double filler is therefore not a name: it is filler marks
    // misread as letters.
    let rest = zone.slice(sep + 2).replace(/^<+/, '');
    const end = rest.indexOf('<<');
    if (end >= 0) {
      const dropped = rest.slice(end).replace(/</g, '');
      const run = /^<+/.exec(rest.slice(end))[0].length;
      // A long scrap, or one sitting right after the names, might be a real name: raise a doubt.
      if (dropped.length >= 3 || (dropped.length && run < 3)) givenUnsure = true;
      rest = rest.slice(0, end);
    }
    given = cleanNamePart(rest);
    // A very short last word made of letters that fillers are often misread as.
    const last = given.split(' ').pop();
    if (given.includes(' ') && last.length <= 2 && /^[KCLESXO]+$/.test(last)) givenUnsure = true;
  }
  return { surname, given, issuing, anchored, found: true, exact: !!(m && l1[m.index + 1] === '<'), givenUnsure };
}

// ---- whole MRZ ----------------------------------------------------------

// Usual form of passport numbers for the countries handled most. Used only to raise a doubt.
const NUMBER_SHAPE = {
  PAK: /^[A-Z]{2}\d{7}$/,
  IND: /^[A-Z]\d{7}$/,
  BGD: /^[A-Z]{1,2}\d{7,8}$/,
  EGY: /^[A-Z]\d{8}$/,
};

export function parseMrz(rawLine1, rawLine2, today = new Date()) {
  const a = alignLine2(cleanLine(rawLine2), today);
  // Not shaped like an MRZ second line at all.
  if (!a || a.score < 3.5 || a.checks < 1) {
    return { valid: false, passed: 0, score: 0, checks: {}, problems: ['The second line could not be read'], fields: {}, doubt: {}, lines: [cleanLine(rawLine1), cleanLine(rawLine2)] };
  }
  const problems = [];
  const doubt = {};
  const { personal, personalOk, overall } = tail(a);

  if (!a.numberWhole) { doubt.passportNo = true; problems.push('The start of the second line is cut off, so the passport number is incomplete'); }
  else if (!a.numOk) { doubt.passportNo = true; problems.push('Passport number did not pass its check'); }
  else if (a.repaired && !overall) { doubt.passportNo = true; problems.push('One character of the passport number was unclear and was corrected by its check digit'); }
  if (!a.dobOk) { doubt.dob = true; problems.push('Date of birth did not pass its check'); }
  if (!a.expOk) { doubt.expiry = true; problems.push('Expiry date did not pass its check'); }
  if (a.sex !== 'M' && a.sex !== 'F') doubt.sex = true;
  if (!/^[A-Z]{3}$/.test(a.nat)) doubt.nationality = true;

  const natCode = /^[A-Z]{3}$/.test(a.nat) ? a.nat : '';
  const n = parseLine1(rawLine1, natCode);
  if (!n.found) { doubt.firstName = doubt.lastName = doubt.issuingCountry = true; problems.push('The first line (names) could not be read'); }
  else if (!n.exact) { doubt.firstName = doubt.lastName = true; problems.push('The start of the first line is unclear, so check the names'); }
  if (n.found && n.givenUnsure) { doubt.firstName = true; problems.push('The end of the name line is unclear, so check the given names'); }

  // Pakistani passports carry the 13-digit CNIC in the personal number field.
  const personalDigits = fixDigits(personal.replace(/</g, ''));
  let cnic = '';
  if (/^\d{13}$/.test(personalDigits)) {
    cnic = personalDigits;
    if (!personalOk) doubt.cnic = true;
  }
  // One check digit passes by chance one time in ten, so two more tests guard the number:
  // the overall check (when the whole line is visible) and the usual shape of the number
  // for that country.
  const { whole } = tail(a);
  const shapeOf = NUMBER_SHAPE[n.issuing || natCode];
  const numberText = a.number.replace(/[<?]/g, '');
  if (!doubt.passportNo && whole && !overall) { doubt.passportNo = true; problems.push('The overall check on the second line did not pass, so check the passport number'); }
  if (!doubt.passportNo && shapeOf && !shapeOf.test(numberText)) { doubt.passportNo = true; problems.push('The passport number does not have the usual form for this country'); }
  const checksPass = a.numOk && a.dobOk && a.expOk && !doubt.passportNo;
  return {
    valid: checksPass && n.found && n.exact && !n.givenUnsure,
    passed: a.checks,
    score: a.score + (n.exact ? 0.5 : 0) + (overall ? 0.5 : 0),
    checks: { passportNumber: a.numOk, dateOfBirth: a.dobOk, expiry: a.expOk, overall },
    problems,
    doubt,
    lines: [cleanLine(rawLine1), a.S],
    fields: {
      surname: n.surname,
      givenNames: n.given,
      passportNo: a.number.replace(/[<?]/g, ''),
      nationalityCode: natCode,
      issuingCode: n.issuing || natCode,
      dob: a.dob || '',
      sex: a.sex === 'M' || a.sex === 'F' ? a.sex : '',
      expiry: a.expiry || '',
      cnic,
    },
  };
}

// Pick the MRZ pair out of a list of text lines (OCR output, top to bottom).
// Returns { i1, i2 } (indexes; i1 is -1 when no first line was found) or null.
export function pickMrzLines(texts, today = new Date()) {
  let i2 = -1;
  let best = 3.49; // shaped like a second line
  for (let i = 0; i < texts.length; i++) {
    const sc = line2Score(texts[i], today);
    if (sc > best) { best = sc; i2 = i; }
  }
  if (i2 < 0) return null;
  let i1 = -1;
  for (let i = i2 - 1; i >= Math.max(0, i2 - 2); i--) {
    const c = cleanLine(texts[i]);
    if (c.length >= 20 && c.includes('<')) { i1 = i; break; }
  }
  return { i1, i2, score: best };
}

// Find the two MRZ lines inside free OCR text. Returns [line1, line2] or null.
export function findMrzLines(text, today = new Date()) {
  const lines = text.split(/\r?\n/);
  const p = pickMrzLines(lines, today);
  return p ? [p.i1 >= 0 ? lines[p.i1] : '', lines[p.i2]] : null;
}

// Age in whole years on a given date.
export function ageOn(dobIso, onDate) {
  const [y, m, d] = dobIso.split('-').map(Number);
  let age = onDate.getFullYear() - y;
  const before = onDate.getMonth() + 1 < m || (onDate.getMonth() + 1 === m && onDate.getDate() < d);
  if (before) age--;
  return age;
}

export function paxType(dobIso, onDate) {
  const age = ageOn(dobIso, onDate);
  if (age < 2) return 'INF';
  if (age < 12) return 'CHD';
  return 'ADT';
}

// Title that can be known from the passport. Adult women are left blank on purpose:
// the passport does not show marital status, so staff choose Mrs or Ms.
export function suggestTitle(sex, type) {
  if (sex === 'M') return type === 'ADT' ? 'MR' : 'MSTR';
  if (sex === 'F') return type === 'ADT' ? '' : 'MISS';
  return '';
}
