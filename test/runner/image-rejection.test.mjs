import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bodyHasImageParts,
  isImageRejectionError,
  stripImagePartsFromBody,
} from '../../server/runner/image-rejection.js';

describe('image rejection recovery', () => {
  it('recognizes the llama.cpp missing-mmproj error without treating unrelated failures as image rejection', () => {
    assert.equal(isImageRejectionError(new Error('Upstream HTTP 500: image input is not supported - hint: if this is unexpected, you may need to provide the mmproj')), true);
    assert.equal(isImageRejectionError(new Error('Upstream HTTP 500: server unavailable')), false);
    assert.equal(isImageRejectionError(new Error('HTTP 429: image rate limit')), false);
  });

  it('keeps text, drops image bytes and tool screenshot follow-ups, and leaves the original body intact', () => {
    const body = {
      model: 'text-only',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Describe this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] },
        { role: 'user', toolImageFollowUp: true, content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,xyz' } }] },
      ],
    };
    const stripped = stripImagePartsFromBody(body);
    assert.equal(bodyHasImageParts(body), true);
    assert.equal(bodyHasImageParts(stripped), false);
    assert.equal(stripped.messages.length, 1);
    assert.match(stripped.messages[0].content, /Describe this/);
    assert.match(stripped.messages[0].content, /image omitted/);
    assert.equal(stripped.model, body.model);
  });
});
