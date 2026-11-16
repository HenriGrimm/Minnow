const MAX_PENDING_CHARS = 256 * 1024;
const TRUNCATED_NOTICE = '\x18\x1b[0m\r\n[Earlier terminal output omitted while hidden]\r\n';

/** Keep the PTY connected while its viewport has no layout box. */
export function createPtyOutputBuffer(write: (data: string) => void, limit = MAX_PENDING_CHARS) {
  let visible = false;
  let pending = '';
  let truncated = false;

  return {
    append(data: string) {
      if (visible) {
        write(data);
        return;
      }
      pending += data;
      if (pending.length > limit) {
        // Drop a block at once so a chatty hidden process cannot keep copying the full buffer.
        pending = pending.slice(-Math.ceil(limit / 2)).replace(/^[\udc00-\udfff]/, '');
        truncated = true;
      }
    },
    setVisible(next: boolean) {
      visible = next;
      if (!visible || !pending) return;
      const data = truncated ? TRUNCATED_NOTICE + pending : pending;
      pending = '';
      truncated = false;
      write(data);
    },
    reset() {
      pending = '';
      truncated = false;
    },
  };
}
