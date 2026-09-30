import '../styles/settings-general.css';
import '../styles/settings-skills-library.css';
import { refreshSkillCatalog, getAllSkillCatalog } from '../skills/client';
import {
  fetchLibraryPacks,
  fetchPackIndex,
  installPackSkills,
  installSkillFromGitHubUrl,
  removeInstalledLibrarySkill,
  removePackSkills,
  searchLibrarySkills,
  type LibraryPackSummary,
  type LibrarySearchHit,
  type LibraryInstallResult,
} from '../skills/library-api';
import type { SkillsLibraryIndexSkill } from '../skills/library/registry';
import { isLocalServerAvailable } from '../tools/config';
import { linkToSettingsSection } from './settings-layout';
import { appendSettingsOfflineHint } from './settings-controls';
import { setStatus } from './status';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function codeText(text: string): HTMLElement {
  const code = document.createElement('code');
  code.textContent = text;
  return code;
}

/** Trust badge label for pack cards. */
function trustBadgeLabel(trust: LibraryPackSummary['trust']): string {
  return trust === 'official' ? 'Official' : 'Community';
}

/** Whether a skill id is installed under ~/.minnow/skills/. */
function isSkillInstalled(skillId: string): boolean {
  return getAllSkillCatalog().some((skill) => skill.id === skillId && skill.source === 'user');
}

function installResultMessage(result: LibraryInstallResult): string {
  const counts = [`Installed ${result.installed.length}`];
  if (result.skipped.length) counts.push(`skipped ${result.skipped.length} already installed`);
  if (result.failed.length) {
    counts.push(`failed ${result.failed.length}: ${result.failed.map((row) => `/${row.skillId} (${row.error})`).join('; ')}`);
  }
  return counts.join(', ');
}

