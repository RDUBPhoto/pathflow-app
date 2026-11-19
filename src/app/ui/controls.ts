import {
  Component, Directive, ElementRef, EventEmitter, forwardRef, HostBinding, HostListener,
  inject, Input, Output,
  ChangeDetectionStrategy
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';


@Directive()
abstract class FormControl implements ControlValueAccessor {
  @Input() value: any = '';
  @Input() disabled = false;
  protected updateModel = (_value: any) => {};
  protected touch = () => {};

  writeValue(value: any): void { this.value = value ?? ''; }
  registerOnChange(callback: (value: any) => void): void { this.updateModel = callback; }
  registerOnTouched(callback: () => void): void { this.touch = callback; }
  setDisabledState(disabled: boolean): void { this.disabled = disabled; }

  protected commit(value: any): void {
    this.value = value;
    this.updateModel(value);
  }
}

@Directive()
abstract class TextControl extends FormControl {
  @Input() placeholder = '';
  @Input() label = '';
  @Input('aria-label') ariaLabel = '';
  @Input() readonly: boolean | string = false;
  @Input() maxlength: string | number | null = null;
  @Output() valueInput = new EventEmitter<{ detail: { value: string } }>();
  @Output() controlBlur = new EventEmitter<void>();

  edit(value: string): void {
    this.commit(value);
    this.valueInput.emit({ detail: { value } });
  }

  blur(): void {
    this.touch();
    this.controlBlur.emit();
  }
}

@Component({
  selector: 'ui-input',
  imports: [],
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => UiInput), multi: true }],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (label) {
      <label class="form-label" [for]="inputId">{{ label }}</label>
    }
    <input class="form-control" [id]="inputId" [type]="type" [value]="value"
      [placeholder]="placeholder" [readOnly]="readonly !== false" [disabled]="disabled"
      [attr.name]="name || null" [attr.autocomplete]="autocomplete || null" [attr.inputmode]="inputmode || null"
      [attr.min]="min" [attr.max]="max" [attr.step]="step" [attr.maxlength]="maxlength"
      [attr.aria-label]="ariaLabel || label || placeholder || null"
      (input)="edit($any($event.target).value)" (blur)="blur()">
    `
})
export class UiInput extends TextControl {
  private static sequence = 0;
  readonly inputId = `field-${++UiInput.sequence}`;
  @Input() type = 'text';
  @Input() name = '';
  @Input() autocomplete = '';
  @Input() inputmode = '';
  @Input() min: string | number | null = null;
  @Input() max: string | number | null = null;
  @Input() step: string | number | null = null;
}

@Component({
  selector: 'ui-textarea',
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => UiTextarea), multi: true }],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <textarea class="form-control" [id]="inputId" [attr.name]="name || null" [value]="value" [placeholder]="placeholder" [rows]="rows"
      [style.field-sizing]="autoGrow ? 'content' : null"
      [readOnly]="readonly !== false" [disabled]="disabled" [attr.maxlength]="maxlength"
      [attr.aria-label]="ariaLabel || label || placeholder || null" (input)="edit($any($event.target).value)"
      (blur)="blur()"></textarea>
  `
})
export class UiTextarea extends TextControl {
  private static sequence = 0;
  readonly inputId = `textarea-${++UiTextarea.sequence}`;
  @Input() name = '';
  @Input() rows: number | string = 3;
  @Input() autoGrow: boolean | string = false;
}

@Component({
  selector: 'ui-checkbox, ui-switch',
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => UiCheckbox), multi: true }],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <label class="form-check m-0" [class.form-switch]="isSwitch">
      <input class="form-check-input" type="checkbox" [attr.role]="isSwitch ? 'switch' : null"
        [id]="inputId" [attr.name]="name || null"
        [checked]="checked" [disabled]="disabled" [attr.aria-label]="ariaLabel || null"
        (change)="change($any($event.target).checked)" (blur)="touch()">
      <span class="form-check-label"><ng-content /></span>
    </label>
  `
})
export class UiCheckbox extends FormControl {
  private static sequence = 0;
  readonly inputId = `checkbox-${++UiCheckbox.sequence}`;
  @Input() name = '';
  readonly isSwitch = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement.localName === 'ui-switch';
  @Input('aria-label') ariaLabel = '';
  @Input() set checked(checked: boolean) { this.value = checked; }
  get checked(): boolean { return this.value === true; }
  @Output() controlChange = new EventEmitter<{ detail: { checked: boolean } }>();

  change(checked: boolean): void {
    this.commit(checked);
    this.controlChange.emit({ detail: { checked } });
  }
}

@Component({
  selector: 'ui-tabs',
  template: '<ng-content />',
  changeDetection: ChangeDetectionStrategy.Eager,
  host: { class: 'nav nav-tabs', role: 'tablist' }
})
export class UiTabs {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  @Input() value = '';
  @Output() controlChange = new EventEmitter<{ detail: { value: string } }>();

  @HostListener('keydown', ['$event']) moveFocus(event: KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = Array.from(this.element.nativeElement.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
    const current = tabs.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    const step = event.key === 'ArrowLeft' ? -1 : 1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + step + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[next].focus();
    tabs[next].click();
  }
}

@Directive({
  selector: 'button[uiTab]',
  host: { class: 'nav-link', role: 'tab' }
})
export class UiTab {
  private readonly tabs = inject(UiTabs);
  @Input() value = '';
  @HostBinding('class.active') get active(): boolean { return this.tabs.value === this.value; }
  @HostBinding('attr.aria-selected') get selected(): boolean { return this.active; }
  @HostBinding('attr.tabindex') get tabIndex(): number { return this.active ? 0 : -1; }
  @HostListener('click') select(): void {
    this.tabs.controlChange.emit({ detail: { value: this.value } });
  }
}

@Directive({ selector: '[uiBadge]', host: { class: 'badge' } })
export class UiBadge {
  @Input() color = 'secondary';
  @HostBinding('attr.data-color') get tone(): string { return this.color; }
}
