/**
 * Date Helper Utility
 */

/**
 * Robust date parser supporting:
 * - Date objects
 * - Excel date serial numbers (integers e.g. 46115, float timestamps)
 * - UNIX timestamps (in ms or seconds)
 * - Date strings: YYYY-MM-DD, DD-MM-YYYY, MM-DD-YYYY, M/D/YY, D/M/YY
 * - ISO strings, text date formats
 * - Nepali BS dates if applicable
 */
function parseAnyDate(val) {
  if (val === undefined || val === null || val === '') return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;

  // 1. Numeric Excel Serial (e.g. 46115, '46115')
  const num = Number(val);
  if (!isNaN(num) && num > 1000 && num < 100000) {
    // Excel serial to JS date: 25569 is days between 1900-01-01 and 1970-01-01
    const utcDays = num - 25569;
    const utcValue = utcDays * 86400;
    const dateInfo = new Date(utcValue * 1000);
    const fractionalDay = num - Math.floor(num) + 0.0000001;
    const totalSeconds = Math.floor(86400 * fractionalDay);
    const seconds = totalSeconds % 60;
    const hours = Math.floor(totalSeconds / (60 * 60));
    const minutes = Math.floor(totalSeconds / 60) % 60;
    return new Date(Date.UTC(dateInfo.getUTCFullYear(), dateInfo.getUTCMonth(), dateInfo.getUTCDate(), hours, minutes, seconds));
  }

  if (!isNaN(num) && num >= 1000000000000) { // millisecond timestamp
    const d = new Date(num);
    return isNaN(d.getTime()) ? null : d;
  }
  if (!isNaN(num) && num >= 1000000000 && num < 1000000000000) { // second timestamp
    const d = new Date(num * 1000);
    return isNaN(d.getTime()) ? null : d;
  }

  let s = String(val).trim();
  if (!s) return null;

  // Clean ordinal suffixes: "15th Jul 2030" -> "15 Jul 2030", "3rd Dec 2013" -> "3 Dec 2013"
  s = s.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');

  // 2. Custom Regex Matching for D/M/Y, M/D/Y, Y/M/D with 2 or 4 digit years
  const match = s.match(/^(\d{1,4})[-/.\s](\d{1,2})[-/.\s](\d{1,4})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (match) {
    let [, p1, p2, p3, hh, mm, ss] = match;
    let v1 = parseInt(p1, 10);
    let v2 = parseInt(p2, 10);
    let v3 = parseInt(p3, 10);
    let hour = hh ? parseInt(hh, 10) : 0;
    let minute = mm ? parseInt(mm, 10) : 0;
    let second = ss ? parseInt(ss, 10) : 0;

    let year, month, day;

    if (v1 > 1000) {
      // YYYY-MM-DD
      year = v1;
      month = v2 - 1;
      day = v3;
    } else if (v3 > 1000 || (p3.length === 2 || v3 < 100)) {
      year = v3 < 100 ? (v3 < 50 ? 2000 + v3 : 1900 + v3) : v3;
      if (v1 > 12 && v2 <= 12) {
        // DD/MM/YYYY
        day = v1;
        month = v2 - 1;
      } else if (v2 > 12 && v1 <= 12) {
        // MM/DD/YYYY
        month = v1 - 1;
        day = v2;
      } else {
        // Default to MM/DD/YYYY (standard US / Excel export)
        month = v1 - 1;
        day = v2;
      }
    } else {
      year = v3;
      month = v1 - 1;
      day = v2;
    }

    const res = new Date(Date.UTC(year, month, day, hour, minute, second));
    if (!isNaN(res.getTime())) return res;
  }

  // 3. Fallback standard Date
  const standardDate = new Date(s);
  if (!isNaN(standardDate.getTime())) {
    if (standardDate.getFullYear() < 1970 && standardDate.getFullYear() >= 1900) {
      standardDate.setFullYear(standardDate.getFullYear() + 100);
    }
    return standardDate;
  }

  return null;
}

function setNepalMidnight(dateInput) {
  const parsed = parseAnyDate(dateInput);
  const d = parsed || (dateInput instanceof Date ? new Date(dateInput) : new Date(dateInput || Date.now()));
  if (isNaN(d.getTime())) return d;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kathmandu',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(d);
  const getVal = type => parts.find(p => p.type === type)?.value;
  return new Date(`${getVal('year')}-${getVal('month')}-${getVal('day')}T00:00:00+05:45`);
}

/**
 * Compute expiry date from a base date + duration string.
 */
function computeExpiryFromBase(baseDateOrDuration, maybeDuration) {
  let baseDate;
  let durationString;

  const isProbablyDate = (v) => {
    if (v instanceof Date) return true;
    if (typeof v === 'number') return true;
    if (typeof v === 'string') {
      return /^\d{4}-\d{2}-\d{2}/.test(v);
    }
    return false;
  };

  if (baseDateOrDuration === undefined || baseDateOrDuration === null) {
    baseDate = new Date();
    durationString = maybeDuration;
  } else if (isProbablyDate(baseDateOrDuration) && maybeDuration !== undefined) {
    baseDate = new Date(baseDateOrDuration);
    durationString = maybeDuration;
  } else if (isProbablyDate(baseDateOrDuration) && maybeDuration === undefined) {
    baseDate = new Date(baseDateOrDuration);
    durationString = undefined;
  } else {
    baseDate = new Date();
    durationString = String(baseDateOrDuration);
  }

  if (!(baseDate instanceof Date) || isNaN(baseDate.getTime())) {
    baseDate = new Date();
  }

  const date = new Date(baseDate);

  if (!durationString && durationString !== 0) {
    date.setMonth(date.getMonth() + 1);
    return setNepalMidnight(date);
  }

  let s = String(durationString).trim().toLowerCase()
    .replace(/\u00A0/g, ' ')
    .replace(/–|—/g, '-')
    .replace(/\s+/g, ' ');

  const isoMatch = s.match(/^p\s*(\d+)\s*([dmy])$/i);
  if (isoMatch) {
    const v = parseInt(isoMatch[1], 10);
    const u = isoMatch[2].toLowerCase();
    if (u === 'd') date.setDate(date.getDate() + v);
    else if (u === 'm') date.setMonth(date.getMonth() + v);
    else if (u === 'y') date.setFullYear(date.getFullYear() + v);
    return setNepalMidnight(date);
  }

  const re = /(\d+)\s*(?:-?\s*)?(d(?:ays?)?|day|m(?:o(?:nths?)?)?|mo|month(?:s)?|months?|y(?:ears?|r)?|yr|year(?:s)?)/i;
  const m = s.match(re);

  if (!m) {
    const anyNum = s.match(/(\d+)/);
    if (anyNum) {
      date.setMonth(date.getMonth() + parseInt(anyNum[1], 10));
      return setNepalMidnight(date);
    }
    date.setMonth(date.getMonth() + 1);
    return setNepalMidnight(date);
  }

  const value = parseInt(m[1], 10);
  let unit = m[2].toLowerCase();

  if (unit.startsWith('d')) unit = 'day';
  else if (unit.startsWith('m')) unit = 'month';
  else if (unit.startsWith('y') || unit === 'yr') unit = 'year';

  if (unit === 'day') date.setDate(date.getDate() + value);
  else if (unit === 'month') date.setMonth(date.getMonth() + value);
  else if (unit === 'year') date.setFullYear(date.getFullYear() + value);

  return setNepalMidnight(date);
}

function atPlanBoundary(value = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date(NaN);
  return setNepalMidnight(date);
}

function getDeductibleRenewalBase(subscription, now = new Date()) {
  const currentBoundary = atPlanBoundary(now);
  if (!subscription?.planEnd) {
    return currentBoundary;
  }

  const planEnd = atPlanBoundary(subscription.planEnd);
  const deductibleDays = Math.max(0, Number(subscription.graceDaysBalance || 0))
    + Math.max(0, Number(subscription.adminExtensionDays || 0));

  // If customer had an extension (grace or admin extension)
  if (deductibleDays > 0) {
    // Start of the extension period:
    const extensionStart = new Date(planEnd);
    extensionStart.setDate(extensionStart.getDate() - deductibleDays);

    // If extension is active/recent (planEnd is in the future or current):
    // Renewal begins from when the extension started (extensionStart).
    // An extension must never backdate further than a reasonable recent window (35 days).
    if (planEnd >= currentBoundary) {
      const earliestAllowed = atPlanBoundary(new Date(currentBoundary.getTime() - 35 * 86400000));
      return extensionStart >= earliestAllowed ? extensionStart : currentBoundary;
    }

    // If the extension already expired in the past before today, that past extension has lapsed.
    // Renewal for expired subscribers must start from the current recharge date (today)!
    return currentBoundary;
  }

  // If no extension:
  // If subscription is still active (planEnd >= currentBoundary), renew from planEnd.
  // If subscription has expired in the past, renewal starts from current recharge date (today / currentBoundary)!
  return planEnd >= currentBoundary ? planEnd : currentBoundary;
}

/**
 * Convert standard Gregorian Date to Nepali Date (BS) YYYY-MM-DD
 */
function convertToNepaliDate(dateStringOrObject, format = 'YYYY-MM-DD') {
  if (!dateStringOrObject) return '';

  // If it's already a Nepali date string (e.g., year >= 2060 BS)
  if (typeof dateStringOrObject === 'string') {
    const yearMatch = dateStringOrObject.match(/^(\d{4})[-/]/);
    if (yearMatch && parseInt(yearMatch[1], 10) >= 2060) {
      return dateStringOrObject;
    }
  }

  try {
    const d = new Date(dateStringOrObject);
    if (isNaN(d.getTime())) return '';

    // If parsed year is already a BS year, format and return directly
    if (d.getFullYear() >= 2060) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    }

    const NepaliDate = require('nepali-date-converter').default || require('nepali-date-converter');

    // Shift future dates past 2033 AD to avoid library range exception
    let targetDate = d;
    let yearShift = 0;
    if (d.getFullYear() > 2033) {
      yearShift = d.getFullYear() - 2033;
      targetDate = new Date(d);
      targetDate.setFullYear(2033);
    }

    const nepaliDate = new NepaliDate(targetDate);
    const formatted = nepaliDate.format(format);

    if (yearShift > 0) {
      // Find the year component in the formatted string and shift it back up
      const modified = formatted.replace(/\b\d{4}\b/, (yearStr) => {
        return String(parseInt(yearStr, 10) + yearShift);
      });
      return modified;
    }

    return formatted;
  } catch (err) {
    console.error('Error converting date to Nepali:', err);
    return '';
  }
}

