import {Component, inject, input, model, signal} from '@angular/core';
import {Dialog} from "primeng/dialog";
import {RelationshipModel, RelationshipStatus} from "./dto/relationship.model";
import {Button} from "primeng/button";
import {Fieldset} from "primeng/fieldset";
import {Tag} from "primeng/tag";
import {Listbox} from "primeng/listbox";
import {Avatar} from "primeng/avatar";
import {PrimeTemplate} from "primeng/api";
import {InputText} from "primeng/inputtext";
import {Tooltip} from "primeng/tooltip";
import {RelationshipService} from "../../../../services/relationship.service";
import {FormsModule} from "@angular/forms";

@Component({
  selector: 'app-friendship-modal',
  imports: [
    Dialog,
    Button,
    Fieldset,
    Tag,
    Listbox,
    Avatar,
    PrimeTemplate,
    InputText,
    Tooltip,
    FormsModule
  ],
  templateUrl: './friendship-modal.component.html',
  styleUrl: './friendship-modal.component.css',
})
export class FriendshipModalComponent {
  public isVisible = model.required<boolean>();

  public relationships = signal<RelationshipModel[]>([])

  private relationshipService = inject(RelationshipService);

  public friendId: string = '';
  constructor() {
    this.relationshipService.getRelationships().subscribe(d => {
      this.relationships.set(d);
    })
  }

  public sendFriendrequest(){

    const id= Number.parseInt(this.friendId.split('#')[1]);
    const username = this.friendId.split('#')[0];

    this.relationshipService.createFriendRequest(username, id).subscribe(d => {
      console.log(d);
    })
  }

  public acceptFriendRequest(id: string){


    this.relationshipService.acceptFriendRequest(id).subscribe(d => {
      console.log(d);
    })
  }

  public rejectFriendRequest(id: string){


    this.relationshipService.rejectFriendRequest(id).subscribe(d => {
      console.log(d);
    })
  }

    protected readonly RelationshipStatus = RelationshipStatus;
}
