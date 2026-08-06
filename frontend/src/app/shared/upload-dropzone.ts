import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';

/**
 * "Paper laid on a desk" (design contract §3): a raised sheet with a dashed
 * hairline that receives the paper — on drag-over the border turns solid
 * vermilion and the sheet takes an accent wash. The whole zone is the click
 * target and a labelled file input.
 */
@Component({
  selector: 'app-upload-dropzone',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label
      class="dropzone"
      [class.dragging]="dragging()"
      (dragover)="onDragOver($event)"
      (dragleave)="dragging.set(false)"
      (drop)="onDrop($event)"
      data-test="dropzone"
    >
      <svg class="ti" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6.5 3.5h7l4 4v13h-11z" />
        <path d="M13.5 3.5v4h4" />
        <path d="M12 10v6M9.8 13.8 12 16l2.2-2.2" />
      </svg>
      <span class="dz-prompt">{{ prompt() }}</span>
      <span class="dz-hint">{{ hint() }}</span>
      <input
        type="file"
        aria-label="Choose PDF files to upload"
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
  readonly prompt = input('Drop PDFs here, or click to browse');
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
