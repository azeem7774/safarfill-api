// Checks for the portal recipes, phone rules and theme in a rules bundle (SafarFill v1.3.0+).
// COPIED from the SafarFill extension v1.3.0 (lib/recipes.js, lib/phone.js, lib/theme.js) so the
// server refuses exactly what the extension would ignore. Keep in step with the extension.
// The extension ignores a bad value and uses its built-in one; the server instead refuses to
// save / test / release a bundle with such a value, so a typo never reaches the agents.

export const DATE_FORMATS = ['DD/MM/YYYY', 'DD-MM-YYYY', 'DD.MM.YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY'];

const TITLES_AKBAR = { MR: ['Mr'], MRS: ['Mrs'], MS: ['Ms', 'Miss'], MISS: ['Miss', 'Ms'], MSTR: ['Mstr', 'Master', 'Mst', 'Mast'] };

export const BUILT_IN = {
  akbar: {
    recipe: 1,
    dateFormat: 'DD/MM/YYYY',
    rows: { selector: '[id^="paxEle"]', idPrefix: 'paxEle' },
    controls: {
      docType: 'DocumentType', title: 'Title', first: 'FName', last: 'LName', dob: 'DOB',
      nationality: 'NationalityName', passportNo: 'PassportNo', iqamaNo: 'IqamaID',
      iqamaExpiry: 'IQIDOE', issueDate: 'PDOI',
    },
    labels: {
      docType: ['Document Type'], title: ['Title'], first: ['First Name'], last: ['Last Name'],
      dob: ['Date of Birth'], nationality: ['Nationality'], passportNo: ['Passport Number'],
      expiry: ['Passport Expiry'], issuingCountry: ['Issuing Country', 'Country'],
      issueDate: ['Passport Issued', 'Passport Issue Date', 'Date of Issue', 'Issue Date'],
      iqamaNo: ['Iqama ID', 'Iqama ID Number'], iqamaExpiry: ['Iqama ID Expiry Date', 'Iqama ID Expiry'],
      nidNo: ['National ID', 'National ID Number'], nidExpiry: ['National ID Expiry Date', 'National ID Expiry'],
    },
    optionalToggle: '.optional-fields h5',
    docTypes: { passport: ['Passport'], iqama: ['Iqama ID', 'Iqama'], nid: ['National ID'] },
    titles: { adult: TITLES_AKBAR, child: TITLES_AKBAR },
    phone: {
      main: { input: '#phoneInput, [formcontrolname="Mobile"]' },
      second: { input: '#destinationPhoneInput, [formcontrolname="DestMob"]' },
      offers: 'page',
      keep0: false,
      overrides: {},
    },
  },
  alhind: {
    recipe: 1,
    dateFormat: 'DD-MM-YYYY',
    rows: { titleSelector: 'select[id^="ddl"][id*="Title_"]', titlePrefix: 'ddl', titleWord: 'Title_', kinds: { Adult: 'ADT', Child: 'CHD', Infant: 'INF' }, blockMarker: 'input[name="dob"]' },
    fields: {
      first: 'input[id*="FirstName"]', last: 'input[id*="LastName"]',
      docType: 'select[name="pdocument"], select[id*="documenttype"]',
      number: 'input[name="pnumber"], input[id*="PassportNo_"], input[id*="DocumentNumber"]',
      dob: 'input[name="dob"]', nationality: 'select[id*="Nationality"]',
      issuingCountry: 'select[id*="IssuedBy"], select[id*="CountryofIssue"]',
      expiry: 'input[id*="xpiry"]',
    },
    docTypes: {
      passport: { value: 'Passport', label: 'Passport' },
      iqama: { value: 'ResidencePermit', label: 'Saudi Residence Permit' },
      nid: { value: 'NationalId', label: 'Saudi National Id' },
    },
    titles: {
      adult: { MR: ['MR'], MRS: ['MRS'], MS: ['MS', 'MISS'], MISS: ['MS', 'MISS'], MSTR: ['MR'] },
      child: { MSTR: ['MSTR', 'MASTER'], MISS: ['MISS'], MR: ['MSTR', 'MASTER'], MS: ['MISS'], MRS: ['MISS'] },
    },
    countryAliases: {
      SYRIA: ['SYRIANARABREPUBLIC'], RUSSIA: ['RUSSIANFEDERATION'], SOUTHKOREA: ['REPUBLICOFKOREA', 'KOREAREPUBLICOF'],
      PALESTINE: ['PALESTINIANTERRITORY', 'PALESTINIANTERRITORYOCCUPIED', 'STATEOFPALESTINE'], IRAN: ['IRANISLAMICREPUBLICOF'],
      TANZANIA: ['TANZANIAUNITEDREPUBLICOF', 'UNITEDREPUBLICOFTANZANIA'], UNITEDSTATES: ['UNITEDSTATESOFAMERICA', 'USA'],
      CZECHREPUBLIC: ['CZECHIA'], TURKEY: ['TURKIYE'], LIBYA: ['LIBYANARABJAMAHIRIYA'], MYANMAR: ['BURMA'],
      BOSNIAANDHERZEGOVINA: ['BOSNIAHERZEGOVINA'],
    },
    email: '#txtEmail',
    phone: {
      main: { code: '#contactnumber', input: '#passengercontact' },
      second: { code: '#Extcontactnumber', input: 'input[name="Extcontactnumber"]' },
      offers: 'page',
      keep0: false,
      overrides: {},
    },
  },
  airsial: {
    recipe: 1,
    dateFormat: 'DD-MM-YYYY',
    form: '#myForm, form[name="myForm"]',
    rows: {
      ADT: { label: 'Adult', title: 'Adult_Title{n}', first: 'F_AdultName{n}', last: 'L_AdultName{n}', dob: 'AdultDob_{n}', cnic: 'Adult_Nic{n}', pass: 'Adult_Pass{n}', country: 'cntry_adult{n}', expiry: 'AdultpPortEx_{n}' },
      CHD: { label: 'Child', title: 'Child_Gender{n}', first: 'F_ChildName{n}', last: 'L_ChildName{n}', dob: 'ChildDob_{n}', pass: 'L_Child_Pass{n}', country: 'cntry_L_Child{n}', expiry: 'ChildpPortEx_{n}' },
      INF: { label: 'Infant', title: 'Infant_Gender{n}', first: 'F_InfantName{n}', last: 'L_InfantName{n}', dob: 'InfantDob_{n}', pass: 'F_Infant_Pass{n}', country: 'cntry_F_Infant{n}', expiry: 'InfantpPortEx_{n}' },
    },
    passportLength: 9,
    titles: {
      adult: { MR: ['MR'], MRS: ['MRS'], MS: ['MISS', 'MS'], MISS: ['MISS', 'MS'] },
      child: { MSTR: ['MSTR', 'MASTER'], MISS: ['MISS'], MR: ['MSTR'], MS: ['MISS'], MRS: ['MISS'] },
    },
    countryAliases: { UNITEDARABEMIRATES: ['UAE'], UNITEDSTATES: ['UNITEDSTATESOFAMERICA'], UNITEDKINGDOM: ['UNITEDKINGDOM', 'ENGLAND'] },
    email: 'txtemail',
    phone: {
      main: { code: 'orig_tel', input: 'adult_cell_no1' },
      second: { code: 'dest_tel', input: 'AdultPhone1' },
      offers: 'page',
      keep0: true,
      overrides: { 92: { keep0: true, dashAfter: 4 } },
    },
  },
  muqeem: {
    recipe: 1,
    visaRadioName: 'visaType',
    visaValues: { exitReentry: 'ER', visit: 'VISIT' },
    numberBox: 'input[name="firstFieldValue"]',
    checkUsing: 'input[type="radio"][name="firstFieldType"][value="iqamaNumber"]',
    matchList: 'p-dropdown[formcontrolname="secondFieldType"]',
    matchTexts: ['date of birth', 'تاريخ الميلاد'],
    dateBox: 'elm-date-picker input',
    checkTexts: ['check', 'تحقق'],
  },
};

