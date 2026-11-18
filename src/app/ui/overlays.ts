import {
  afterNextRender, Component, ContentChild, ElementRef, EventEmitter, inject, Injectable, Injector,
  Input, NgZone, OnChanges, Output, TemplateRef, ViewChild,
  DOCUMENT,
  ChangeDetectionStrategy
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';

@Component({
  selector: 'ui-modal',
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <dialog #dialog class="modal ui-dialog" [class]="cssClass" (cancel)="cancel($event)"
      (click)="backdrop($event)" [attr.aria-label]="label">
      <div class="modal-content ui-dialog-content">
        @if (isOpen) { <ng-container [ngTemplateOutlet]="content" /> }
      </div>
    </dialog>
  `
})
export class UiModal implements OnChanges {
  @Input() isOpen = false;
  @Input() cssClass = '';
  @Input() label = 'Dialog';
  @Input() backdropDismiss = true;
  @Output() didDismiss = new EventEmitter<void>();
  @Output() didPresent = new EventEmitter<void>();
  @ContentChild(TemplateRef) content!: TemplateRef<unknown>;
  @ViewChild('dialog') dialog?: ElementRef<HTMLDialogElement>;
  private readonly injector = inject(Injector);

  ngOnChanges(): void {
    afterNextRender(() => this.sync(), { injector: this.injector });
  }

  private sync(): void {
    if (!this.dialog) return;
    const dialog = this.dialog.nativeElement;
    if (this.isOpen && !dialog.open) {
      dialog.showModal();
      this.didPresent.emit();
    } else if (!this.isOpen && dialog.open) {
      this.dismiss();
    }
  }

  cancel(event: Event): void {
    event.preventDefault();
    if (this.backdropDismiss) this.dismiss();
  }

  backdrop(event: MouseEvent): void {
    if (event.target === this.dialog?.nativeElement && this.backdropDismiss) this.dismiss();
  }

  private dismiss(): void {
    this.dialog?.nativeElement.close();
    this.didDismiss.emit();
  }
}

@Component({
  selector: 'ui-popover',
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (isOpen) {
      <div class="ui-popover-screen" (click)="dismiss()"></div>
      <div class="dropdown-menu show ui-popover-panel"
        (keydown.escape)="dismiss()" tabindex="-1">
        <ng-container [ngTemplateOutlet]="content" />
      </div>
    }
  `
})
export class UiPopover implements OnChanges {
  @Input() isOpen = false;
  @Input() event: Event | null = null;
  @Input() trigger = '';
  @Input() alignment = 'start';
  @Output() didDismiss = new EventEmitter<void>();
  @ContentChild(TemplateRef) content!: TemplateRef<unknown>;
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private anchor: HTMLElement | null = null;

  ngOnChanges(): void {
    if (!this.isOpen) return;
    const target = this.event?.currentTarget || this.event?.target;
    this.anchor = this.trigger ? this.document.getElementById(this.trigger) :
      target instanceof Element ? target.closest<HTMLElement>('button, a, [tabindex]') : null;
    afterNextRender(() => this.position(), { injector: this.injector });
  }

  private position(): void {
    const panel = this.host.nativeElement.querySelector<HTMLElement>('.ui-popover-panel');
    const view = this.document.defaultView;
    if (!panel || !view || !this.isOpen) return;
    const bounds = this.anchor?.getBoundingClientRect();
    const width = panel.offsetWidth;
    const left = this.alignment === 'end' && bounds ? bounds.right - width : bounds?.left ?? 12;
    const top = (bounds?.bottom ?? 4) + 8;
    panel.style.left = `${Math.max(8, Math.min(view.innerWidth - width - 8, left))}px`;
    panel.style.top = `${Math.max(8, Math.min(view.innerHeight - panel.offsetHeight - 8, top))}px`;
    panel.focus({ preventScroll: true });
  }

  dismiss(): void {
    if (!this.isOpen) return;
    this.didDismiss.emit();
    this.anchor?.focus({ preventScroll: true });
  }
}

type ToastOptions = {
  message: string;
  duration?: number;
  color?: string;
  position?: 'top' | 'middle' | 'bottom';
  cssClass?: string | string[];
  buttons?: Array<{ text: string; role: 'cancel' }>;
};

@Injectable({ providedIn: 'root' })
export class ToastController {
  private readonly document = inject(DOCUMENT);
  private readonly zone = inject(NgZone);

  async create(options: ToastOptions): Promise<{ present: () => Promise<void> }> {
    return { present: async () => {
      const toast = this.document.createElement('div');
      const color = ['danger', 'success', 'warning'].includes(options.color || '') ? options.color : 'info';
      toast.className = `alert ui-toast alert-${color}`;
      const extra = Array.isArray(options.cssClass) ? options.cssClass : (options.cssClass || '').split(/\s+/);
      toast.classList.add(...extra.filter(Boolean));
      toast.dataset['position'] = options.position || 'bottom';
      toast.setAttribute('role', options.color === 'danger' ? 'alert' : 'status');
      toast.textContent = options.message;
      if (options.buttons?.some(button => button.role === 'cancel')) {
        const close = this.document.createElement('button');
        close.type = 'button';
        close.className = 'btn-close ms-2';
        close.setAttribute('aria-label', 'Dismiss notification');
        close.addEventListener('click', () => toast.remove(), { once: true });
        toast.append(close);
      }
      const dialogs = this.document.querySelectorAll<HTMLDialogElement>('.ui-dialog[open]');
      (dialogs[dialogs.length - 1] || this.document.body).append(toast);
      this.zone.runOutsideAngular(() => setTimeout(() => toast.remove(), options.duration ?? 3000));
    } };
  }
}
