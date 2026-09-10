export const PREVIEW_SHOW = 'minnow:preview:show';
export const PREVIEW_HIDE = 'minnow:preview:hide';
export const PREVIEW_CLEAR = 'minnow:preview:clear';
export const PREVIEW_LOAD_URL = 'minnow:preview:load-url';
export const PREVIEW_LOAD_SOURCE = 'minnow:preview:load-source';
export const PREVIEW_RELOAD = 'minnow:preview:reload';
export const PREVIEW_STOP = 'minnow:preview:stop';
export const PREVIEW_GO_BACK = 'minnow:preview:go-back';
export const PREVIEW_GO_FORWARD = 'minnow:preview:go-forward';
export const PREVIEW_SET_BOUNDS = 'minnow:preview:set-bounds';
export const PREVIEW_EXEC_JS = 'minnow:preview:exec-js';
export const PREVIEW_CAPTURE_PAGE = 'minnow:preview:capture-page';
export const PREVIEW_GET_INFO = 'minnow:preview:get-info';
export const PREVIEW_NAVIGATE_AWAIT = 'minnow:preview:navigate-await';
export const PREVIEW_NAVIGATION = 'minnow:preview:navigation';
export const PREVIEW_LOADING = 'minnow:preview:loading';
export const PREVIEW_PAGE_TITLE = 'minnow:preview:page-title';
export const PREVIEW_LOAD_FAILED = 'minnow:preview:load-failed';
export const PREVIEW_GUEST_CRASHED = 'minnow:preview:guest-crashed';
export const PREVIEW_TAB_CREATE = 'minnow:preview:tab-create';
export const PREVIEW_TAB_CLOSE = 'minnow:preview:tab-close';
export const PREVIEW_TAB_ACTIVATE = 'minnow:preview:tab-activate';
export const PREVIEW_TAB_LIST = 'minnow:preview:tab-list';
export const PREVIEW_INSTANCE_CREATE = 'minnow:preview:instance-create';
export const PREVIEW_INSTANCE_DESTROY = 'minnow:preview:instance-destroy';
export const PREVIEW_INSTANCE_LIST = 'minnow:preview:instance-list';
export const PREVIEW_CDP_PICK_ENABLE = 'minnow:preview:cdp-pick-enable';
export const PREVIEW_CDP_PICK_DISABLE = 'minnow:preview:cdp-pick-disable';
export const PREVIEW_CDP_PICK_EVENT = 'minnow:preview:cdp-pick-event';
export const PREVIEW_CDP_PICK_ERROR = 'minnow:preview:cdp-pick-error';
export const PREVIEW_DEVTOOLS_TOGGLE = 'minnow:preview:devtools-toggle';
export const PREVIEW_DEVTOOLS_GET_STATE = 'minnow:preview:devtools-get-state';
export const PREVIEW_DEVTOOLS_SET_DOCK = 'minnow:preview:devtools-set-dock';
export const PREVIEW_DEVTOOLS_GET_DOCK = 'minnow:preview:devtools-get-dock';
export const PREVIEW_DEVTOOLS_STATE = 'minnow:preview:devtools-state';
export const PREVIEW_CONTEXT_MENU_OPEN = 'minnow:preview:context-menu-open';
export const PREVIEW_CONTEXT_MENU_SELECT = 'minnow:preview:context-menu-select';
export const PREVIEW_CONTEXT_INSPECT = 'minnow:preview:context-inspect';
export const PREVIEW_CONTEXT_RESOLVE_ELEMENT = 'minnow:preview:context-resolve-element';
export const PREVIEW_CONTEXT_ACTION = 'minnow:preview:context-action';

export const APP_OPEN_EXTERNAL = 'minnow:app:open-external';
export const APP_GET_HARDWARE_ACCELERATION = 'minnow:app:get-hardware-acceleration';
export const APP_SET_HARDWARE_ACCELERATION = 'minnow:app:set-hardware-acceleration';
export const APP_RESTART = 'minnow:app:restart';
export const SHELL_REVEAL_IN_EXPLORER = 'minnow:shell:reveal-in-explorer';
export const DIAGNOSTICS_REPORT_ERROR = 'minnow:diagnostics:report-error';
export const DIAGNOSTICS_LAST_CRASH = 'minnow:diagnostics:last-crash';
export const DIAGNOSTICS_OOM_PAUSE = 'minnow:diagnostics:oom-pause';
export const DIAGNOSTICS_CLEAR_OOM_PAUSE = 'minnow:diagnostics:clear-oom-pause';

