import { getMtplxStatus, MTPLX_INSTALL_GUIDANCE } from '../models/mtplx-runtime.js';
export const SERVER_ID = 'mtplx';
export const getInstallStatus = getMtplxStatus;
export const getExtendedStatus = getMtplxStatus;
export async function provision() { throw new Error(MTPLX_INSTALL_GUIDANCE); }
export async function uninstall() { throw new Error('MTPLX is managed outside Minnow. Uninstall it using its original installer.'); }
export async function getSpawnSpec() { throw new Error('Load an MTPLX model from My Models.'); }
