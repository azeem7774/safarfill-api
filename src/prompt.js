// Passport / iqama reading instructions for the AI. Kept on the server only.

export const TOOL = {
  name: 'record_passport',
  description: 'Record the fields read from a passport photo page or a Saudi iqama (resident identity) card.',
  input_schema: {
    type: 'object',
    properties: {
      document_type: { type: 'string', enum: ['passport', 'iqama', 'national_id', 'other'], description: 'passport = passport photo page. iqama = Saudi resident identity card (plastic card or the digital card from Absher). national_id = Saudi national identity card. other = anything else.' },
      is_passport: { type: 'boolean', description: 'True if the image shows a passport photo (data) page.' },
      full_name: { type: 'string', description: 'For an iqama or national ID: the name in Latin letters exactly as printed on its one line. Empty for a passport.' },
      id_number: { type: 'string', description: 'For an iqama or national ID: the 10-digit identity number, in Western digits. Empty for a passport.' },
      surname: { type: 'string' },
      given_names: { type: 'string' },
      passport_number: { type: 'string' },
      nationality_code: { type: 'string', description: 'Three-letter code as used in the machine-readable zone, e.g. PAK, IND, BGD, EGY.' },
      issuing_country_code: { type: 'string', description: 'Three-letter code of the issuing state.' },
      date_of_birth: { type: 'string', description: 'YYYY-MM-DD' },
      sex: { type: 'string', enum: ['M', 'F', ''] },
      date_of_expiry: { type: 'string', description: 'YYYY-MM-DD' },
      date_of_issue: { type: 'string', description: 'Passport only: the printed date of issue, YYYY-MM-DD. Empty for an iqama or national ID, or if not printed.' },
      personal_number: { type: 'string', description: 'National ID / citizenship number if printed (digits only), else empty.' },
      father_name: { type: 'string', description: 'Passport only: the father\'s name if the page prints one (for example under "Father Name"), in Latin capitals, words in the printed order, without commas. Else empty.' },
      mrz_line1: { type: 'string', description: 'First machine-readable line exactly as visible, using < for fillers. Only the visible part.' },
      mrz_line2: { type: 'string', description: 'Second machine-readable line exactly as visible. Only the visible part.' },
      unclear: { type: 'array', items: { type: 'string' }, description: 'Names of fields above that were hard to read or partly hidden.' },
    },
    required: ['document_type', 'is_passport', 'full_name', 'id_number', 'surname', 'given_names', 'passport_number', 'nationality_code', 'issuing_country_code', 'date_of_birth', 'sex', 'date_of_expiry', 'date_of_issue', 'personal_number', 'father_name', 'mrz_line1', 'mrz_line2', 'unclear'],
  },
};

export const PROMPT = `This is a customer's identity document, sent to a travel agency for a flight booking: either a passport photo page or a Saudi iqama (resident identity card). First decide which it is (document_type), then read it and record the fields with the record_passport tool.

Rules for a PASSPORT:

Rules:
- The photo may be tilted, sideways, upside down, dim, or partly cut off. Read what is actually visible.
- Copy characters exactly as printed. Never guess, complete, or correct a value. If a field cannot be read with confidence, return an empty string for it and list it in "unclear".
- Take values from the printed part of the page (the labelled fields) and from the two machine-readable lines at the bottom. When both show a value and they agree, use it. When they differ, use the one that is clearer and list the field in "unclear".
- Names: Latin letters only, in capitals, exactly as spelled on the page.
  - If the page prints the surname and the given names under separate labels (for example "Surname" and "Given names"), copy each from under its own label. This is the normal case, and the printed labels decide which words are the surname. Do not move words between the two because of the machine-readable line, which may be damaged or cut off in the photo.
  - Only if the page prints one combined full name with no separate surname label: spell the words as printed, and split them the way the first machine-readable line does (surname before <<, given names after).
  - Include every given name printed, in order. If a passport has no surname or no given names, leave that one empty.
- Dates as YYYY-MM-DD.
- date_of_issue: the printed "Date of issue" (it is not in the machine-readable lines). Do not confuse it with the date of birth or expiry. Leave it empty if it is not printed or cannot be read.
- mrz_line1 and mrz_line2: transcribe only what is visible, character by character, with < for filler characters. Do not pad a line or restore a part that is cut out of the photo.
- Set is_passport to true and leave full_name and id_number empty.

Rules for an IQAMA or Saudi NATIONAL ID (a card titled "هوية مقيم" / "Resident Identity", or the national identity card):
- Set is_passport to false. Leave surname, given_names, passport_number, mrz_line1 and mrz_line2 empty.
- full_name: the name in Latin letters exactly as printed, all words, in order, in capitals. If only an Arabic name is printed, leave it empty and list full_name in "unclear".
- id_number: the identity number (رقم الهوية / الرقم), ten digits. The card prints Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩): write them as Western digits 0-9, reading each digit carefully. Do not use the employer's number (هوية صاحب العمل) or the tracking number.
- date_of_birth (تاريخ الميلاد) and date_of_expiry (تاريخ الانتهاء): write as YYYY-MM-DD. The card prints them as either YYYY/MM/DD or DD/MM/YYYY; the four-digit group is the year. Keep the calendar as printed: if the year is a Hijri year (13xx or 14xx), write that year unchanged and do not convert it.
- If no expiry date is printed (older plastic cards print only an issue date, الإصدار), leave date_of_expiry empty. Never use the issue date as the expiry date.
- nationality_code: the three-letter country code for the printed nationality (الجنسية), for example باكستان = PAK, الهند = IND, بنغلاديش = BGD, الفلبين = PHL, مصر = EGY. Leave issuing_country_code empty.
- sex: leave empty unless the card prints it.

If the image is neither, set document_type to "other", is_passport to false, and leave the fields empty.

Answer only by calling the record_passport tool, once. Do not reply in plain text.`;
