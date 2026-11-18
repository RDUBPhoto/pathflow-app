import DashboardComponent from './dashboard.component';
import { Lane } from '../../services/lanes-api.service';
import { WorkItem } from '../../services/workitems-api.service';

describe('dashboard lifecycle reconciliation', () => {
  const lanes: Lane[] = [
    { id: 'quotes', name: 'Quotes', stageKey: 'quote' },
    { id: 'completed', name: 'Completed', stageKey: 'completed' }
  ];

  it('does not delete a new quote because an older job for the same customer is Completed', () => {
    const board = Object.create(DashboardComponent.prototype) as any;
    board.workflowCustomerKey = () => 'id:customer-1';
    board.resolvedDocumentRefForLaneCard = (item: WorkItem) => String(item.title.match(/\[doc=([^\]]+)\]/)?.[1] || '');

    const map: Record<string, WorkItem[]> = {
      quotes: [{ id: 'new-quote', laneId: 'quotes', customerId: 'customer-1', title: 'New quote [doc=quote-new]' }],
      completed: [{ id: 'old-job', laneId: 'completed', customerId: 'customer-1', title: 'Old job [doc=quote-old]', completedAt: '2026-07-21T18:01:48Z' }]
    };

    expect(board.pruneLifecycleStageDuplicatesInMap(map, lanes)).toEqual([]);
    expect(map['quotes'].map(item => item.id)).toEqual(['new-quote']);
    expect(map['completed'].map(item => item.id)).toEqual(['old-job']);
  });
});
