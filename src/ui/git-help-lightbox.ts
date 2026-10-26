import { markPreviewOccluder, unmarkPreviewOccluder } from './preview-occlusion';
import { createGitWorktreeIcon } from './git-worktree-icons';
import { createIcon } from './icon';

const OVERLAY_ID = 'gitHelpLightboxOverlay';
const DIALOG_ID = 'gitHelpLightbox';
const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

let overlayEl: HTMLDivElement | null = null;
let dialogEl: HTMLDivElement | null = null;
let isOpen = false;
let previousFocus: HTMLElement | null = null;
let escapeHandler: ((e: KeyboardEvent) => void) | null = null;

// ── State ────────────────────────────────────────────────────────────────────

/** Whether the git help lightbox is open. */
export function isGitHelpLightboxOpen(): boolean {
  return isOpen;
}

function trapFocus(e: KeyboardEvent): void {
  if (!dialogEl || e.key !== 'Tab') return;
  const nodes = [...dialogEl.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hidden && el.getAttribute('aria-hidden') !== 'true',
  );
  if (nodes.length === 0) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function detachListeners(): void {
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler, true);
    escapeHandler = null;
  }
  document.removeEventListener('keydown', trapFocus, true);
}

// ── Diagrams ─────────────────────────────────────────────────────────────────

/** Build the branch timeline SVG used in the diagram. */
function createBranchTimelineSvg(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'git-help-diagram__timeline');
  svg.setAttribute('viewBox', '0 0 360 88');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Branch timeline: main and feature lines of commits');

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const trunkStyle = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  trunkStyle.textContent = `
    .git-help-tl-line { fill: none; stroke: var(--mn-border-strong); stroke-width: 2; stroke-linecap: round; }
    .git-help-tl-dot { fill: var(--mn-accent); }
    .git-help-tl-dot--branch { fill: color-mix(in oklch, var(--mn-accent) 55%, var(--mn-fg-muted)); }
    .git-help-tl-head { fill: var(--mn-success); stroke: var(--mn-bg); stroke-width: 2; }
    .git-help-tl-label { font: 600 11px var(--font-mono, ui-monospace, monospace); fill: var(--mn-fg-muted); }
  `;
  defs.appendChild(trunkStyle);
  svg.appendChild(defs);

  const mainLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  mainLabel.setAttribute('class', 'git-help-tl-label');
  mainLabel.setAttribute('x', '4');
  mainLabel.setAttribute('y', '18');
  mainLabel.textContent = 'main';

  const featureLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  featureLabel.setAttribute('class', 'git-help-tl-label');
  featureLabel.setAttribute('x', '4');
  featureLabel.setAttribute('y', '58');
  featureLabel.textContent = 'feature';

  const mainLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  mainLine.setAttribute('class', 'git-help-tl-line');
  mainLine.setAttribute('d', 'M52 28 H300');

  const branchFork = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  branchFork.setAttribute('class', 'git-help-tl-line');
  branchFork.setAttribute('d', 'M148 28 C148 28, 148 48, 168 48 H300');

  const featureLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  featureLine.setAttribute('class', 'git-help-tl-line');
  featureLine.setAttribute('d', 'M168 48 H300');

  svg.append(mainLabel, featureLabel, mainLine, branchFork, featureLine);

  const mainDots = [72, 108, 144, 180, 216, 252, 288];
  for (const x of mainDots) {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('class', x === 288 ? 'git-help-tl-head' : 'git-help-tl-dot');
    dot.setAttribute('cx', String(x));
    dot.setAttribute('cy', '28');
    dot.setAttribute('r', x === 288 ? '6' : '4');
    svg.appendChild(dot);
  }

  const featureDots = [200, 236, 272, 300];
  for (let i = 0; i < featureDots.length; i++) {
    const x = featureDots[i];
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute(
      'class',
      i === featureDots.length - 1 ? 'git-help-tl-head' : 'git-help-tl-dot git-help-tl-dot--branch',
    );
    dot.setAttribute('cx', String(x));
    dot.setAttribute('cy', '48');
    dot.setAttribute('r', i === featureDots.length - 1 ? '6' : '4');
    svg.appendChild(dot);
  }

  return svg;
}

