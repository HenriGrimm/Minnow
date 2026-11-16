# MIN-7 — Customizable keyboard shortcuts

## Delivered

- Dedicated searchable Keyboard shortcuts Settings page using shared button primitives and theme tokens.
- Device-local versioned persistence with validation, cross-window refresh, failed-save feedback and publish-after-write semantics.
- Original keyboard shortcuts can be translated from keyboard chords, mouse buttons, wheel directions, gamepad buttons or signed axes. Record another shortcut covers keyboard targets outside the convenience catalog.
- Explicit takeover confirmation, displaced-binding disable, per-binding reset/disable, reset-all confirmation and typing controls.
- Recording cancels on Escape, timeout, page disposal or blur; Use Escape assigns Escape explicitly. Recovery controls are exempt; confirmation dialogs pause remapping.
- Existing focused-view handlers and CodeMirror precedence remain authoritative. Gamepads use edge detection/hysteresis and poll only when a pad is connected.

## Verification

- `npx tsc --noEmit`: passed.
- 120 targeted tests: passed (input bindings, Settings recorder, navigation/HTML/search, sidebar icons and keyboard help).
- Additional Settings sections/filter/search-finder and boot-budget tests: passed.
- Product wiki suite: 13 tests passed.
- `npm run test:check-coverage`: passed.
- `npm run build`: passed; existing ineffective-dynamic-import warnings remain.
- `npm run check:performance-budgets`: passed after documented 20 KB eager/35 KB assets allowance in budgets.json and refreshed baseline. Measured approximately 4808 KB eager and 12459 KB total assets.
- Impeccable detection on the new Settings source/CSS: no findings.
- Private Chromium acceptance fixture inspected at 1440×1000 and 390×844: readable layout, wrapping actions, no apparent clipping. Live CodeMirror integration: F8 translated into Ctrl+K exactly once with editor focus retained.
- Full repository test suite, physical gamepad hardware, native Electron guest behavior and assistive-technology acceptance were not verified.

## Remaining acceptance concerns

This is input translation, not a complete action registry. A shared original key changes all of its contexts together. The convenience catalog is curated; unlisted keyboard targets are recorded manually. Native text insertion/newlines, browser-native focus/clipboard behavior, PTY input, embedded web pages and OS-reserved shortcuts are not synthesized. Non-browser device protocols (for example MIDI) are unsupported. Thus the literal “every supported shortcut … any input … etc” acceptance criterion is not fully satisfied. Finishing that broader scope needs explicit per-action/context adapters and native-host/device integration rather than pretending synthetic keyboard events invoke native defaults.

The PR is a draft for review of this implementation and these scope concerns. MIN-7 remains In progress; it is not marked Done.