// ---- value checks -----------------------------------------------------------------------

const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const CHECK = {
  // Parsed for real in the page (a failing selector falls back there); here only its characters.
  selector: (v) => isStr(v, 300) && !/[<{}]/.test(v),
  control: (v) => typeof v === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(v),
  id: (v) => typeof v === 'string' && /^[A-Za-z0-9_\-]{1,60}$/.test(v),
  idRow: (v) => typeof v === 'string' && /^[A-Za-z0-9_\-]{0,58}(\{n\})?[A-Za-z0-9_\-]{0,58}$/.test(v) && v.length > 0 && v.length <= 60,
  text: (v) => isStr(v, 60),
  labels: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 10 && v.every((x) => isStr(x, 60)),
  titleTexts: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 6 && v.every((x) => isStr(x, 30)),
  letters: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 10 && v.every((x) => typeof x === 'string' && /^[A-Z]{1,60}$/.test(x)),
  dateFormat: (v) => DATE_FORMATS.includes(v),
  kind: (v) => ['ADT', 'CHD', 'INF'].includes(v),
  int9: (v) => Number.isInteger(v) && v >= 1 && v <= 30,
  bool: (v) => v === true || v === false,
  offers: (v) => v === 'page' || (Array.isArray(v) && v.length >= 1 && v.length <= 300 && v.every((x) => typeof x === 'string' && /^\d{1,4}$/.test(x))),
  dashAfter: (v) => Number.isInteger(v) && v >= 1 && v <= 8,
  one: (v) => v === 1,
};