/** Build the folder + shared repo diagram block. */
function createWorktreeDiagram(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'git-help-diagram';

  const repo = document.createElement('div');
  repo.className = 'git-help-diagram__repo';
  const repoIcon = document.createElement('span');
  repoIcon.className = 'git-help-diagram__repo-icon';
  repoIcon.textContent = '.git';
  const repoText = document.createElement('p');
  repoText.className = 'git-help-diagram__repo-text';
  repoText.textContent = 'One shared history for every checkout';
  repo.append(repoIcon, repoText);

  const connectors = document.createElement('div');
  connectors.className = 'git-help-diagram__connectors';
  connectors.setAttribute('aria-hidden', 'true');
  connectors.innerHTML =
    '<span class="git-help-diagram__stem"></span>' +
    '<span class="git-help-diagram__fork"></span>';

  const folders = document.createElement('div');
  folders.className = 'git-help-diagram__folders';

  const mainFolder = document.createElement('article');
  mainFolder.className = 'git-help-diagram__folder';
  const mainIcon = createGitWorktreeIcon('local', 'git-help-diagram__folder-icon');
  const mainTitle = document.createElement('h3');
  mainTitle.className = 'git-help-diagram__folder-title';
  mainTitle.textContent = 'Main folder';
  const mainBranch = document.createElement('p');
  mainBranch.className = 'git-help-diagram__folder-branch';
  mainBranch.textContent = 'Checked out: main';
  mainFolder.append(mainIcon, mainTitle, mainBranch);

  const wtFolder = document.createElement('article');
  wtFolder.className = 'git-help-diagram__folder';
  const wtIcon = createGitWorktreeIcon('worktree', 'git-help-diagram__folder-icon');
  const wtTitle = document.createElement('h3');
  wtTitle.className = 'git-help-diagram__folder-title';
  wtTitle.textContent = 'Linked worktree';
  const wtBranch = document.createElement('p');
  wtBranch.className = 'git-help-diagram__folder-branch';
  wtBranch.textContent = 'Checked out: feature';
  wtFolder.append(wtIcon, wtTitle, wtBranch);

  folders.append(mainFolder, wtFolder);

  const timeline = createBranchTimelineSvg();
  const caption = document.createElement('p');
  caption.className = 'git-help-diagram__caption';
  caption.textContent =
    'Branches are named commit lines. Worktrees are separate folders, each with its own checked-out branch.';

  wrap.append(repo, connectors, folders, timeline, caption);
  return wrap;
}

function createConceptCard(
  kind: 'branch' | 'worktree',
  title: string,
  body: string,
  bullets: string[],
): HTMLElement {
  const card = document.createElement('article');
  card.className = `git-help-concept git-help-concept--${kind}`;

  const hdr = document.createElement('header');
  hdr.className = 'git-help-concept__hdr';
  const icon = createGitWorktreeIcon(kind === 'branch' ? 'branch' : 'worktree', 'git-help-concept__icon');
  const heading = document.createElement('h3');
  heading.className = 'git-help-concept__title';
  heading.textContent = title;
  hdr.append(icon, heading);

  const text = document.createElement('p');
  text.className = 'git-help-concept__body';
  text.textContent = body;

  const list = document.createElement('ul');
  list.className = 'git-help-concept__list';
  for (const item of bullets) {
    const li = document.createElement('li');
    li.textContent = item;
    list.appendChild(li);
  }

  card.append(hdr, text, list);
  return card;
}

function createMinnowTips(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'git-help-tips';
  section.setAttribute('aria-labelledby', 'gitHelpTipsTitle');

  const title = document.createElement('h3');
  title.id = 'gitHelpTipsTitle';
  title.className = 'git-help-tips__title';
  title.textContent = 'In this panel';

  const list = document.createElement('dl');
  list.className = 'git-help-tips__list';

  const tips: { term: string; detail: string }[] = [
    {
      term: 'Checkout picker',
      detail: 'Click the branch above its worktree name to search branches or worktrees. A branch open in another worktree opens that checkout. New branch, Add worktree, and removal actions live inside the picker.',
    },
    {
      term: 'Uncommitted changes',
      detail: 'Switching branches asks whether to bring your changes or leave them saved in a stash. Returning to that branch in the same worktree offers Restore changes. Worktree browsing keeps each checkout’s files in place.',
    },
    {
      term: 'Composer run target',
      detail:
        'Chats can run tools in Local (main folder) or an isolated worktree. Browse here does not move the chat unless you pick a new run target.',
    },
    {
      term: 'Control Center',
      detail: 'Open the full repo map when you need merges, stashes, or every branch at once.',
    },
  ];

  for (const tip of tips) {
    const dt = document.createElement('dt');
    dt.textContent = tip.term;
    const dd = document.createElement('dd');
    dd.textContent = tip.detail;
    list.append(dt, dd);
  }

  section.append(title, list);
  return section;
}

