import {Component, signal} from '@angular/core';
import { createClient } from '@workos-inc/authkit-js';
import {Card} from "primeng/card";
import {DatePicker} from "primeng/datepicker";
import {InputText} from "primeng/inputtext";
import {PasswordDirective} from "primeng/password";
import {Button} from "primeng/button";
@Component({
  selector: 'app-login',
  imports: [
    Card,
    DatePicker,
    InputText,
    PasswordDirective,
    Button
  ],
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export class Login {
  protected isLoginMode = signal(false);


}
