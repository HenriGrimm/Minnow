import { ACTION_OPS } from './action-service.js';
import { runList, runView, runLog, runRerun, runCancel } from './forge-ops.js';
import { actionRoot } from './action-common.js';

const parse = (value) => (value ? JSON.parse(value) : {});
export const ACTION_TOOL_HANDLERS = {
  action_inspect: async (args) => {
    await actionRoot(args.cwd);
    const local = args.location === 'local';
    const map = {
      workflows: ACTION_OPS.workflowList,
      workflow: ACTION_OPS.workflowView,
      commands: ACTION_OPS.commandList,
      capabilities: ACTION_OPS.localCapabilities,
      refs: ACTION_OPS.actionRemoteOptions,
      runs: local ? ACTION_OPS.localRunList : runList,
      run: local ? ACTION_OPS.localRunView : runView,
      log: local ? ACTION_OPS.localRunView : runLog,
    };
    if (!map[args.operation]) throw new Error('Unknown inspection operation');
    return map[args.operation](args);
  },
  action_run: async (args) => {
    await actionRoot(args.cwd);
    if (!['local', 'remote'].includes(args.location)) throw new Error('Choose local or remote');
    const local = args.location === 'local';
    const handler = args.rerun
      ? local
        ? ACTION_OPS.localRunRerun
        : runRerun
      : local
        ? ACTION_OPS.localRunStart
        : ACTION_OPS.workflowDispatch;
    return handler({ ...args, source: 'agent', inputs: parse(args.inputsJson) });
  },
  action_cancel: async (args) => {
    await actionRoot(args.cwd);
    if (!['local', 'remote'].includes(args.location)) throw new Error('Choose local or remote');
    return (args.location === 'local' ? ACTION_OPS.localRunCancel : runCancel)(args);
  },
  action_command: (args) =>
    ACTION_OPS.commandSave({
      cwd: args.cwd,
      id: args.id,
      remove: args.remove,
      command: {
        id: args.id,
        label: args.label,
        command: args.command,
        cwd: args.directory,
        shellProfile: args.shellProfile,
        env: parse(args.envJson),
        secrets: parse(args.secretsJson),
      },
    }),
  release_inspect: (args) => (args.id ? ACTION_OPS.releaseView : ACTION_OPS.releaseList)(args),
  release_manage: (args) => {
    const map = {
      create: ACTION_OPS.releaseCreate,
      edit: ACTION_OPS.releaseEdit,
      publish: ACTION_OPS.releaseEdit,
      notes: ACTION_OPS.releaseNotes,
      delete: ACTION_OPS.releaseDelete,
    };
    if (!map[args.operation]) throw new Error('Unknown release operation');
    return map[args.operation]({ ...args, publish: args.operation === 'publish' });
  },
  release_asset: (args) => {
    const map = {
      upload: ACTION_OPS.releaseAssetUpload,
      download: ACTION_OPS.releaseAssetDownload,
      delete: ACTION_OPS.releaseAssetDelete,
    };
    if (!map[args.operation]) throw new Error('Unknown asset operation');
    return map[args.operation](args);
  },
};