// The kind of value at a path (portal id first), or '' when the key is not known.
function kindAt(portal, path) {
  const [head, ...rest] = path;
  const last = path[path.length - 1];
  if (path.length === 1 && head === 'recipe') return 'one';
  if (head === 'dateFormat') return path.length === 1 ? 'dateFormat' : '';
  if (head === 'titles') return path.length === 3 && ['adult', 'child'].includes(rest[0]) && /^(MR|MRS|MS|MISS|MSTR)$/.test(rest[1]) ? 'titleTexts' : '';
  if (head === 'countryAliases') return path.length === 2 && /^[A-Z]{2,60}$/.test(rest[0]) ? 'letters' : '';
  if (head === 'phone') {
    if (path.length === 2 && rest[0] === 'offers') return 'offers';
    if (path.length === 2 && rest[0] === 'keep0') return 'bool';
    if (path.length === 3 && ['main', 'second'].includes(rest[0]) && ['input', 'code'].includes(rest[1])) return portal === 'airsial' ? 'id' : 'selector';
    if (path.length === 4 && rest[0] === 'overrides' && /^\d{1,4}$/.test(rest[1])) return rest[2] === 'keep0' ? 'bool' : rest[2] === 'dashAfter' ? 'dashAfter' : '';
    return '';
  }
  const known = BUILT_IN[portal];
  let node = known;
  for (const k of path) { if (node && typeof node === 'object' && !Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, k)) node = node[k]; else return ''; }
  if (node && typeof node === 'object' && !Array.isArray(node)) return 'map'; // a group of keys
  if (portal === 'akbar') {
    if (head === 'controls') return 'control';
    if (head === 'labels' || head === 'docTypes') return 'labels';
    if (head === 'rows' && last === 'idPrefix') return 'id';
    return 'selector';
  }
  if (portal === 'alhind') {
    if (head === 'rows' && (last === 'titlePrefix' || last === 'titleWord')) return 'id';
    if (head === 'rows' && rest[0] === 'kinds') return 'kind';
    if (head === 'docTypes') return last === 'label' ? 'text' : 'id';
    return 'selector';
  }
  if (portal === 'airsial') {
    if (head === 'rows') return last === 'label' ? 'text' : 'idRow';
    if (head === 'passportLength') return 'int9';
    if (head === 'email') return 'id';
    return 'selector';
  }
  if (portal === 'muqeem') {
    if (head === 'matchTexts' || head === 'checkTexts') return 'labels';
    if (head === 'visaRadioName' || head === 'visaValues') return 'id';
    return 'selector';
  }
  return '';
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);

