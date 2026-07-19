import { ChangeDetectionStrategy, Component, output, signal } from '@angular/core';

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
      <span class="font-medium text-slate-600">Drop PDFs here or click to browse</span>
      <span class="text-xs text-slate-400">Only PDF files are accepted</span>
      <input
        type="file"
        class="hidden"
        accept="application/pdf,.pdf"
        multiple
        (change)="onSelect($event)"
        data-test="file-input"
      />
    </label>
  `,
})
export class UploadDropzone {
  readonly filesPicked = output<File[]>();
  protected dragging = signal(false);

  onDragOver(e: DragEvent): void {
    e.preventDefault();
    this.dragging.set(true);
  }

  onDrop(e: DragEvent): void {
    e.preventDefault();
    this.dragging.set(false);
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type === 'application/pdf' || f.name.endsWith('.pdf'));
    if (files.length) this.filesPicked.emit(files);
  }

  onSelect(e: Event): void {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (files.length) this.filesPicked.emit(files);
    input.value = '';
  }
}
