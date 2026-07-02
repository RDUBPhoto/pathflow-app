import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  IonButton,
  IonButtons,
  IonHeader,
  IonTitle,
  IonToolbar
} from '@ionic/angular/standalone';
import { AuthService } from '../../auth/auth.service';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { JobTask, JobTaskStatus, JobTasksApiService } from '../../services/job-tasks-api.service';

type TaskFilter = JobTaskStatus | 'all' | 'due-soon' | 'overdue';

@Component({
  selector: 'app-tasks',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    PageBackButtonComponent,
    CompanySwitcherComponent,
    UserMenuComponent
  ],
  templateUrl: './tasks.component.html',
  styleUrls: ['./tasks.component.scss']
})
export default class TasksComponent implements OnInit {
  private readonly tasksApi = inject(JobTasksApiService);
  private readonly auth = inject(AuthService);

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly status = signal('');
  readonly statusFilter = signal<TaskFilter>('open');
  readonly tasks = signal<JobTask[]>([]);
  readonly visibleTasks = computed(() => {
    const filter = this.statusFilter();
    return this.tasks().filter(task => {
      if (filter === 'all') return true;
      if (filter === 'due-soon') return this.dueStateClass(task) === 'due-soon';
      if (filter === 'overdue') return this.dueStateClass(task) === 'overdue';
      return task.status === filter;
    });
  });
  readonly openCount = computed(() => this.tasks().filter(task => task.status === 'open').length);
  readonly inProgressCount = computed(() => this.tasks().filter(task => task.status === 'in_progress').length);
  readonly dueSoonCount = computed(() => this.tasks().filter(task => this.dueStateClass(task) === 'due-soon').length);
  readonly overdueCount = computed(() => this.tasks().filter(task => this.dueStateClass(task) === 'overdue').length);
  readonly completedCount = computed(() => this.tasks().filter(task => task.status === 'completed').length);

  ngOnInit(): void {
    this.loadTasks();
  }

  loadTasks(): void {
    this.loading.set(true);
    this.error.set('');
    this.tasksApi.list({ status: 'all' }).subscribe({
      next: res => {
        this.tasks.set(Array.isArray(res?.tasks) ? res.tasks : []);
        this.loading.set(false);
      },
      error: err => {
        this.error.set(String(err?.error?.error || err?.message || 'Could not load tasks.'));
        this.loading.set(false);
      }
    });
  }

  setFilter(value: TaskFilter): void {
    this.statusFilter.set(value);
  }

  updateTaskComments(task: JobTask, comments: string): void {
    this.tasks.set(this.tasks().map(row => row.id === task.id ? { ...row, comments } : row));
  }

  completeTask(task: JobTask): void {
    this.saving.set(true);
    this.status.set('');
    this.error.set('');
    this.tasksApi.complete(task.id, {
      comments: task.comments || '',
      completedBy: this.currentUserName(),
      completedById: this.currentUserId()
    }).subscribe({
      next: () => {
        this.status.set('Task completed.');
        this.saving.set(false);
        this.loadTasks();
      },
      error: err => {
        this.error.set(String(err?.error?.error || err?.message || 'Could not complete task.'));
        this.saving.set(false);
      }
    });
  }

  saveNotes(task: JobTask): void {
    this.saving.set(true);
    this.status.set('');
    this.error.set('');
    this.tasksApi.update(task.id, { ...task, comments: task.comments || '' }).subscribe({
      next: () => {
        this.status.set('Task notes saved.');
        this.saving.set(false);
        this.loadTasks();
      },
      error: err => {
        this.error.set(String(err?.error?.error || err?.message || 'Could not save task notes.'));
        this.saving.set(false);
      }
    });
  }

  dueStateClass(task: JobTask): string {
    if (task.status === 'completed' || task.status === 'cancelled') return task.status;
    const dueMs = Date.parse(String(task.dueDate || ''));
    if (!Number.isFinite(dueMs)) return 'normal';
    const now = Date.now();
    if (dueMs < now) return 'overdue';
    if (dueMs - now <= 2 * 24 * 60 * 60 * 1000) return 'due-soon';
    return 'normal';
  }

  dueStateLabel(task: JobTask): string {
    const state = this.dueStateClass(task);
    if (state === 'overdue') return 'Overdue';
    if (state === 'due-soon') return 'Due soon';
    if (state === 'completed') return 'Completed';
    if (state === 'cancelled') return 'Cancelled';
    return 'Scheduled';
  }

  filterLabel(): string {
    const filter = this.statusFilter();
    if (filter === 'all') return 'All Tasks';
    if (filter === 'due-soon') return 'Due Soon';
    if (filter === 'overdue') return 'Overdue';
    return this.label(filter);
  }

  emptyTitle(): string {
    return this.tasks().length ? 'No tasks match this view' : 'No operational tasks yet';
  }

  emptyMessage(): string {
    if (this.tasks().length) {
      return 'Try another filter or refresh the list to pull in newly generated job tasks.';
    }
    return 'Tasks are created for scheduled jobs that have job-linked parts, including readiness checks and pull reminders before install.';
  }

  label(value: unknown): string {
    return String(value || '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, char => char.toUpperCase());
  }

  formatDate(value: unknown): string {
    const ts = Date.parse(String(value || ''));
    if (!Number.isFinite(ts)) return 'No due date';
    return new Date(ts).toLocaleString();
  }

  jobQuery(task: JobTask): Record<string, string> {
    const params: Record<string, string> = {};
    if (task.jobId) params['jobId'] = task.jobId;
    if (task.jobNumber) params['jobNumber'] = task.jobNumber;
    if (task.relatedScheduleId) params['scheduleId'] = task.relatedScheduleId;
    if (task.relatedWorkItemId) params['workItemId'] = task.relatedWorkItemId;
    return params;
  }

  trackTask(_index: number, task: JobTask): string {
    return task.id;
  }

  private currentUserName(): string {
    const user = this.auth.user();
    return String(user?.displayName || user?.email || 'Staff').trim();
  }

  private currentUserId(): string {
    const user = this.auth.user();
    return String(user?.id || user?.email || '').trim();
  }
}
