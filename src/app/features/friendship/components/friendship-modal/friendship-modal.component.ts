import {Component, inject, input, model, signal} from '@angular/core';
import {Dialog} from "primeng/dialog";
import {RelationshipModel} from "./dto/relationship.model";
import {Button} from "primeng/button";
import {Fieldset} from "primeng/fieldset";
import {Tag} from "primeng/tag";
import {Listbox} from "primeng/listbox";
import {Avatar} from "primeng/avatar";
import {PrimeTemplate} from "primeng/api";
import {InputText} from "primeng/inputtext";
import {Tooltip} from "primeng/tooltip";
import {RelationshipService} from "../../../../services/relationship.service";

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
    Tooltip
  ],
  templateUrl: './friendship-modal.component.html',
  styleUrl: './friendship-modal.component.css',
})
export class FriendshipModalComponent {
  public isVisible = model.required<boolean>();

  public relationships = signal<RelationshipModel[]>([])

  private relationshipService = inject(RelationshipService);

  constructor() {
    this.relationshipService.getRelationships().subscribe(d => {
      this.relationships.set(d);
    })
  }
}
