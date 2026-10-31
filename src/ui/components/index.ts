/**
 * Minnow component library. Surfaces import controls from here instead of
 * building their own. Reference: documentation/design-system/components.md.
 */

export {
  createButton,
  createIconButton,
  setButtonBusy,
  setButtonLabel,
  setButtonPressed,
  type ButtonOptions,
  type ButtonSize,
  type ButtonVariant,
  type IconButtonOptions,
} from './button';
export {
  attachTooltip,
  getTooltipText,
  hideTooltip,
  setTooltip,
  TOOLTIP_DELAY_MS,
  type TooltipOptions,
} from './tooltip';
export { createSwitch, type SwitchOptions, type SwitchSize } from './switch';
export {
  createCheckbox,
  createField,
  createSelect,
  createTextarea,
  createTextInput,
  type CheckboxOptions,
  type FieldHandle,
  type FieldOptions,
  type FieldSize,
  type SelectOption,
  type SelectOptions,
  type TextareaOptions,
  type TextInputOptions,
} from './field';
export {
  createSegmentedControl,
  type SegmentedControlHandle,
  type SegmentedControlOptions,
  type SegmentedOption,
} from './segmented';
export { createTabs, type TabSpec, type TabsHandle, type TabsOptions } from './tabs';
export {
  createBadge,
  createChip,
  setChipSelected,
  type BadgeOptions,
  type BadgeTone,
  type ChipOptions,
} from './badge';
export {
  closeAllPopovers,
  isPopoverOpen,
  openPopover,
  togglePopover,
  type PopoverCloseReason,
  type PopoverHandle,
  type PopoverOptions,
} from './popover';
export {
  closeAllDialogs,
  isDialogOpen,
  openDialog,
  type DialogAction,
  type DialogHandle,
  type DialogOptions,
} from './dialog';
export {
  computeFloatingPosition,
  placeFloating,
  type FloatingOptions,
  type FloatingPlacement,
  type FloatingPosition,
  type RectLike,
} from './position';

// Existing shared primitives, re-exported so surfaces have one import path.
export {
  closeContextMenu,
  openContextMenu,
  type ContextMenuHandle,
  type MenuItem,
  type OpenContextMenuOptions,
} from '../context-menu';
export { notify, showToast, type NotifyAction, type NotifyHandle, type NotifyOptions } from '../toast';
export { createIcon, type IconName } from '../icon';
