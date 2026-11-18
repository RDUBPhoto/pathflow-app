import { Component, HostBinding, Input, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'ui-icon',
  template: '',
  changeDetection: ChangeDetectionStrategy.Eager,
  host: { class: 'ui-icon' }
})
export class UiIcon {
  @Input() name = '';

  @HostBinding('attr.data-icon') get icon(): string { return this.name; }

  @HostBinding('attr.aria-hidden') get hidden(): string | null {
    return this.accessibleName ? null : 'true';
  }

  @Input('aria-label') accessibleName = '';
}