/** Render the Skills Library settings group body. */
export async function renderSkillsLibrarySettingsSection(mount: HTMLElement): Promise<void> {
  mount.replaceChildren();

  if (!isLocalServerAvailable()) {
    mount.appendChild(
      el(
        'p',
        'settings-server-banner',
        'Pack cards load offline from the shipped index. Install, remove, and add-from-URL need Minnow running locally.',
      ),
    );
  }

  const root = el('div', 'settings-skills-library');
  mount.appendChild(root);

  const githubSection = el('div', 'settings-skills-library__github');
  const githubTitle = el('h3', 'settings-skills-library__section-title', 'Add from GitHub URL');
  githubSection.appendChild(githubTitle);

  const githubHint = el('p', 'settings-field-hint');
  githubHint.append(
    'Paste a public GitHub repo URL (and optional subpath) to install a skill tree into ',
    codeText('~/.minnow/skills/'),
    '. Non-GitHub hosts are rejected. For authoring from scratch, use ',
    linkToSettingsSection('Skills catalog', 'skills'),
    ' or drop folders into ',
    codeText('~/.minnow/skills/'),
    '.',
  );
  githubSection.appendChild(githubHint);

  const githubForm = el('div', 'settings-skills-library__github-form');
  const repoInput = document.createElement('input');
  repoInput.type = 'url';
  repoInput.className = 'settings-input settings-skills-library__url-input';
  repoInput.placeholder = 'https://github.com/owner/repo';
  repoInput.autocomplete = 'off';
  repoInput.spellcheck = false;

  const subpathInput = document.createElement('input');
  subpathInput.type = 'text';
  subpathInput.className = 'settings-input settings-skills-library__subpath-input';
  subpathInput.placeholder = 'Optional subpath (e.g. skills/my-skill)';
  subpathInput.autocomplete = 'off';
  subpathInput.spellcheck = false;

  const githubInstallBtn = el(
    'button',
    'settings-action-btn settings-action-btn--primary',
    'Install from URL',
  );
  githubInstallBtn.type = 'button';
  githubInstallBtn.disabled = !isLocalServerAvailable();

  githubForm.append(repoInput, subpathInput, githubInstallBtn);
  githubSection.appendChild(githubForm);
  root.appendChild(githubSection);

  const searchSection = el('div', 'settings-skills-library__search');
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'settings-input settings-skills-library__search-input';
  searchInput.placeholder = 'Search skills across all packs…';
  searchInput.autocomplete = 'off';
  searchSection.appendChild(searchInput);
  root.appendChild(searchSection);

  const browsePanel = el('div', 'settings-skills-library__browse');
  const packGrid = el('div', 'settings-skills-library__pack-grid');
  browsePanel.appendChild(packGrid);
  root.appendChild(browsePanel);

  const detailPanel = el('div', 'settings-skills-library__detail hidden');
  root.appendChild(detailPanel);

  const searchResultsPanel = el('div', 'settings-skills-library__search-results hidden');
  root.appendChild(searchResultsPanel);

  let packs: LibraryPackSummary[] = [];
  let activePack: LibraryPackSummary | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  const showBrowse = (): void => {
    browsePanel.classList.remove('hidden');
    detailPanel.classList.add('hidden');
    searchResultsPanel.classList.add('hidden');
    activePack = null;
  };

  const showDetail = (): void => {
    browsePanel.classList.add('hidden');
    detailPanel.classList.remove('hidden');
    searchResultsPanel.classList.add('hidden');
  };

  const showSearchResults = (): void => {
    browsePanel.classList.add('hidden');
    detailPanel.classList.add('hidden');
    searchResultsPanel.classList.remove('hidden');
    activePack = null;
  };

  const refreshAfterMutation = async (): Promise<void> => {
    await refreshSkillCatalog();
    packs = await fetchLibraryPacks();
    renderPackGrid();
    if (activePack) {
      const updated = packs.find((pack) => pack.id === activePack!.id);
      if (updated) {
        activePack = updated;
        await openPackDetail(updated);
      }
    }
  };

  const renderPackCard = (pack: LibraryPackSummary): HTMLButtonElement => {
    const card = el('button', 'settings-skills-library__pack-card');
    card.type = 'button';
    card.dataset.packId = pack.id;

    const head = el('div', 'settings-skills-library__pack-head');
    const titleRow = el('div', 'settings-skills-library__pack-title-row');
    titleRow.appendChild(el('span', 'settings-skills-library__pack-label', pack.label));
    const trustBadge = el(
      'span',
      `settings-badge settings-badge--${pack.trust === 'official' ? 'builtin' : 'user'}`,
      trustBadgeLabel(pack.trust),
    );
    titleRow.appendChild(trustBadge);
    head.appendChild(titleRow);

    head.appendChild(
      el('span', 'settings-skills-library__pack-publisher', pack.publisher),
    );
    card.appendChild(head);

    card.appendChild(el('p', 'settings-skills-library__pack-desc', pack.description));

    const meta = el('div', 'settings-skills-library__pack-meta');
    meta.appendChild(
      el(
        'span',
        'settings-skills-library__pack-count',
        `${pack.installedCount} / ${pack.totalCount} installed`,
      ),
    );
    if (pack.runtimeNote) {
      meta.appendChild(
        el('span', 'settings-skills-library__runtime-note', pack.runtimeNote),
      );
    }
    card.appendChild(meta);

    if (pack.trust === 'community') {
      const warn = el(
        'p',
        'settings-skills-library__trust-warn',
        'Unvetted — installs run with your tool permissions.',
      );
      card.appendChild(warn);
    }

    card.addEventListener('click', () => {
      void openPackDetail(pack);
    });

    return card;
  };

  const renderPackGrid = (): void => {
    packGrid.replaceChildren();
    if (packs.length === 0) {
      packGrid.appendChild(el('p', 'settings-field-hint', 'No curated packs found.'));
      return;
    }
    for (const pack of packs) {
      packGrid.appendChild(renderPackCard(pack));
    }
  };

  const buildSkillRow = (
    pack: LibraryPackSummary,
    skill: SkillsLibraryIndexSkill,
    options?: { showPack?: boolean; checkbox?: HTMLInputElement },
  ): HTMLLIElement => {
    const row = el('li', 'settings-skills-library__skill-row');
    row.dataset.skillId = skill.skillId;

    if (options?.checkbox) {
      const checkCell = el('label', 'settings-skills-library__skill-check');
      checkCell.appendChild(options.checkbox);
      row.appendChild(checkCell);
    }

    const meta = el('div', 'settings-skills-library__skill-meta');
    const titleRow = el('div', 'settings-skills-library__skill-title-row');
    titleRow.appendChild(el('span', 'settings-skills-library__skill-label', skill.label));
    if (isSkillInstalled(skill.skillId)) {
      titleRow.appendChild(
        el('span', 'settings-badge settings-badge--user', 'Installed'),
      );
    }
    meta.appendChild(titleRow);
    meta.appendChild(el('span', 'settings-skills-library__skill-id', `/${skill.skillId}`));
    meta.appendChild(
      el('p', 'settings-skills-library__skill-desc', skill.description || 'No description.'),
    );

    const provenance = el('p', 'settings-skills-library__skill-provenance');
    if (options?.showPack) {
      provenance.textContent = `Pack: ${pack.label}`;
    } else {
      provenance.textContent = `From ${pack.publisher} · ${pack.source.repo}@${pack.source.commit.slice(0, 7)}`;
    }
    meta.appendChild(provenance);
    row.appendChild(meta);

    const actions = el('div', 'settings-skills-library__skill-actions');
    if (isSkillInstalled(skill.skillId)) {
      const removeBtn = el('button', 'settings-action-btn settings-action-btn--danger', 'Remove');
      removeBtn.type = 'button';
      removeBtn.disabled = !isLocalServerAvailable();
      removeBtn.addEventListener('click', () => {
        void (async () => {
          try {
            await removeInstalledLibrarySkill(skill.skillId);
            setStatus('ok', `Removed /${skill.skillId}`);
            await refreshAfterMutation();
          } catch (err) {
            setStatus('err', err instanceof Error ? err.message : 'Remove failed');
          }
        })();
      });
      actions.appendChild(removeBtn);
    } else {
      const installBtn = el('button', 'settings-action-btn', 'Install');
      installBtn.type = 'button';
      installBtn.disabled = !isLocalServerAvailable();
      installBtn.addEventListener('click', () => {
        void (async () => {
          try {
            const result = await installPackSkills(pack.id, { skillIds: [skill.skillId] });
            setStatus(result.failed.length ? 'err' : 'ok', installResultMessage(result));
            await refreshAfterMutation();
          } catch (err) {
            setStatus('err', err instanceof Error ? err.message : 'Install failed');
          }
        })();
      });
      actions.appendChild(installBtn);
    }
    row.appendChild(actions);

    return row;
  };

  const openPackDetail = async (pack: LibraryPackSummary): Promise<void> => {
    activePack = pack;
    showDetail();
    detailPanel.replaceChildren();

    const backBtn = el('button', 'settings-skills-library__back', '← All packs');
    backBtn.type = 'button';
    backBtn.addEventListener('click', showBrowse);
    detailPanel.appendChild(backBtn);

    const header = el('div', 'settings-skills-library__detail-header');
    const titleRow = el('div', 'settings-skills-library__pack-title-row');
    titleRow.appendChild(el('h3', 'settings-skills-library__detail-title', pack.label));
    titleRow.appendChild(
      el(
        'span',
        `settings-badge settings-badge--${pack.trust === 'official' ? 'builtin' : 'user'}`,
        trustBadgeLabel(pack.trust),
      ),
    );
    header.appendChild(titleRow);
    header.appendChild(
      el('p', 'settings-skills-library__pack-publisher', `${pack.publisher} · ${pack.installedCount} / ${pack.totalCount} installed`),
    );
    header.appendChild(el('p', 'settings-skills-library__pack-desc', pack.description));

    if (pack.runtimeNote) {
      header.appendChild(
        el('p', 'settings-skills-library__runtime-note settings-skills-library__runtime-note--block', pack.runtimeNote),
      );
    }
    if (pack.trust === 'community') {
      header.appendChild(
        el(
          'p',
          'settings-skills-library__trust-warn',
          'Unvetted — installs run with your tool permissions.',
        ),
      );
    }
    detailPanel.appendChild(header);

    const filterInput = document.createElement('input');
    filterInput.type = 'search';
    filterInput.className = 'settings-input settings-skills-library__filter-input';
    filterInput.placeholder = 'Filter skills in this pack…';
    detailPanel.appendChild(filterInput);

    const toolbar = el('div', 'settings-actions settings-skills-library__detail-toolbar');
    const installSelectedBtn = el('button', 'settings-action-btn', 'Install selected');
    installSelectedBtn.type = 'button';
    installSelectedBtn.disabled = true;
    const installAllBtn = el(
      'button',
      'settings-action-btn settings-action-btn--primary',
      'Install all',
    );
    installAllBtn.type = 'button';
    installAllBtn.disabled = !isLocalServerAvailable();
    const removeAllBtn = el(
      'button',
      'settings-action-btn settings-action-btn--danger settings-skills-library__remove-all',
      'Remove all',
    );
    removeAllBtn.type = 'button';
    removeAllBtn.disabled = !isLocalServerAvailable() || pack.installedCount === 0;
    toolbar.append(installSelectedBtn, installAllBtn, removeAllBtn);
    detailPanel.appendChild(toolbar);

    const list = el('ul', 'settings-skills-library__skill-list');
    detailPanel.appendChild(list);

    let index;
    try {
      index = await fetchPackIndex(pack.id);
    } catch (err) {
      list.appendChild(
        el(
          'li',
          'settings-field-hint',
          err instanceof Error ? err.message : 'Could not load pack index.',
        ),
      );
      return;
    }

    const selected = new Set<string>();
    const checkboxes = new Map<string, HTMLInputElement>();

    const syncInstallSelected = (): void => {
      installSelectedBtn.disabled =
        !isLocalServerAvailable() || selected.size === 0;
    };

    const redrawSkills = (): void => {
      const q = filterInput.value.trim().toLowerCase();
      list.replaceChildren();
      const skills = index.skills.filter((skill) => {
        if (!q) return true;
        const haystack = `${skill.skillId} ${skill.label} ${skill.description}`.toLowerCase();
        return haystack.includes(q);
      });

      if (skills.length === 0) {
        list.appendChild(el('li', 'settings-field-hint', 'No skills match this filter.'));
        return;
      }

      for (const skill of skills) {
        if (!isSkillInstalled(skill.skillId)) {
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = selected.has(skill.skillId);
          checkbox.addEventListener('change', () => {
            if (checkbox.checked) selected.add(skill.skillId);
            else selected.delete(skill.skillId);
            syncInstallSelected();
          });
          checkboxes.set(skill.skillId, checkbox);
          list.appendChild(buildSkillRow(pack, skill, { checkbox }));
        } else {
          list.appendChild(buildSkillRow(pack, skill));
        }
      }
    };

    filterInput.addEventListener('input', redrawSkills);

    installSelectedBtn.addEventListener('click', () => {
      void (async () => {
        const ids = [...selected];
        if (ids.length === 0) return;
        try {
          const result = await installPackSkills(pack.id, { skillIds: ids });
          setStatus(result.failed.length ? 'err' : 'ok', installResultMessage(result));
          for (const row of result.installed) selected.delete(row.skillId);
          await refreshAfterMutation();
        } catch (err) {
          setStatus('err', err instanceof Error ? err.message : 'Install failed');
        }
      })();
    });

    installAllBtn.addEventListener('click', () => {
      void (async () => {
        try {
          const result = await installPackSkills(pack.id, { all: true });
          setStatus(result.failed.length ? 'err' : 'ok', installResultMessage(result));
          await refreshAfterMutation();
        } catch (err) {
          setStatus('err', err instanceof Error ? err.message : 'Install failed');
        }
      })();
    });

    removeAllBtn.addEventListener('click', () => {
      void (async () => {
        try {
          const result = await removePackSkills(pack.id);
          const failures = result.failed.map((row) => `/${row.skillId} (${row.error})`).join('; ');
          setStatus(result.failed.length ? 'err' : 'ok',
            `Removed ${result.removed.length} skill(s) from ${pack.label}` +
            (failures ? `; kept ${failures}` : ''));
          await refreshAfterMutation();
        } catch (err) {
          setStatus('err', err instanceof Error ? err.message : 'Remove failed');
        }
      })();
    });

    redrawSkills();
  };

  const renderSearchResults = (query: string, hits: LibrarySearchHit[]): void => {
    searchResultsPanel.replaceChildren();

    const header = el('div', 'settings-skills-library__search-header');
    const backBtn = el('button', 'settings-skills-library__back', '← All packs');
    backBtn.type = 'button';
    backBtn.addEventListener('click', () => {
      searchInput.value = '';
      showBrowse();
    });
    header.appendChild(backBtn);
    header.appendChild(
      el('p', 'settings-skills-library__search-summary', `${hits.length} result(s) for “${query}”`),
    );
    searchResultsPanel.appendChild(header);

    const list = el('ul', 'settings-skills-library__skill-list');
    if (hits.length === 0) {
      list.appendChild(el('li', 'settings-field-hint', 'No skills matched your search.'));
    } else {
      const packById = new Map(packs.map((pack) => [pack.id, pack]));
      for (const hit of hits) {
        const pack = packById.get(hit.packId);
        if (!pack) continue;
        list.appendChild(buildSkillRow(pack, hit.skill, { showPack: true }));
      }
    }
    searchResultsPanel.appendChild(list);
  };

  searchInput.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    const query = searchInput.value.trim();
    if (!query) {
      showBrowse();
      return;
    }
    searchTimer = setTimeout(() => {
      void (async () => {
        showSearchResults();
        const hits = await searchLibrarySkills(query);
        renderSearchResults(query, hits);
      })();
    }, 200);
  });

  githubInstallBtn.addEventListener('click', () => {
    void (async () => {
      const repoUrl = repoInput.value.trim();
      if (!repoUrl) {
        setStatus('err', 'Enter a GitHub repository URL.');
        return;
      }
      try {
        const installed = await installSkillFromGitHubUrl(repoUrl, subpathInput.value);
        const id = installed[0]?.skillId ?? 'skill';
        setStatus('ok', `Installed /${id} from GitHub`);
        repoInput.value = '';
        subpathInput.value = '';
        await refreshAfterMutation();
      } catch (err) {
        setStatus('err', err instanceof Error ? err.message : 'Install failed');
      }
    })();
  });

  packs = await fetchLibraryPacks();
  renderPackGrid();
  appendSettingsOfflineHint(mount, 'Skills Library install/remove needs Minnow running locally.');
}
