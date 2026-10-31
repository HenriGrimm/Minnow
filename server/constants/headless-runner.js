/**
 * Where the bundled `minnow run` entry lives, relative to the app root.
 *
 * Written by `scripts/build-headless-runner.mjs` at package time and spawned by
 * the Scheduler in an installed build. The same path is listed in
 * `package.json` `build.files` and `.gitignore`.
 */
export const HEADLESS_RUNNER_BUNDLE = 'dist-headless/minnow-run.mjs';

/** Export-only shared prompt/policy composer, imported by the server chat host. */
export const CHAT_PREPARATION_BUNDLE = 'dist-headless/chat-preparation.mjs';
