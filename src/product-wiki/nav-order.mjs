/** Sidebar section order in the in-app wiki (matches documentation/manual/README.md). */
export const PRODUCT_WIKI_NAV_SECTION_ORDER = [
  'Overview',
  'Get started',
  'Core concepts',
  'Chat',
  'Apps',
  'Orchestrate',
  'Extend Minnow',
  'Reference',
  'Roadmap',
  'Legal',
];

/** Page order within the shipped manual (overview first, apps in reader flow). */
export const PRODUCT_WIKI_NAV_PATH_ORDER = [
  'documentation/manual/README.md',
  'documentation/manual/get-started/install.md',
  'documentation/manual/get-started/connect-a-model.md',
  'documentation/manual/get-started/first-chat.md',
  'documentation/manual/concepts/how-minnow-works.md',
  'documentation/manual/concepts/modes.md',
  'documentation/manual/concepts/tools-and-permissions.md',
  'documentation/manual/concepts/context-and-memory.md',
  'documentation/manual/chat/chatting.md',
  'documentation/manual/chat/skills-and-commands.md',
  'documentation/manual/apps/overview.md',
  'documentation/manual/apps/code.md',
  'documentation/manual/apps/research.md',
  'documentation/manual/apps/brain.md',
  'documentation/manual/apps/models.md',
  'documentation/manual/apps/issues.md',
  'documentation/manual/apps/scheduler.md',
  'documentation/manual/apps/settings.md',
  'documentation/manual/orchestrate/boards.md',
  'documentation/manual/orchestrate/agents.md',
  'documentation/manual/extend/integrations.md',
  'documentation/manual/extend/voice.md',
  'documentation/manual/extend/companion.md',
  'documentation/manual/reference/keyboard-shortcuts.md',
  'documentation/manual/reference/configuration.md',
  'documentation/manual/reference/privacy-and-security.md',
  'documentation/manual/reference/troubleshooting.md',
  'documentation/manual/reference/glossary.md',
  'documentation/manual/reference/wiki-and-brain.md',
  'documentation/manual/reference/roadmap.md',
  'documentation/ROADMAP.md',
  'documentation/THIRD_PARTY_NOTICES.md',
];

const pathRank = new Map(PRODUCT_WIKI_NAV_PATH_ORDER.map((pagePath, index) => [pagePath, index]));
const sectionRank = new Map(
  PRODUCT_WIKI_NAV_SECTION_ORDER.map((section, index) => [section, index]),
);

/** Stable reader order for catalog entries, nav rail, and minnow_docs_list. */
export function compareProductWikiEntries(a, b) {
  const pathRankA = pathRank.get(a.path);
  const pathRankB = pathRank.get(b.path);
  if (pathRankA !== undefined && pathRankB !== undefined) return pathRankA - pathRankB;
  if (pathRankA !== undefined) return -1;
  if (pathRankB !== undefined) return 1;

  const sectionRankA = sectionRank.get(a.section) ?? 999;
  const sectionRankB = sectionRank.get(b.section) ?? 999;
  if (sectionRankA !== sectionRankB) return sectionRankA - sectionRankB;
  return a.path.localeCompare(b.path);
}
