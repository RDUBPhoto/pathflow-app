import { Component } from '@angular/core';

@Component({
  selector: 'app-shell-footer',
  standalone: true,
  templateUrl: './shell-footer.component.html',
  styleUrls: ['./shell-footer.component.scss']
})
export class ShellFooterComponent {
  readonly year = new Date().getFullYear();
}