/**
 * Compute start date from expiry date by subtracting duration.
 * E.g. Expiration: 2030-07-15, Duration: "1 Month" -> 2030-06-15
 */
function computeStartFromExpiry(expiryDateInput, durationString) {
  const parsedExpiry = parseAnyDate(expiryDateInput);
  if (!parsedExpiry || isNaN(parsedExpiry.getTime())) return null;

  const date = new Date(parsedExpiry);
  let s = String(durationString || '1 Month').trim().toLowerCase()
    .replace(/\u00A0/g, ' ')
    .replace(/–|—/g, '-')
    .replace(/\s+/g, ' ');

  const isoMatch = s.match(/^p\s*(\d+)\s*([dmy])$/i);
  if (isoMatch) {
    const v = parseInt(isoMatch[1], 10);
    const u = isoMatch[2].toLowerCase();
    if (u === 'd') date.setDate(date.getDate() - v);
    else if (u === 'm') date.setMonth(date.getMonth() - v);
    else if (u === 'y') date.setFullYear(date.getFullYear() - v);
    return setNepalMidnight(date);
  }

  const re = /(\d+)\s*(?:-?\s*)?(d(?:ays?)?|day|m(?:o(?:nths?)?)?|mo|month(?:s)?|months?|y(?:ears?|r)?|yr|year(?:s)?)/i;
  const m = s.match(re);

  if (!m) {
    const anyNum = s.match(/(\d+)/);
    if (anyNum) {
      date.setMonth(date.getMonth() - parseInt(anyNum[1], 10));
      return setNepalMidnight(date);
    }
    date.setMonth(date.getMonth() - 1);
    return setNepalMidnight(date);
  }

  const value = parseInt(m[1], 10);
  let unit = m[2].toLowerCase();

  if (unit.startsWith('d')) unit = 'day';
  else if (unit.startsWith('m')) unit = 'month';
  else if (unit.startsWith('y') || unit === 'yr') unit = 'year';

  if (unit === 'day') date.setDate(date.getDate() - value);
  else if (unit === 'month') date.setMonth(date.getMonth() - value);
  else if (unit === 'year') date.setFullYear(date.getFullYear() - value);

  return setNepalMidnight(date);
}

/**
 * Normalize raw duration to standard string (e.g. 1 -> "1 Month", 3 -> "3 Months", 12 -> "12 Months")
 */
function normalizeDurationString(rawDuration) {
  if (rawDuration === undefined || rawDuration === null || rawDuration === '') return '1 Month';
  const str = String(rawDuration).trim();
  if (/^\d+$/.test(str)) {
    const n = parseInt(str, 10);
    return n === 1 ? '1 Month' : `${n} Months`;
  }
  return str;
}

module.exports = {
  parseAnyDate,
  computeExpiryFromBase,
  computeStartFromExpiry,
  normalizeDurationString,
  convertToNepaliDate,
  atPlanBoundary,
  getDeductibleRenewalBase
};
