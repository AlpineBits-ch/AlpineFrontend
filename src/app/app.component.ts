import {Component, inject} from "@angular/core";
import { RouterOutlet } from "@angular/router";
import {Button} from "primeng/button";
import {ProfileService} from "./services/profile.service";
import {OAuthService} from "angular-oauth2-oidc";

@Component({
  selector: "app-root",
    imports: [RouterOutlet],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent {
  private profileService = inject(ProfileService);
  public ngOnInit(): void {
    this.profileService.getSelf().subscribe((profile) => {
      console.log('Profile:', profile);
    });

  }
}
