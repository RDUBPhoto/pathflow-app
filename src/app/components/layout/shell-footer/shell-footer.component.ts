import { Component, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'app-shell-footer',
  standalone: true,
  templateUrl: './shell-footer.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./shell-footer.component.scss']
})
export class ShellFooterComponent {
  readonly year = new Date().getFullYear();
}
