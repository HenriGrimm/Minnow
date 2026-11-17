# Keyboard shortcuts

Open **Settings → Keyboard shortcuts** to search shortcuts by action, group or input. Select a binding button and press a replacement key or chord, click a mouse button, scroll the wheel, or activate a gamepad button or stick direction. Gamepads must be connected and activated while Minnow has focus. Inputs are numbered from zero for gamepads.

Changes save automatically on this device and persist across sessions. Other windows on the same browser origin receive the changes. A failed save stays visible on the page and leaves the previous bindings active. **Disable** removes a shortcut; **Reset** restores its default. **Reset all shortcuts** restores all defaults after confirmation.

Keyboard inputs that replace an existing key warn before taking over its normal action. Reusing another custom input asks for confirmation and disables the displaced binding. Cancel leaves both bindings unchanged. To assign Escape rather than cancel recording, select **Use Escape** while recording.

Bindings translate the original shortcut in its existing context. A shared shortcut changes everywhere it is used: for example, remapping Ctrl+K affects both selection Quick Edit and the command palette. Ctrl and Cmd are separate entries. **Record another shortcut** adds a keyboard target not listed in the catalog, including focused-view or editor shortcuts.

Unmodified replacement inputs do not interrupt typing unless **Allow unmodified input while typing** is enabled. This starts enabled for original modified shortcuts and special keys, and disabled for original printable characters. Modified keyboard inputs remain available while typing. The Settings shortcut controls stay exempt so you can always recover from a conflicting mapping. Escape cancels recording; recording also stops after 15 seconds, when you leave the page, or when the window loses focus.

## Input boundaries

These are in-app bindings, not system-wide input emulation. They do not remap operating-system shortcuts, native browser text-editing actions, terminal keystrokes, or keys inside embedded web pages. Browser and OS-reserved inputs may never reach Minnow. Standard focus navigation and native text insertion are not synthesized by a replacement input. Gamepad buttons and axes trigger once per press or direction, not repeatedly while held. MIDI, touch gestures and other device protocols are not supported.