// The recipe used for a portal: the built-in one with every valid value from the server's
// recipe put in. Returns { recipe, ignored }: ignored lists the server paths that were not used
// ("portals.akbar.controls.first").
export function recipeFor(portal, fromServer) {
  const recipe = clone(BUILT_IN[portal] || {});
  const ignored = [];
  if (!isMap(fromServer)) return { recipe, ignored };
  if (fromServer.recipe !== 1) return { recipe, ignored: [`portals.${portal}.recipe`] };
  const walk = (node, path) => {
    for (const [k, v] of Object.entries(node)) {
      const p = [...path, k];
      const kind = kindAt(portal, p);
      if (isMap(v) && (!kind || kind === 'map')) { walk(v, p); continue; }
      if (!kind || !CHECK[kind] || !CHECK[kind](v)) { /* server: a group given as one value is refused, not a crash */ ignored.push(`portals.${portal}.${p.join('.')}`); continue; }
      // put it in
      let at = recipe;
      for (const key of p.slice(0, -1)) { if (!isMap(at[key])) at[key] = {}; at = at[key]; }
      at[p[p.length - 1]] = Array.isArray(v) ? v.slice() : v;
    }
  };
  walk(fromServer, []);
  return { recipe, ignored };
}

export const BUILT_IN_PHONE = {
  phone: 1,
  acceptPlus: true,
  accept00: true,
  local: [
    { country: 'SA', dial: '966', starts: ['05'], length: 10, drop0: true },
    { country: 'SA', dial: '966', starts: ['5'], length: 9, drop0: false },
    { country: 'PK', dial: '92', starts: ['03'], length: 11, drop0: true },
    { country: 'PK', dial: '92', starts: ['3'], length: 10, drop0: false },
    { country: 'BD', dial: '880', starts: ['013', '014', '015', '016', '017', '018', '019'], length: 11, drop0: true },
    { country: 'EG', dial: '20', starts: ['010', '011', '012', '015'], length: 11, drop0: true },
    { country: 'PH', dial: '63', starts: ['09'], length: 11, drop0: true },
    { country: 'IN', dial: '91', starts: ['6', '7', '8', '9'], length: 10, drop0: false },
  ],
  notes: { unknown: 'phone_unknown', notOffered: 'phone_not_offered', unsure: 'phone_unsure' },
};

const okRule = (r) => r && typeof r === 'object'
  && typeof r.country === 'string' && /^[A-Z]{2}$/.test(r.country)
  && typeof r.dial === 'string' && /^\d{1,4}$/.test(r.dial)
  && Array.isArray(r.starts) && r.starts.length >= 1 && r.starts.length <= 10 && r.starts.every((x) => typeof x === 'string' && /^\d{1,5}$/.test(x))
  && Number.isInteger(r.length) && r.length >= 6 && r.length <= 15
  && (r.drop0 === true || r.drop0 === false);

// The phone rules in use. Returns { rules, ignored } (ignored: "phone.local.3" …).
export function phoneRules(fromServer) {
  const rules = JSON.parse(JSON.stringify(BUILT_IN_PHONE));
  const ignored = [];
  if (!fromServer || typeof fromServer !== 'object' || Array.isArray(fromServer)) return { rules, ignored };
  if (fromServer.phone !== 1) return { rules, ignored: ['phone.phone'] };
  for (const k of Object.keys(fromServer)) if (!['phone', 'acceptPlus', 'accept00', 'local', 'notes'].includes(k)) ignored.push(`phone.${k}`);
  for (const k of ['acceptPlus', 'accept00']) {
    if (!(k in fromServer)) continue;
    if (fromServer[k] === true || fromServer[k] === false) rules[k] = fromServer[k]; else ignored.push(`phone.${k}`);
  }
  if ('local' in fromServer) {
    if (Array.isArray(fromServer.local) && fromServer.local.length <= 60) {
      const good = [];
      fromServer.local.forEach((r, i) => (okRule(r) ? good.push({ country: r.country, dial: r.dial, starts: r.starts.slice(), length: r.length, drop0: r.drop0 }) : ignored.push(`phone.local.${i}`)));
      if (good.length) rules.local = good;
    } else ignored.push('phone.local');
  }
  if ('notes' in fromServer) {
    const n = fromServer.notes;
    if (n && typeof n === 'object' && !Array.isArray(n)) {
      for (const [k, v] of Object.entries(n)) {
        if (['unknown', 'notOffered', 'unsure'].includes(k) && typeof v === 'string' && /^[a-z0-9_]{1,40}$/.test(v)) rules.notes[k] = v;
        else ignored.push(`phone.notes.${k}`);
      }
    } else ignored.push('phone.notes');
  }
  return { rules, ignored };
}


