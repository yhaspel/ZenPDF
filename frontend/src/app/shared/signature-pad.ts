import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { EsignService } from '../core/services/esign.service';

export type SignatureTab = 'draw' | 'type' | 'upload';

export const SIGNATURE_FONTS = [
  { value: 'caveat', label: 'Caveat' },
  { value: 'dancing', label: 'Dancing Script' },
  { value: 'great-vibes', label: 'Great Vibes' },
  { value: 'sacramento', label: 'Sacramento' },
];

/**
 * Make a signature: draw it, type it, or photograph one on paper (phase-08).
 *
 * Emits a PNG data URL and stores nothing. That is what lets the same dialog
 * serve an account picking from its library, a guest signing a document with
 * no account at all, and an external signer in the ceremony who has no
 * ZenPDF anything.
 *
 * The drawing surface is a plain canvas with pointer events rather than a
 * signature-pad dependency: it is sixty lines, it works with a mouse, a finger
 * and a stylus, and a signing ceremony is the last place to add third-party
 * script.
 */
@Component({
  selector: 'app-signature-pad',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="w-full" data-test="signature-pad">
      <div class="mb-3 flex gap-1 text-xs">
        @for (t of tabs; track t.value) {
          <button type="button" class="rounded-full border px-3 py-1"
                  [class.border-indigo-500]="tab() === t.value"
                  [class.bg-indigo-50]="tab() === t.value"
                  [class.text-indigo-700]="tab() === t.value"
                  [class.border-slate-300]="tab() !== t.value"
                  (click)="tab.set(t.value)"
                  [attr.data-test]="'sig-tab-' + t.value">{{ t.label }}</button>
        }
      </div>

      @switch (tab()) {
        @case ('draw') {
          <canvas #pad
                  class="w-full touch-none rounded-lg border border-slate-300 bg-white"
                  [width]="width()" [height]="height()"
                  (pointerdown)="down($event)"
                  (pointermove)="move($event)"
                  (pointerup)="up()"
                  (pointerleave)="up()"
                  data-test="sig-canvas"></canvas>
          <p class="mt-1 text-[11px] text-slate-500">
            Draw with a finger, a stylus or the mouse.
          </p>
        }
        @case ('type') {
          <input class="w-full rounded-lg border border-slate-300 px-3 py-2"
                 placeholder="Type your name"
                 [ngModel]="typed()" (ngModelChange)="onTyped($event)"
                 data-test="sig-text" />
          <div class="mt-2 flex flex-wrap gap-1 text-xs">
            @for (font of fonts; track font.value) {
              <button type="button" class="rounded-full border px-3 py-1"
                      [class.border-indigo-500]="chosenFont() === font.value"
                      [class.bg-indigo-50]="chosenFont() === font.value"
                      [class.border-slate-300]="chosenFont() !== font.value"
                      (click)="chooseFont(font.value)"
                      [attr.data-test]="'sig-font-' + font.value">
                {{ font.label }}
              </button>
            }
          </div>
          @if (preview()) {
            <img [src]="preview()" alt="Your typed signature"
                 class="mt-3 max-h-24 rounded border border-slate-200 bg-white p-2"
                 data-test="sig-preview" />
          }
        }
        @case ('upload') {
          <label class="block text-xs text-slate-500">
            A photo or scan of your signature
            <input type="file" accept="image/png,image/jpeg" class="mt-1 w-full text-xs"
                   aria-label="Choose a signature image"
                   (change)="onFile($event)" data-test="sig-file" />
          </label>
          <p class="mt-1 text-[11px] text-slate-500">
            The paper is removed by brightness, which is crude: a dark or
            shadowed photo comes back as a dark blob. Drawing gives a better
            result.
          </p>
          @if (preview()) {
            <img [src]="preview()" alt="Your signature"
                 class="mt-3 max-h-24 rounded border border-slate-200 bg-white p-2"
                 data-test="sig-preview" />
          }
        }
      }

      <div class="mt-3 flex items-center gap-2">
        <button type="button"
                class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                [disabled]="!hasInk()" (click)="use()" data-test="sig-use">
          {{ useLabel() }}
        </button>
        <button type="button" class="rounded-lg px-3 py-2 text-sm text-slate-500"
                (click)="clear()" data-test="sig-clear">Clear</button>
      </div>
    </div>
  `,
})
export class SignaturePad {
  readonly width = input(600);
  readonly height = input(200);
  readonly useLabel = input('Use this signature');

  /** A PNG data URL. Nothing is stored anywhere by this component. */
  readonly chosen = output<string>();

  private esign = inject(EsignService);
  private canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('pad');

  protected readonly tabs: { value: SignatureTab; label: string }[] = [
    { value: 'draw', label: 'Draw' },
    { value: 'type', label: 'Type' },
    { value: 'upload', label: 'Upload' },
  ];
  protected readonly fonts = SIGNATURE_FONTS;

  protected tab = signal<SignatureTab>('draw');
  protected typed = signal('');
  protected chosenFont = signal('caveat');
  protected preview = signal<string | null>(null);
  protected drawn = signal(false);

  private drawing = false;
  private last: [number, number] | null = null;

  protected readonly hasInk = computed(() =>
    this.tab() === 'draw' ? this.drawn() : !!this.preview(),
  );

  // ------------------------------------------------------------------ //
  // Draw
  // ------------------------------------------------------------------ //
  private context(): CanvasRenderingContext2D | null {
    const canvas = this.canvasRef()?.nativeElement;
    return canvas ? canvas.getContext('2d') : null;
  }

  private point(event: PointerEvent): [number, number] {
    const canvas = this.canvasRef()!.nativeElement;
    const box = canvas.getBoundingClientRect();
    // The canvas is laid out responsively but has a fixed backing size, so
    // pointer coordinates have to be scaled or the ink lands off the stroke.
    return [
      ((event.clientX - box.left) / box.width) * canvas.width,
      ((event.clientY - box.top) / box.height) * canvas.height,
    ];
  }

  protected down(event: PointerEvent): void {
    const ctx = this.context();
    if (!ctx) return;
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    this.drawing = true;
    this.last = this.point(event);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#0f172a';
  }

  protected move(event: PointerEvent): void {
    if (!this.drawing) return;
    const ctx = this.context();
    if (!ctx || !this.last) return;
    const [x, y] = this.point(event);
    ctx.beginPath();
    ctx.moveTo(this.last[0], this.last[1]);
    ctx.lineTo(x, y);
    ctx.stroke();
    this.last = [x, y];
    this.drawn.set(true);
  }

  protected up(): void {
    this.drawing = false;
    this.last = null;
  }

  // ------------------------------------------------------------------ //
  // Type / upload
  // ------------------------------------------------------------------ //
  protected onTyped(value: string): void {
    this.typed.set(value);
    this.refreshTyped();
  }

  protected chooseFont(font: string): void {
    this.chosenFont.set(font);
    this.refreshTyped();
  }

  private typingTimer: ReturnType<typeof setTimeout> | null = null;

  private refreshTyped(): void {
    // Debounced: this is a server render, and one request per keystroke is a
    // request storm on the connection a signer is most likely to be using.
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.renderTyped(), 250);
  }

  private renderTyped(): void {
    const text = this.typed().trim();
    if (!text) {
      this.preview.set(null);
      return;
    }
    // Rendered by the server, in the fonts vendored there — the browser has no
    // copy, and fetching one from Google would tell Google who is signing.
    this.esign.renderTyped(text, this.chosenFont()).subscribe({
      next: (blob) => this.toDataUrl(blob),
      error: () => this.preview.set(null),
    });
  }

  protected onFile(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) this.toDataUrl(file);
  }

  private toDataUrl(blob: Blob): void {
    const reader = new FileReader();
    reader.onload = () => this.preview.set(String(reader.result));
    reader.readAsDataURL(blob);
  }

  // ------------------------------------------------------------------ //
  protected clear(): void {
    const ctx = this.context();
    const canvas = this.canvasRef()?.nativeElement;
    if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.drawn.set(false);
    this.preview.set(null);
    this.typed.set('');
  }

  protected use(): void {
    if (this.tab() === 'draw') {
      const canvas = this.canvasRef()?.nativeElement;
      if (!canvas) return;
      this.chosen.emit(canvas.toDataURL('image/png'));
      return;
    }
    const preview = this.preview();
    if (preview) this.chosen.emit(preview);
  }
}
