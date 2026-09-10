import { deleteIssues, findIssueById } from '../state/issues-store';
import {
  deleteIssueFromGithub,
  getIssuesGithubDeleteBehavior,
  setIssuesGithubDeleteBehavior,
  type IssuesGithubDeleteBehavior,
} from '../state/issues-github';
import { appAlert, appChoice, appConfirm } from './app-dialog';

export interface DeleteIssuesResult {
  deletedIds: string[];
  failedIds: string[];
}

/** Confirm and delete issues, including their linked GitHub copies when chosen. */
export async function confirmAndDeleteIssues(issueIds: string[]): Promise<DeleteIssuesResult> {
  const ids = [...new Set(issueIds.map((id) => id.trim()).filter(Boolean))]
    .filter((id) => Boolean(findIssueById(id)));
  if (ids.length === 0) return { deletedIds: [], failedIds: [] };

  const linkedIds = ids.filter((id) => Boolean(findIssueById(id)?.github?.number));
  if (linkedIds.length === 0) {
    const noun = ids.length === 1 ? 'this issue' : `${ids.length} issues`;
    const confirmed = await appConfirm(`Delete ${noun}? This cannot be undone.`, {
      confirmLabel: 'Delete',
      title: ids.length === 1 ? 'Delete issue' : 'Delete issues',
      danger: true,
    });
    if (!confirmed) return { deletedIds: [], failedIds: [] };
    deleteIssues(ids);
    return { deletedIds: ids, failedIds: [] };
  }

  let behavior: IssuesGithubDeleteBehavior = getIssuesGithubDeleteBehavior();
  if (behavior === 'ask') {
    const linkedNoun = linkedIds.length === 1
      ? `GitHub issue #${findIssueById(linkedIds[0])?.github?.number}`
      : `${linkedIds.length} linked GitHub issues`;
    const choice = await appChoice({
      title: ids.length === 1 ? 'Delete issue' : 'Delete issues',
      message: `Delete ${linkedNoun} too? This cannot be undone.`,
      checkboxLabel: 'Remember',
      cancelId: 'cancel',
      defaultFocusId: 'cancel',
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'local', label: 'Local only', danger: true },
        { id: 'github', label: 'Delete everywhere', danger: true },
      ],
    });
    if (choice.id !== 'local' && choice.id !== 'github') {
      return { deletedIds: [], failedIds: [] };
    }
    behavior = choice.id;
    if (choice.checkboxChecked) setIssuesGithubDeleteBehavior(behavior);
  }

  if (behavior === 'local') {
    deleteIssues(ids);
    return { deletedIds: ids, failedIds: [] };
  }

  const failedIds: string[] = [];
  for (const id of linkedIds) {
    const result = await deleteIssueFromGithub(id);
    if (!result.ok) {
      failedIds.push(id);
      await appAlert(result.error ?? `Could not delete ${id} from GitHub`, 'GitHub');
    }
  }

  const deletedIds = ids.filter((id) => !failedIds.includes(id));
  deleteIssues(deletedIds);
  return { deletedIds, failedIds };
}