export const BUILT_IN_THEME = {
  theme: 1,
  colors: {
    light: { brand: '#14537D', brandText: '#FFFFFF', bg: '#F6F7F9', card: '#FFFFFF', text: '#17202B', muted: '#5D6B7A', line: '#D8DEE6', good: '#1B7A43', warn: '#9A5B00', bad: '#B3261E' },
    dark: { brand: '#4DA3D9', brandText: '#0B1A24', bg: '#14181D', card: '#1D232B', text: '#E8EDF2', muted: '#9AA7B5', line: '#323B46', good: '#5FCE8C', warn: '#F2B84B', bad: '#FF8A80' },
  },
  textSize: 'normal',
  compact: false,
  show: { company: true, news: true, aiAll: true, manual: true, openWindow: true },
  labels: { fill: 'Fill form', clear: 'Clear all', refresh: 'Refresh', manual: '+ Add a passenger by hand', settings: 'Settings', title: 'SafarFill' },
  logo: '',
};

const COLOR_VARS = { brand: '--brand', brandText: '--brand-ink', bg: '--bg', card: '--card', text: '--ink', muted: '--muted', line: '--line', good: '--ok', warn: '--warn', bad: '--bad' };
const SIZES = ['small', 'normal', 'large'];
const LOGO_HOSTS = ['sahllabs.com', 'www.sahllabs.com', 'safarfill-api.azeemhfd.workers.dev'];
const isColor = (v) => typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v);

// The theme in use: the built-in one with every valid value from the server put in.
// Returns { theme, ignored } (ignored: "theme.colors.light.brand" …).
export function themeFor(fromServer) {
  const theme = JSON.parse(JSON.stringify(BUILT_IN_THEME));
  const ignored = [];
  const map = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!map(fromServer)) return { theme, ignored };
  if (fromServer.theme !== 1) return { theme, ignored: ['theme.theme'] };
  for (const [k, v] of Object.entries(fromServer)) {
    if (k === 'theme') continue;
    if (k === 'colors' && map(v)) {
      for (const [mode, set] of Object.entries(v)) {
        if (!['light', 'dark'].includes(mode) || !map(set)) { ignored.push(`theme.colors.${mode}`); continue; }
        for (const [c, val] of Object.entries(set)) {
          if (Object.prototype.hasOwnProperty.call(COLOR_VARS, c) && isColor(val)) theme.colors[mode][c] = val.toUpperCase(); else ignored.push(`theme.colors.${mode}.${c}`);
        }
      }
    } else if (k === 'textSize' && SIZES.includes(v)) theme.textSize = v;
    else if (k === 'compact' && (v === true || v === false)) theme.compact = v;
    else if ((k === 'show' || k === 'labels') && map(v)) {
      for (const [key, val] of Object.entries(v)) {
        const ok = Object.prototype.hasOwnProperty.call(BUILT_IN_THEME[k], key) && (k === 'show' ? val === true || val === false : typeof val === 'string' && val.trim().length > 0 && val.length <= 60);
        if (ok) theme[k][key] = k === 'labels' ? val.trim() : val; else ignored.push(`theme.${k}.${key}`);
      }
    } else if (k === 'logo' && typeof v === 'string' && (v === '' || logoUrl(v))) theme.logo = v ? logoUrl(v) : '';
    else ignored.push(`theme.${k}`);
  }
  return { theme, ignored };
}

function logoUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && LOGO_HOSTS.includes(x.hostname) && u.length <= 300 ? x.href : ''; } catch (e) { return ''; }
}


// Keys that must never appear anywhere in a bundle (they could change built-in objects).
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
export function badKeys(v, path = '', out = []) {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      const p = path ? `${path}.${k}` : k;
      if (BAD_KEYS.has(k)) out.push(p); else badKeys(v[k], p, out);
    }
  }
  return out;
}
