import { isExpiredCompletedCard } from './completed-card-visibility';
import { signal } from '@angular/core';
import DashboardComponent from './dashboard.component';

describe('Completed board card visibility', () => {
  const today = new Date(2026, 9, 8, 12);

  it('hides a completed card from months earlier without deleting its record', () => {
    expect(isExpiredCompletedCard({ completedAt: '2026-07-21T18:01:48.748Z' }, today)).toBeTrue();
  });

  it('keeps cards completed today and in the future visible', () => {
    expect(isExpiredCompletedCard({ completedAt: new Date(2026, 9, 8, 9).toISOString() }, today)).toBeFalse();
    expect(isExpiredCompletedCard({ completedAt: new Date(2026, 9, 9, 9).toISOString() }, today)).toBeFalse();
  });

  it('uses the last saved date for legacy completed cards without completedAt', () => {
    expect(isExpiredCompletedCard({ updatedAt: '2026-07-21T18:01:48.748Z' }, today)).toBeTrue();
    expect(isExpiredCompletedCard({ updatedAt: new Date(2026, 9, 8, 9).toISOString() }, today)).toBeFalse();
  });

  it('does not hide records when no valid date is available', () => {
    expect(isExpiredCompletedCard({ completedAt: 'invalid', updatedAt: '' }, today)).toBeFalse();
  });

  it('never renders an expired Completed card or counts it during board refresh', () => {
    // Exercise the board selector without starting the component's polling or API calls.
    const board = Object.create(DashboardComponent.prototype) as DashboardComponent;
    board.lanes = signal([{ id: 'completed', name: 'Completed', stageKey: 'completed' }]);
    board.items = signal({ completed: [
      { id: 'old', title: 'Historic job', laneId: 'completed', completedAt: '2026-07-21T18:01:48.748Z' },
      { id: 'today', title: 'Current job', laneId: 'completed', completedAt: new Date().toISOString() }
    ] });

    expect(board.getLaneCards('completed').map(item => item.id)).toEqual(['today']);
    expect(board.laneItemCount('completed')).toBe(1);
    expect(board.items()['completed'].length).toBe(2);
  });
});
