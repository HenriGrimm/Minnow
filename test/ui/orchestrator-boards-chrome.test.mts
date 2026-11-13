import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { Window } from 'happy-dom';

describe('Code stage chrome', () => {
  test('stage views hide the legacy drawer and keep the shared desktop sidebar available', async () => {
    const css = ['code-chrome', 'super-plan-page'].map(name =>
      readFileSync(new URL(`../../src/styles/${name}.css`, import.meta.url), 'utf8'),
    ).join('\n');
    const stages = [
      { id: 'devServerScreenRoot' },
      { id: 'orchestratorBoardsRoot' },
      { id: 'codeBrainMapRoot' },
      { id: 'superPlanPage', htmlClass: 'mn-super-plan-open' },
    ];
    for (const { id, htmlClass } of stages) {
      for (const desktop of [false, true]) {
        const window = new Window();
        try {
          const { document } = window;
          if (desktop) document.documentElement.classList.add('mn-graphite-workspace', 'mn-graphite-sidebar-open');
          if (htmlClass) document.documentElement.classList.add(htmlClass);
          // Happy DOM's CSS selector parser expects functional selectors on one line.
          document.head.innerHTML = `<style>${css.replace(/\s*\n\s*/g, ' ')}</style>`;
          document.body.innerHTML = `
            <aside id="chatSidebar"><div id="chatSidebarResizer"></div></aside>
            <button id="sidebarBackdrop"></button>
            <button id="btnCodeViewsChats"></button>
            <main id="${id}"></main>
          `;
          for (const control of ['chatSidebar', 'chatSidebarResizer', 'sidebarBackdrop', 'btnCodeViewsChats']) {
            const display = window.getComputedStyle(document.getElementById(control)!).display;
            assert.equal(display === 'none', !desktop && control !== 'btnCodeViewsChats', `${id} ${control} desktop=${desktop}`);
          }
        } finally {
          await window.happyDOM.close();
        }
      }
    }
  });

  test('hides the Code composer while the Boards surface is mounted', () => {
    const css = readFileSync(
      new URL('../../src/styles/orchestrator-boards.css', import.meta.url),
      'utf8',
    );
    const marker = '.main-column.main-column--orchestrator-boards .input-bar';
    const start = css.indexOf(marker);
    assert.ok(start >= 0, 'composer hide selector must exist');
    const rule = css.slice(start, css.indexOf('}', start));
    assert.ok(rule.includes('display: none'), 'composer hide must be display:none');
  });
});
