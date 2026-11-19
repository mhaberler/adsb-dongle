// Input source picker: a modal list of the attached USB device (Android)
// and discovered brokers. The list refreshes live while open, since
// brokers resolve one by one after the mDNS watch starts.

export interface PickerItem {
  label: string;
  detail: string;
  pick: () => void;
}

export class SourcePicker {
  private root: HTMLDivElement;
  private list: HTMLUListElement;

  constructor() {
    this.root = document.createElement("div");
    this.root.id = "source-picker";
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="sp-sheet" role="dialog" aria-label="Choose input source">
        <div class="sp-title">Input source</div>
        <ul></ul>
        <button type="button" class="sp-cancel">Cancel</button>
      </div>`;
    this.list = this.root.querySelector("ul")!;
    this.root.querySelector(".sp-cancel")!.addEventListener("click", () => this.close());
    this.root.addEventListener("click", (e) => {
      if (e.target === this.root) this.close();
    });
    document.querySelector("#app")!.append(this.root);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(items: PickerItem[]): void {
    this.update(items);
    this.root.hidden = false;
  }

  close(): void {
    this.root.hidden = true;
  }

  update(items: PickerItem[]): void {
    this.list.replaceChildren();
    if (items.length === 0) {
      const li = document.createElement("li");
      li.className = "sp-empty";
      li.textContent = "Searching for brokers...";
      this.list.append(li);
      return;
    }
    for (const item of items) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      const label = document.createElement("span");
      label.textContent = item.label;
      const detail = document.createElement("small");
      detail.textContent = item.detail;
      btn.append(label, detail);
      btn.addEventListener("click", () => {
        this.close();
        item.pick();
      });
      li.append(btn);
      this.list.append(li);
    }
  }
}
