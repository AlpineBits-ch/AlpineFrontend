import {Component, input} from '@angular/core';
import {MessageDto} from "../../../../../dtos/response/message.dto";
import {Avatar} from "primeng/avatar";
import {DatePipe} from "@angular/common";

@Component({
  selector: 'app-message',
  imports: [
    Avatar,
    DatePipe
  ],
  templateUrl: './message.component.html',
  styleUrl: './message.component.css',
})
export class MessageComponent {
  public message = input.required<MessageDto>();
}
