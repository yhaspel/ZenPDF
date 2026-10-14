import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FitWidth } from './fit-width';

@Component({
  imports: [FitWidth],
  template: '<div zenFitWidth (fitWidth)="widths.push($event)" data-test="pane"></div>',
})
class Host {
  readonly widths: number[] = [];
}

/**
 * jsdom has no `ResizeObserver` and no layout. This one records what it was
 * asked to watch and lets a test feed it the entries a browser would, so the
 * directive's arithmetic and its change gate can be asserted.
 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed: Element[] = [];
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  unobserve(): void { /* unused */ }

  disconnect(): void {
    this.disconnected = true;
  }

  /** The browser reports a content-box inline size for the observed pane. */
  resize(inlineSize: number): void {
    const entry = {
      target: this.observed[0],
      contentBoxSize: [{ inlineSize, blockSize: 0 }],
    } as unknown as ResizeObserverEntry;
    this.callback([entry], this as unknown as ResizeObserver);
  }
}

/**
 * The scroller's content-box inline size, as an event — and only on a real
 * change, so a page fitted to its pane does not re-fit on every paint.
 */
describe('FitWidth', () => {
  let fixture: ComponentFixture<Host>;
  const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

  function observer(): FakeResizeObserver {
    return FakeResizeObserver.instances[0];
  }

  beforeEach(() => {
    FakeResizeObserver.instances = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  });

  afterEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
  });

  function build(): void {
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
  }

  it('watches the pane itself, not the window', () => {
    build();
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(observer().observed).toEqual([fixture.nativeElement.querySelector('[data-test=pane]')]);
  });

  it.each([
    [327.4, 327],
    [327.5, 328],
    [1024, 1024],
  ])('reports the content-box inline size %f rounded to %i', (measured, expected) => {
    build();
    observer().resize(measured);
    expect(fixture.componentInstance.widths).toEqual([expected]);
  });

  it('emits once per distinct width and swallows repeats', () => {
    build();
    observer().resize(640);
    observer().resize(640);
    observer().resize(640.2);
    observer().resize(720);
    observer().resize(640);
    expect(fixture.componentInstance.widths).toEqual([640, 720, 640]);
  });

  it('never reports a zero — a pane that is not laid out keeps its seeded width', () => {
    build();
    observer().resize(0);
    expect(fixture.componentInstance.widths).toEqual([]);
    observer().resize(500);
    expect(fixture.componentInstance.widths).toEqual([500]);
  });

  it('stops observing when the pane is destroyed', () => {
    build();
    expect(observer().disconnected).toBe(false);
    fixture.destroy();
    expect(observer().disconnected).toBe(true);
  });

  it('degrades to nothing where there is no ResizeObserver', () => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    expect(() => build()).not.toThrow();
    expect(FakeResizeObserver.instances).toHaveLength(0);
    expect(fixture.componentInstance.widths).toEqual([]);
  });
});
