import { Component } from '@angular/core';
import {Button} from "primeng/button";
import {InputText} from "primeng/inputtext";

@Component({
  selector: 'app-composer',
  imports: [
    Button,
    InputText
  ],
  templateUrl: './composer.component.html',
  styleUrl: './composer.component.css',
})
export class ComposerComponent {

}
