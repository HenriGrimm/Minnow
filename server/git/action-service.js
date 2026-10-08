import * as workflows from './workflow-ops.js';
import * as commands from './action-config.js';
import * as local from './local-action-ops.js';
import * as releases from './release-ops.js';

export const ACTION_OPS = {
  workflowList: workflows.workflowList,
  workflowView: workflows.workflowView,
  workflowDispatch: workflows.workflowDispatch,
  actionRemoteOptions: workflows.actionRemoteOptions,
  commandList: commands.commandList,
  commandSave: commands.commandSave,
  actionSecrets: commands.actionSecrets,
  localCapabilities: local.localCapabilities,
  localRunStart: local.localRunStart,
  localRunList: local.localRunList,
  localRunView: local.localRunView,
  localRunCancel: local.localRunCancel,
  localRunRerun: local.localRunRerun,
  releaseList: releases.releaseList,
  releaseView: releases.releaseView,
  releaseCreate: releases.releaseCreate,
  releaseEdit: releases.releaseEdit,
  releaseDelete: releases.releaseDelete,
  releaseNotes: releases.releaseNotes,
  releaseAssetUpload: releases.releaseAssetUpload,
  releaseAssetDownload: releases.releaseAssetDownload,
  releaseAssetDelete: releases.releaseAssetDelete,
};
