import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Window } from 'happy-dom';
import {
  acquireTickedMotion,
  isTickedMotionActive,
  parkRunningInfinite,
  resumeParked,
  stepParked,
  type SteppableAnimation,
} from '../../src/ui/motion-ticker.ts';

type Globals = typeof globalThis & {
  document: Document;
  window: Window;
  MutationObserver: typeof MutationObserver;
};

/** Mount a happy-dom window as the ambient globals the module reads. */
function mountWindow(): { win: Window; restore: () => void } {
  const win = new Window();
  const g = globalThis as Globals;
  const prevDoc = g.document;
  const prevWin = g.window;
  const prevObserver = g.MutationObserver;
  g.document = win.document as unknown as Document;
  g.window = win;
  g.MutationObserver = win.MutationObserver as unknown as typeof MutationObserver;
  return {
    win,
    restore: () => {
      g.document = prevDoc;
      g.window = prevWin;
      g.MutationObserver = prevObserver;
      win.close();
    },
  };
}

type GetAnimationsFn = (opts?: { subtree?: boolean }) => SteppableAnimation[];

/** happy-dom has no Web Animations API — install a stub we can count. */
function installGetAnimations(
  target: { getAnimations?: GetAnimationsFn },
  impl: GetAnimationsFn,
): void {
  target.getAnimations = impl;
}

/** Stand-in for a CSSAnimation: happy-dom implements no Web Animations API. */
class FakeAnimation implements SteppableAnimation {
  playState: string;
  currentTime: number | null;
  readonly effect: { getTiming(): { iterations?: number } } | null;
  plays = 0;
  pauses = 0;

  constructor(opts: { iterations?: number; playState?: string; currentTime?: number | null } = {}) {
    this.playState = opts.playState ?? 'running';
    this.currentTime = opts.currentTime ?? 0;
    const iterations = 'iterations' in opts ? opts.iterations : Infinity;
    this.effect = { getTiming: () => ({ iterations }) };
  }

  pause(): void {
    this.pauses += 1;
    this.playState = 'paused';
  }

  play(): void {
    this.plays += 1;
    this.playState = 'running';
  }
}

