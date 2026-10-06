import { setFlagsFromString } from 'node:v8';
import { enableNativeCallTrace } from './native-call-trace.js';

// Electron 43.2.0's main-process crash dump showed FastJsonStringifier growing
// its two-byte OutBuffer until Zone::Expand failed, with only 134 MiB of heap
// in use. Use the standard serializer so this native allocation path cannot
// take down the shell and its in-process server. Keep JSON semantics intact.
setFlagsFromString('--no-json-stringify-fast-path');

enableNativeCallTrace();
