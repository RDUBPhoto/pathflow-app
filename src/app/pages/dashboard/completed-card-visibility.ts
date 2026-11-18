import { WorkItem } from '../../services/workitems-api.service';

function localDayKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Completed is a same-day board view; older records remain available in storage. */
export function isExpiredCompletedCard(
  item: Pick<WorkItem, 'completedAt' | 'updatedAt' | 'createdAt'>,
  now: Date = new Date()
): boolean {
  const today = localDayKey(now);
  if (!today) return false;

  // Older records may not have a completion timestamp. Their last saved date is
  // the best available indication of when they entered the Completed lane.
  const date = [item.completedAt, item.updatedAt, item.createdAt]
    .map(value => localDayKey(String(value || '').trim()))
    .find(Boolean);
  return !!date && date < today;
}