describe('ticked motion', () => {
  let release: (() => void) | null = null;
  let restore: (() => void) | null = null;

  afterEach(() => {
    release?.();
    release = null;
    restore?.();
    restore = null;
  });

  it('parks running infinite animations and leaves finite ones alone', () => {
    const looping = new FakeAnimation({ iterations: Infinity });
    const reveal = new FakeAnimation({ iterations: 1 });
    const parked = new Set<SteppableAnimation>();

    parkRunningInfinite([looping, reveal], parked);

    assert.equal(looping.playState, 'paused');
    // A panel reveal is a fifth of a second of frames; freezing it would look broken.
    assert.equal(reveal.playState, 'running');
    assert.equal(parked.size, 1);
  });

  it('parks animations that only start mid-generation', () => {
    const first = new FakeAnimation();
    const parked = new Set<SteppableAnimation>();
    parkRunningInfinite([first], parked);

    // A spinner appearing later would otherwise run at full rate for the rest of the turn
    // and cost the whole saving on its own.
    const late = new FakeAnimation();
    parkRunningInfinite([first, late], parked);

    assert.equal(late.playState, 'paused');
    assert.equal(parked.size, 2);
    assert.equal(first.pauses, 1, 'an already-parked animation must not be re-paused');
  });

  it('advances parked animations by one tick each step', () => {
    const anim = new FakeAnimation({ currentTime: 40 });
    const parked = new Set<SteppableAnimation>([anim]);
    anim.pause();

    stepParked(125, parked);
    assert.equal(anim.currentTime, 165);
    stepParked(125, parked);
    assert.equal(anim.currentTime, 290);
    // Stepping must not restart it — a running animation is the whole cost.
    assert.equal(anim.playState, 'paused');
  });

  it('drops cancelled animations instead of resurrecting them', () => {
    const gone = new FakeAnimation({ playState: 'idle', currentTime: 10 });
    const live = new FakeAnimation({ playState: 'paused', currentTime: 10 });
    const parked = new Set<SteppableAnimation>([gone, live]);

    stepParked(125, parked);

    assert.equal(parked.size, 1);
    assert.equal(gone.currentTime, 10, 'a cancelled animation must not be stepped');
    assert.equal(live.currentTime, 135);

    resumeParked(parked);
    assert.equal(gone.plays, 0, 'resuming must not revive a cancelled animation');
  });

  it('hands animations back to the compositor on resume', () => {
    const anim = new FakeAnimation();
    const parked = new Set<SteppableAnimation>();
    parkRunningInfinite([anim], parked);

    resumeParked(parked);

    assert.equal(anim.playState, 'running');
    assert.equal(anim.plays, 1);
    assert.equal(parked.size, 0);
  });

  it('flags ticked motion on the root for the life of the lease', () => {
    const mounted = mountWindow();
    restore = mounted.restore;

    assert.equal(isTickedMotionActive(), false);
    release = acquireTickedMotion();

    assert.equal(isTickedMotionActive(), true);
    assert.equal(mounted.win.document.documentElement.getAttribute('data-mn-motion'), 'ticked');

    release();
    release = null;
    assert.equal(isTickedMotionActive(), false);
    assert.equal(mounted.win.document.documentElement.hasAttribute('data-mn-motion'), false);
  });

  it('keeps stepping until the last overlapping generation releases', () => {
    const mounted = mountWindow();
    restore = mounted.restore;

    const first = acquireTickedMotion();
    const second = acquireTickedMotion();
    release = () => {
      first();
      second();
    };

    first();
    assert.equal(isTickedMotionActive(), true);

    second();
    assert.equal(isTickedMotionActive(), false);

    // Releasing twice must not unbalance the refcount for a concurrent generation.
    second();
    assert.equal(isTickedMotionActive(), false);
  });

  it('does not call document.getAnimations on a timer while ticking', async () => {
    const mounted = mountWindow();
    restore = mounted.restore;
    const doc = mounted.win.document as unknown as { getAnimations?: GetAnimationsFn };
    const calls: number[] = [];
    const existing = new FakeAnimation();
    installGetAnimations(doc, () => {
      calls.push(Date.now());
      return [existing];
    });

    release = acquireTickedMotion();
    const afterAcquire = calls.length;
    assert.ok(afterAcquire >= 1, 'acquire parks existing animations once');
    assert.equal(existing.playState, 'paused');

    // Longer than the old 250 ms rescan so a leftover timer would have fired.
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(
      calls.length,
      afterAcquire,
      'getAnimations must not run on a 250 ms interval while stepping',
    );
  });

  it('parks newly inserted looping animations on animationstart', async () => {
    const mounted = mountWindow();
    restore = mounted.restore;
    const doc = mounted.win.document as unknown as { getAnimations?: GetAnimationsFn };
    installGetAnimations(doc, () => []);

    release = acquireTickedMotion();

    const late = new FakeAnimation();
    const spinner = mounted.win.document.createElement('div');
    installGetAnimations(
      spinner as unknown as { getAnimations?: GetAnimationsFn },
      () => [late],
    );
    let rootSubtreeWalks = 0;
    installGetAnimations(
      mounted.win.document.documentElement as unknown as { getAnimations?: GetAnimationsFn },
      (opts) => {
        if (opts?.subtree) rootSubtreeWalks += 1;
        return [];
      },
    );
    mounted.win.document.body.appendChild(spinner);
    spinner.dispatchEvent(new mounted.win.Event('animationstart', { bubbles: true }));

    const started = Date.now();
    while (late.playState !== 'paused' && Date.now() - started < 250) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(late.playState, 'paused', 'mid-turn spinner must be parked without a sweep timer');
    // A whole-document walk forces a style update; during streaming that is every frame (MIN-793).
    assert.equal(rootSubtreeWalks, 0, 'discovery must be scoped to the added subtree');
  });

  it('does not discover animations from ordinary streamed Markdown insertions', async () => {
    const mounted = mountWindow();
    restore = mounted.restore;
    const doc = mounted.win.document as unknown as { getAnimations?: GetAnimationsFn };
    let walks = 0;
    installGetAnimations(doc, () => { walks += 1; return []; });
    release = acquireTickedMotion();
    const initial = walks;
    installGetAnimations(mounted.win.document.documentElement, () => { walks += 1; return []; });
    for (let i = 0; i < 40; i += 1) {
      const paragraph = mounted.win.document.createElement('p');
      installGetAnimations(paragraph, () => { walks += 1; return []; });
      mounted.win.document.body.appendChild(paragraph);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(walks, initial, 'prose changes never force animation/style discovery');
  });

  it('parks looping animations that start via animationstart on existing chrome', () => {
    const mounted = mountWindow();
    restore = mounted.restore;
    const doc = mounted.win.document as unknown as { getAnimations?: GetAnimationsFn };
    installGetAnimations(doc, () => []);

    release = acquireTickedMotion();

    const late = new FakeAnimation();
    const dots = mounted.win.document.createElement('span');
    installGetAnimations(dots as unknown as { getAnimations?: GetAnimationsFn }, () => [late]);
    mounted.win.document.body.appendChild(dots);
    dots.dispatchEvent(new mounted.win.Event('animationstart', { bubbles: true }));

    assert.equal(late.playState, 'paused');
  });
});
