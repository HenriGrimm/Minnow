#!/usr/bin/env node
/**
 * @param {{ appOutDir: string; packager: { appInfo: { productFilename: string } } }} context
 */
import path from 'node:path';
import {
  hasDeveloperIdIdentity,
  hasNotarizationCredentials,
  loadSigningEnvFile,
} from './macos-signing-env.mjs';
import { notarizeMacApp } from './macos-notarize-app.mjs';

export default async function afterSign(context) {
  if (process.platform !== 'darwin') {
    return;
  }
  if (process.env.MINNOW_SKIP_SIGNING === '1' || process.env.MINNOW_SKIP_NOTARIZATION === '1') {
    return;
  }

  loadSigningEnvFile();

  const hasCiCertificate = Boolean(process.env.CSC_LINK?.trim());
  if ((!hasDeveloperIdIdentity() && !hasCiCertificate) || !hasNotarizationCredentials()) {
    return;
  }

  const productName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${productName}.app`);

  await notarizeMacApp(appPath);
}