export const POWER_SET_AFK_GUARD = 'minnow:power:set-afk-guard';
export const POWER_SCREEN_UNLOCKED = 'minnow:power:screen-unlocked';
export const BOARD_PAUSE_FOR_SHUTDOWN = 'minnow:board:pause-for-shutdown';

export const UPDATER_GET_STATUS = 'minnow:updater:get-status';
export const UPDATER_CHECK_NOW = 'minnow:updater:check-now';
export const UPDATER_RESTART = 'minnow:updater:restart';
export const UPDATER_SET_CHANNEL = 'minnow:updater:set-channel';
export const UPDATER_STATUS_CHANGED = 'minnow:updater:status-changed';

export const WINDOW_MINIMIZE = 'minnow:window:minimize';
export const WINDOW_MAXIMIZE = 'minnow:window:maximize';
export const WINDOW_CLOSE = 'minnow:window:close';
export const WINDOW_IS_MAXIMIZED = 'minnow:window:is-maximized';
export const WINDOW_RESTORE_FOCUS = 'minnow:window:restore-focus';
export const WINDOW_MAXIMIZED_CHANGED = 'minnow:window:maximized-changed';
export const WINDOW_VISIBILITY_CHANGED = 'minnow:window:visibility-changed';
/** Open a fresh window at the folder gate. */
export const WINDOW_NEW = 'minnow:window:new';
/** Open a folder in a window — or focus the one already on it. */
export const WINDOW_OPEN_WORKSPACE = 'minnow:window:open-workspace';
export const WINDOW_CODE_COMMAND = 'minnow:window:code-command';
export const WINDOW_CODE_READY = 'minnow:window:code-ready';
export const WINDOW_CODE_LINK = 'minnow:window:code-link';
/** Folders currently open in some window, so recents can mark and focus them. */
export const WINDOW_LIST_WORKSPACES = 'minnow:window:list-workspaces';
/** The same list with window ids and background state, for close/focus actions. */
export const WINDOW_LIST_WORKSPACE_WINDOWS = 'minnow:window:list-workspace-windows';
/** Really close the window on a folder — never hide it to the tray. */
export const WINDOW_CLOSE_WORKSPACE = 'minnow:window:close-workspace';
/** Broadcast whenever a workspace window opens, closes, or is backgrounded. */
export const WINDOW_WORKSPACES_CHANGED = 'minnow:window:workspaces-changed';
/** Point this window at a different folder, then reload it. */
export const WINDOW_SWITCH_WORKSPACE = 'minnow:window:switch-workspace';
/** Open (or focus) a dedicated window for one released app. */
export const WINDOW_OPEN_APP = 'minnow:window:open-app';
/** Whether that app already has a dedicated window (for menu labels). */
export const WINDOW_HAS_APP = 'minnow:window:has-app';
/** Open or focus the standalone Agent Browser viewer window. */
export const WINDOW_OPEN_AGENT_BROWSER_VIEWER = 'minnow:window:open-agent-browser-viewer';

export const TRAY_PUBLISH_STATUS = 'minnow:tray:publish-status';
export const TRAY_NOTIFY_READY = 'minnow:tray:notify-ready';
export const TRAY_GET_CLOSE_TO_TRAY = 'minnow:tray:get-close-to-tray';
/** What closing one of several windows should do: ask, close, or background. */
export const TRAY_GET_WINDOW_CLOSE_ACTION = 'minnow:tray:get-window-close-action';
export const TRAY_SET_WINDOW_CLOSE_ACTION = 'minnow:tray:set-window-close-action';
export const TRAY_SET_CLOSE_TO_TRAY = 'minnow:tray:set-close-to-tray';
export const TRAY_GET_LOGIN_ITEM = 'minnow:tray:get-login-item';
export const TRAY_SET_LOGIN_ITEM = 'minnow:tray:set-login-item';
export const TRAY_COMMAND = 'minnow:tray:command';
export const TRAY_CLOSE_TO_TRAY_CHANGED = 'minnow:tray:close-to-tray-changed';
/** Main asks the renderer to show the in-app close-workspace dialog. */
export const WINDOW_CLOSE_PROMPT = 'minnow:window:close-prompt';
/** Renderer answers that dialog. */
export const WINDOW_CLOSE_PROMPT_RESULT = 'minnow:window:close-prompt-result';
export const SHELL_GET_ZOOM_PERCENT = 'minnow:shell:get-zoom-percent';
export const SHELL_SET_ZOOM_PERCENT = 'minnow:shell:set-zoom-percent';
export const SHELL_ZOOM_PERCENT_CHANGED = 'minnow:shell:zoom-percent-changed';
