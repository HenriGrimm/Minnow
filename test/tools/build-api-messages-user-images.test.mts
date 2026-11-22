/**
 * Images the user attached by hand — dropped, pasted, or picked in Design Mode —
 * must reach the model as pixels, and must still be there on the next turn.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

import { buildApiMessages, persistableUserImages } from '../../src/chat/build-api-messages.ts';
import { USER_IMAGE_NO_VISION_HINT } from '../../src/chat/tool-image-follow-up.ts';
import { clearAttachments, pushAttachment } from '../../src/attachments/store.ts';
import type { Attachment } from '../../src/attachments/types.ts';
import type { ApiMessage, Chat, ContentPart } from '../../src/types.ts';

const SHOT = 'data:image/png;base64,c2hvdA==';
const CROP = 'data:image/png;base64,Y3JvcA==';

const imageAttachment: Attachment = {
  id: 'att-1',
  name: 'shot.png',
  kind: 'image',
  mimeType: 'image/png',
  size: 1024,
  dataUrl: SHOT,
};

function chatWithPendingImage(): Chat {
  return {
    id: 'chat-img-1',
    name: 'Images',
    workspacePath: '/tmp/ws',
    modelId: 'test-model',
    modeId: 'build',
    history: [{ role: 'user', content: 'What is wrong here?\n\n[image: shot.png]' }],
    lastStats: null,
    modelInfo: {},
    updatedAt: 1,
  };
}

/** Content parts of the last user message, or null when it is a plain string. */
function lastUserParts(messages: ApiMessage[]): ContentPart[] | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === 'user') return Array.isArray(m.content) ? m.content : null;
  }
  return null;
}

