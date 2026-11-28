/**
 * How much is saved on a page, in words. One place, because the page's
 * popup ("You have 3 notes and 1 chat summary here.") and the side panel's
 * recap card ("From 3 notes and 1 chat summary.") have to agree.
 */

/** "3 notes and 1 chat summary", or '' when nothing is saved. */
export function savedCount(noteCount: number, summaryCount: number): string {
  const parts: string[] = [];
  if (noteCount > 0) parts.push(`${noteCount} note${noteCount === 1 ? '' : 's'}`);
  if (summaryCount > 0) parts.push(`${summaryCount} chat summar${summaryCount === 1 ? 'y' : 'ies'}`);
  return parts.join(' and ');
}
