import { Component, Input, Output, EventEmitter } from '@angular/core';
import {
  IonMenu, IonHeader, IonToolbar, IonTitle, IonContent,
  IonList, IonItem, IonLabel, IonInput, IonButton,
  IonSelect, IonSelectOption
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

type ColorOpt = { label: string; hex: string };

type Lane = { id: string; name: string };

@Component({
  selector: 'app-board-settings-menu',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    IonMenu, IonHeader, IonToolbar, IonTitle, IonContent,
    IonList, IonItem, IonLabel, IonInput, IonButton,
    IonSelect, IonSelectOption
  ],
  templateUrl: './board-settings-menu.component.html',
  styleUrls: ['./board-settings-menu.component.scss']
})

export class BoardSettingsMenuComponent {

  @Input() menuId = 'board-settings';
  @Input() contentId = 'board-content';

  @Input({ required: true }) lanes: Lane[] = [];
  @Input({ required: true }) palette: ColorOpt[] = [];
  @Input({ required: true }) laneColorMap: Record<string, string> = {};

  @Input() newLane = '';
  @Output() newLaneChange = new EventEmitter<string>();

  @Output() addLane = new EventEmitter<void>();
  @Output() laneColorChange = new EventEmitter<{ laneId: string; color: string }>();

  getLaneColor(laneId: string): string {
    return this.laneColorMap?.[laneId] || '';
  }

  onPickColor(laneId: string, hex: string) {
    this.laneColorChange.emit({ laneId, color: hex });
  }
}
