import {Component, output} from '@angular/core';
import {Button} from "primeng/button";
import {InputText} from "primeng/inputtext";
import {Textarea} from "primeng/textarea";

@Component({
  selector: 'app-composer',
  imports: [
    Button,
    InputText,
    Textarea
  ],
  templateUrl: './composer.component.html',
  styleUrl: './composer.component.css',
})
export class ComposerComponent {

  public message = output<string>();
  handleSendMessage(textarea: HTMLTextAreaElement) {
    const message = textarea.value.trim();

    if (message) {
      console.log('Sending message:', message);
      // Add your send logic here

      this.message.emit(message);
      textarea.value = ''; // Clear the input
      // Trigger resize manually if needed (PrimeNG handles most cases)
    }
  }
}
