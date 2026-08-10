/**
 * Date Helper Utility
 */

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
    date.setHours(0, 0, 0, 0);
    return date;
  }

  let s = String(durationString).trim().toLowerCase()
    .replace(/\u00A0/g, ' ')
    .replace(/–|—/g, '-')
    .replace(/\s+/g, ' ');

  const isoMatch = s.match(/^p\s*(\d+)\s*([dmy])$/i);
  if (isoMatch) {
    const v = parseInt(isoMatch[1], 10);
    const u = isoMatch[2].toLowerCase();
    if (u === 'd') { date.setDate(date.getDate() + v); }
    else if (u === 'm') { date.setMonth(date.getMonth() + v); }
    else if (u === 'y') { date.setFullYear(date.getFullYear() + v); }
    date.setHours(0, 0, 0, 0);
    return date;
  }

  const re = /(\d+)\s*(?:-?\s*)?(d(?:ays?)?|day|m(?:o(?:nths?)?)?|mo|month(?:s)?|months?|y(?:ears?|r)?|yr|year(?:s)?)/i;
  const m = s.match(re);

  if (!m) {
    const anyNum = s.match(/(\d+)/);
    if (anyNum) {
      date.setMonth(date.getMonth() + parseInt(anyNum[1], 10));
    } else {
      date.setMonth(date.getMonth() + 1);
    }
    date.setHours(0, 0, 0, 0);
    return date;
  }

  const value = parseInt(m[1], 10);
  let unit = m[2].toLowerCase();

  if (unit.startsWith('d')) unit = 'day';
  else if (unit.startsWith('m')) unit = 'month';
  else if (unit.startsWith('y') || unit === 'yr') unit = 'year';

  if (unit === 'day') date.setDate(date.getDate() + value);
  else if (unit === 'month') date.setMonth(date.getMonth() + value);
  else if (unit === 'year') date.setFullYear(date.getFullYear() + value);

  date.setHours(0, 0, 0, 0);
  return date;
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

function convertToEnglishDate(bsDate) {
  const match = String(bsDate || '').match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
  if (!match || Number(match[1]) < 2000) return '';
  try {
    const NepaliDate = require('nepali-date-converter').default || require('nepali-date-converter');
    const converted = new NepaliDate(`${match[1]}-${match[2]}-${match[3]}`).getAD();
    const date = `${converted.year}-${String(converted.month + 1).padStart(2, '0')}-${String(converted.date).padStart(2, '0')}`;
    return `${date}${match[4] || ''}`;
  } catch (err) {
    return '';
  }
}

module.exports = {
  computeExpiryFromBase,
  convertToNepaliDate,
  convertToEnglishDate
};
