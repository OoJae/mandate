/**
 * Grant dates for tests, derived from the clock.
 *
 * `mandate grant` refuses an end date that has already passed, so a hard-coded
 * one turns the suite red the day it arrives. UNTIL is midnight UTC on the
 * first of the month twelve months after the current one: always about a year
 * ahead, whatever today is.
 */
const today = new Date()

/** The grant end, as the CLI prints it (2027-09-01T00:00:00.000Z). */
export const UNTIL = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 12, 1)).toISOString()
/** Its day, the answer a person types to confirm the date (2027-09-01). */
export const UNTIL_DAY = UNTIL.slice(0, 10)
/** The same instant as a grant literal (2027-09-01T00:00:00Z). */
export const UNTIL_Z = `${UNTIL_DAY}T00:00:00Z`
/** The day after, a wrong typed answer (2027-09-02). */
export const DAY_AFTER_UNTIL = new Date(Date.parse(UNTIL) + 864e5).toISOString().slice(0, 10)
/** The date as a person reads it in the consent script (1 September 2027). */
export const UNTIL_SPOKEN = new Date(UNTIL).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
/** An ISO instant `days` after UNTIL (negative for before). */
export const afterUntil = days => new Date(Date.parse(UNTIL) + days * 864e5).toISOString()