// ── Shell ────────────────────────────────────────────────────────────────────

function buildBody(): HTMLElement {
  const body = document.createElement('div');
  body.className = 'git-help-body';

  const intro = document.createElement('p');
  intro.className = 'git-help-intro';
  intro.textContent =
    'Git keeps one repository history. Branches label different lines of work. Worktrees let you check out more than one branch in separate folders at the same time.';

  const concepts = document.createElement('div');
  concepts.className = 'git-help-concepts';
  concepts.append(
    createConceptCard('branch', 'Branch', 'A movable pointer to a line of commits.', [
      'Switch branches to move HEAD without copying files.',
      'Commits on one branch stay reachable when you switch away.',
      'Two branches cannot be checked out in the same folder at once.',
    ]),
    createConceptCard('worktree', 'Worktree', 'A linked checkout directory sharing the same .git data.', [
      'Each worktree has its own working files and active branch.',
      'Edit main and a feature branch side by side without stashing.',
      'Removing a worktree deletes the folder, not the branch history.',
    ]),
  );

  body.append(intro, createWorktreeDiagram(), concepts, createMinnowTips());
  return body;
}

function ensureShell(): void {
  if (overlayEl && dialogEl) return;

  overlayEl = document.createElement('div');
  overlayEl.id = OVERLAY_ID;
  overlayEl.className = 'git-help-overlay hidden';
  overlayEl.hidden = true;

  dialogEl = document.createElement('div');
  dialogEl.id = DIALOG_ID;
  dialogEl.className = 'git-help-lightbox';
  dialogEl.setAttribute('role', 'dialog');
  dialogEl.setAttribute('aria-modal', 'true');
  dialogEl.setAttribute('aria-labelledby', 'gitHelpTitle');
  dialogEl.tabIndex = -1;

  const header = document.createElement('header');
  header.className = 'git-help-header';
  const title = document.createElement('h2');
  title.id = 'gitHelpTitle';
  title.className = 'git-help-header__title';
  title.textContent = 'Worktrees & branches';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'icon-btn git-help-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.appendChild(createIcon('close'));
  closeBtn.addEventListener('click', () => closeGitHelpLightbox());

  header.append(title, closeBtn);
  dialogEl.append(header, buildBody());
  overlayEl.appendChild(dialogEl);
  document.body.appendChild(overlayEl);

  overlayEl.addEventListener('click', (e) => {
    if (e.target === overlayEl) closeGitHelpLightbox();
  });
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/** Open the worktrees & branches help lightbox. */
export function openGitHelpLightbox(): void {
  ensureShell();
  if (isOpen) return;

  previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  isOpen = true;
  overlayEl!.hidden = false;
  overlayEl!.classList.remove('hidden');
  document.getElementById('btnGitHelp')?.classList.add('is-active');
  markPreviewOccluder(overlayEl!, 'dialog');
  dialogEl!.focus();

  escapeHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeGitHelpLightbox();
    }
  };
  document.addEventListener('keydown', escapeHandler, true);
  document.addEventListener('keydown', trapFocus, true);
}

/** Close the help lightbox and restore focus. */
export function closeGitHelpLightbox(): void {
  if (!isOpen) return;
  isOpen = false;
  detachListeners();
  document.getElementById('btnGitHelp')?.classList.remove('is-active');
  overlayEl!.hidden = true;
  overlayEl!.classList.add('hidden');
  if (overlayEl) unmarkPreviewOccluder(overlayEl);
  previousFocus?.focus();
  previousFocus = null;
}

/** Wire the git panel help button. */
export function initGitHelpLightbox(): void {
  ensureShell();
  const btn = document.getElementById('btnGitHelp');
  btn?.addEventListener('click', () => openGitHelpLightbox());
}

/** Reset module state (tests). */
export function resetGitHelpLightboxForTests(): void {
  closeGitHelpLightbox();
  overlayEl?.remove();
  overlayEl = null;
  dialogEl = null;
}
