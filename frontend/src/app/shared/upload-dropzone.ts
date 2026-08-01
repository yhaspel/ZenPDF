import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';

@Component({
  selector: 'app-upload-dropzone',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label
      class="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition"
      [class.border-indigo-400]="dragging()"
      [class.bg-indigo-50]="dragging()"
      [class.border-slate-300]="!dragging()"
      (dragover)="onDragOver($event)"
      (dragleave)="dragging.set(false)"
      (drop)="onDrop($event)"
      data-test="dropzone"
    >
      <span class="text-3xl">⬆️</span>
      <span class="font-medium text-slate-600">{{ prompt() }}</span>
      <span class="text-xs text-slate-400">{{ hint() }}</span>
      <input
        type="file"
        class="hidden"
        [accept]="accept()"
        multiple
        (change)="onSelect($event)"
        data-test="file-input"
      />
    </label>
  `,
})
export class UploadDropzone {
  /**
   * What the file picker offers. Phase 6 made this worth having: the import
   * tools take a Word file or a photograph, and a dropzone that only accepts
   * PDFs on the Word-to-PDF page is a dead end with no explanation.
   */
  readonly accept = input('application/pdf,.pdf');
  readonly prompt = input('Drop PDFs here or click to browse');
  readonly hint = input('Only PDF files are accepted');

  readonly filesPicked = output<File[]>();
  protected dragging = signal(false);

  onDragOver(e: DragEvent): void {
    e.preventDefault();
    this.dragging.set(true);
  }

  onDrop(e: DragEvent): void {
    e.preventDefault();
    this.dragging.set(false);
    // A dropped file is filtered against the same `accept` list the picker
    // uses, so the two routes into the tool behave the same way.
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => this.accepts(f));
    if (files.length) this.filesPicked.emit(files);
  }

  private accepts(file: File): boolean {
    const patterns = this.accept().split(',').map((p) => p.trim().toLowerCase());
    const name = file.name.toLowerCase();
    const type = (file.type || '').toLowerCase();
    return patterns.some((pattern) =>
      pattern.startsWith('.')
        ? name.endsWith(pattern)
        : pattern.endsWith('/*')
          ? type.startsWith(pattern.slice(0, -1))
          : type === pattern,
    );
  }

  onSelect(e: Event): void {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (files.length) this.filesPicked.emit(files);
    input.value = '';
  }
}