describe('buildApiMessages user attachments', () => {
  let previousWindow: unknown;

  beforeEach(() => {
    previousWindow = globalThis.window;
    const win = new Window();
    globalThis.window = win as unknown as Window & typeof globalThis.window;
    globalThis.document = win.document as unknown as Document;
    clearAttachments();
  });

  afterEach(() => {
    clearAttachments();
    globalThis.window = previousWindow as typeof globalThis.window;
  });

  test('a pending image is sent as an image_url part', () => {
    pushAttachment(imageAttachment);
    const messages = buildApiMessages(chatWithPendingImage(), 'sys', {
      composedSystemPrompt: 'sys',
      pendingUserText: 'What is wrong here?',
      vision: true,
    });
    const parts = lastUserParts(messages);
    assert.ok(parts, 'expected multimodal user content');
    const image = parts.find((p) => p.type === 'image_url');
    assert.equal(image && 'image_url' in image ? image.image_url.url : '', SHOT);
    // The filename placeholder must not ride along with the real pixels.
    const text = parts.find((p) => p.type === 'text');
    assert.doesNotMatch(text && 'text' in text ? text.text : '', /\[image:/);
  });

  test('a turn carries its own attachments once the composer has been emptied', () => {
    // MIN-650: the strip clears at send, so an in-flight turn cannot rely on the
    // pending store still holding its files.
    clearAttachments();
    const messages = buildApiMessages(chatWithPendingImage(), 'sys', {
      composedSystemPrompt: 'sys',
      pendingUserText: 'What is wrong here?',
      vision: true,
      attachments: [imageAttachment],
    });
    const parts = lastUserParts(messages);
    assert.ok(parts, 'expected multimodal user content');
    const image = parts.find((p) => p.type === 'image_url');
    assert.equal(image && 'image_url' in image ? image.image_url.url : '', SHOT);
  });

  test('explicit turn attachments win over whatever the composer holds now', () => {
    // A file queued for the *next* message must not leak into the running turn.
    pushAttachment({ ...imageAttachment, id: 'att-next', name: 'next.png' });
    const messages = buildApiMessages(chatWithPendingImage(), 'sys', {
      composedSystemPrompt: 'sys',
      pendingUserText: 'What is wrong here?',
      vision: true,
      attachments: [],
    });
    const parts = lastUserParts(messages);
    const images = (parts ?? []).filter((p) => p.type === 'image_url');
    assert.equal(images.length, 0);
  });

  test('a Design Mode element crop is sent as pixels too', () => {
    pushAttachment({
      id: 'att-el',
      name: 'button.png',
      kind: 'elementRef',
      mimeType: 'image/png',
      size: 512,
      selector: '.cta',
      pageUrl: 'http://localhost:5173/',
      tagName: 'button',
      classList: ['cta'],
      stylesDigest: 'font: 14px',
      outerHtmlPreview: '<button class="cta">Go</button>',
      croppedDataUrl: CROP,
    });
    const messages = buildApiMessages(chatWithPendingImage(), 'sys', {
      composedSystemPrompt: 'sys',
      pendingUserText: 'Make this bigger',
      vision: true,
    });
    const parts = lastUserParts(messages);
    assert.ok(parts);
    const image = parts.find((p) => p.type === 'image_url');
    assert.equal(image && 'image_url' in image ? image.image_url.url : '', CROP);
  });

  test('a model proven text-only is told the pixels were withheld', () => {
    pushAttachment(imageAttachment);
    const messages = buildApiMessages(chatWithPendingImage(), 'sys', {
      composedSystemPrompt: 'sys',
      pendingUserText: 'What is wrong here?',
      vision: false,
    });
    assert.equal(lastUserParts(messages), null, 'expected string content');
    const last = messages[messages.length - 1];
    const content = String(last.content);
    assert.match(content, /\[image: shot\.png\]/);
    // Without this the model answers "I have no tool for reading images".
    assert.ok(content.includes(USER_IMAGE_NO_VISION_HINT.trim()));
  });

  test('an unknown model still receives the pixels rather than a filename', () => {
    pushAttachment(imageAttachment);
    const chat = chatWithPendingImage();
    // A bare llama.cpp `/v1/models` row: nothing in the catalog says vision
    // either way, and the id carries no VLM marker.
    chat.modelId = 'gemma-3-12b-it';
    const messages = buildApiMessages(chat, 'sys', {
      composedSystemPrompt: 'sys',
      modelId: 'gemma-3-12b-it',
      pendingUserText: 'What is wrong here?',
    });
    const parts = lastUserParts(messages);
    assert.ok(parts, 'unknown-vision models must still get the image');
    assert.ok(parts.some((p) => p.type === 'image_url'));
  });

  test('images stored on an earlier turn are replayed on later turns', () => {
    const chat = chatWithPendingImage();
    chat.history = [
      {
        role: 'user',
        content: 'What is wrong here?\n\n[image: shot.png]',
        images: [{ name: 'shot.png', dataUrl: SHOT }],
      },
      { role: 'assistant', content: 'The padding is uneven.' },
      { role: 'user', content: 'And the colour?' },
    ];
    const messages = buildApiMessages(chat, 'sys', {
      composedSystemPrompt: 'sys',
      vision: true,
    });
    const replayed = messages.find(
      (m) => m.role === 'user' && Array.isArray(m.content),
    );
    assert.ok(replayed, 'the earlier image must still be visible');
    const parts = Array.isArray(replayed.content) ? replayed.content : [];
    assert.equal(
      parts.find((p) => p.type === 'image_url')?.type,
      'image_url',
    );
    // The follow-up question stays a plain string — only the image row is upgraded.
    assert.equal(messages[messages.length - 1].content, 'And the colour?');
  });

  test('stored images are dropped for a model that cannot see them', () => {
    const chat = chatWithPendingImage();
    chat.history = [
      {
        role: 'user',
        content: 'What is wrong here?\n\n[image: shot.png]',
        images: [{ name: 'shot.png', dataUrl: SHOT }],
      },
      { role: 'user', content: 'And the colour?' },
    ];
    const messages = buildApiMessages(chat, 'sys', {
      composedSystemPrompt: 'sys',
      vision: false,
    });
    assert.equal(
      messages.some((m) => m.role === 'user' && Array.isArray(m.content)),
      false,
    );
  });

  test('a stored no-vision hint is dropped once the model can read the image again', () => {
    const chat = chatWithPendingImage();
    chat.history = [
      {
        role: 'user',
        content: `What is wrong here?\n\n[image: shot.png]${USER_IMAGE_NO_VISION_HINT}`,
        images: [{ name: 'shot.png', dataUrl: SHOT }],
      },
      { role: 'assistant', content: 'I cannot see the image.' },
    ];
    const messages = buildApiMessages(chat, 'sys', {
      composedSystemPrompt: 'sys',
      vision: true,
    });
    const user = messages.find((m) => m.role === 'user');
    assert.ok(user);
    assert.equal(Array.isArray(user.content), false, 'no pending image keeps the row textual');
    assert.doesNotMatch(String(user.content), /cannot accept image input/);
    assert.match(String(user.content), /\[image: shot\.png\]/);
  });
});

describe('persistableUserImages', () => {
  test('collects pixels from every attachment kind that carries them', () => {
    const out = persistableUserImages([
      imageAttachment,
      {
        id: 'att-design',
        name: 'note.png',
        kind: 'designRef',
        mimeType: 'image/png',
        size: 256,
        pageUrl: 'http://localhost:5173/',
        compositedDataUrl: CROP,
      },
      { id: 'att-txt', name: 'a.ts', kind: 'text', mimeType: 'text/plain', size: 4, text: 'x' },
    ]);
    assert.deepEqual(out, [
      { name: 'shot.png', dataUrl: SHOT },
      { name: 'note.png', dataUrl: CROP },
    ]);
  });

  test('stops before a session file would balloon past the byte cap', () => {
    const huge = `data:image/png;base64,${'A'.repeat(7 * 1024 * 1024)}`;
    const out = persistableUserImages([
      imageAttachment,
      { ...imageAttachment, id: 'att-2', name: 'huge.png', dataUrl: huge },
    ]);
    assert.deepEqual(out, [{ name: 'shot.png', dataUrl: SHOT }]);
  });
});
