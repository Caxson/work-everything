import { describe, expect, it } from 'vitest';
import { AxNodeSchema, WindowDiagnosisSchema, createLineDecoder, decodeMessage, encodeRequest } from '../src/perception/macos/axProtocol.js';

describe('ax protocol codec', () => {
  it('encodes a request as one newline-terminated object', () => {
    const line = encodeRequest(3, 'tree', { pid: 42, maxDepth: 5 });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({ id: 3, op: 'tree', pid: 42, maxDepth: 5 });
  });

  it('decodes a success response', () => {
    const decoded = decodeMessage('{"id":1,"ok":true,"result":{"trusted":true}}');
    expect(decoded.ok).toBe(true);
    if (decoded.ok && decoded.message.type === 'response') {
      expect(decoded.message.response).toMatchObject({ id: 1, ok: true });
    }
  });

  it('decodes an error response with its code', () => {
    const decoded = decodeMessage('{"id":2,"ok":false,"error":{"code":"ax_error","message":"gone"}}');
    if (decoded.ok && decoded.message.type === 'response' && !decoded.message.response.ok) {
      expect(decoded.message.response.error.code).toBe('ax_error');
    } else throw new Error('expected an error response');
  });

  it('decodes a subscription event', () => {
    const decoded = decodeMessage('{"event":"ax","subscription":7,"notification":"AXValueChanged","nodeId":11,"pid":42}');
    if (decoded.ok && decoded.message.type === 'notification') {
      expect(decoded.message.notification.notification).toBe('AXValueChanged');
    } else throw new Error('expected a notification');
  });

  it('rejects malformed lines with a readable reason', () => {
    expect(decodeMessage('')).toMatchObject({ ok: false });
    expect(decodeMessage('not json')).toMatchObject({ ok: false, error: expect.stringContaining('not JSON') });
    expect(decodeMessage('{"id":1,"ok":"maybe"}')).toMatchObject({ ok: false, error: expect.stringContaining('malformed response') });
    expect(decodeMessage('{"event":"ax","subscription":"seven"}')).toMatchObject({ ok: false, error: expect.stringContaining('malformed event') });
  });

  it('reassembles messages across arbitrary chunk boundaries', () => {
    const decode = createLineDecoder();
    expect(decode('{"id":1,')).toEqual([]);
    expect(decode('"ok":true}\n{"id":2,')).toEqual(['{"id":1,"ok":true}']);
    expect(decode('"ok":true}\n')).toEqual(['{"id":2,"ok":true}']);
  });

  it('ignores blank lines between messages', () => {
    expect(createLineDecoder()('\n\n{"a":1}\n')).toEqual(['{"a":1}']);
  });
});

describe('AxNodeSchema scalar coercion', () => {
  it('renders non-string AX attribute values as text instead of rejecting the node', () => {
    const node = AxNodeSchema.parse({
      nodeId: 15,
      role: 'AXCheckBox',
      title: 'notify',
      value: true,
      children: [{ nodeId: 16, role: 'AXSlider', value: 0.5 }],
    });
    expect(node.value).toBe('true');
    expect(node.children?.[0]?.value).toBe('0.5');
  });

  it('keeps a real string value untouched', () => {
    expect(AxNodeSchema.parse({ nodeId: 1, role: 'AXStaticText', value: 'hi' }).value).toBe('hi');
  });
});

describe('the window diagnosis, as the helper sends it', () => {
  /**
   * A real `FULLSCREEN_SPACE` answer, verbatim: Chrome full-screen on one
   * display, 飞书 on the Space behind it. Activating 飞书 gave it 1 addressable
   * window at 1397x937 and returning to Chrome took it away again, which is
   * what makes this a fact about the machine rather than about that process.
   */
  const FULLSCREEN = {
    code: 'FULLSCREEN_SPACE',
    message:
      'pid 68285 exposes no accessibility window because the active Space belongs to a full-screen application (Google Chrome). ' +
      'macOS does not composite windows that live on another Space, and accessibility follows the compositor: every application ' +
      'on the other Space reads as having no window. Nothing is wrong and retrying will not help — the action has to wait until ' +
      'the person leaves full screen, or be run against an application on this Space. Evidence: AXFullScreen, currentSpaceType=4',
    details: {
      cgWindows: 6,
      onScreen: 0,
      desktopOnScreen: 3,
      desktopOwnersOnScreen: 1,
      screenSaverOnScreen: false,
      scope: 'application',
      space: { fullScreen: true, evidence: ['AXFullScreen', 'currentSpaceType=4'], spaces: 3, currentSpaceType: 4, frontmostApp: 'Google Chrome' },
      axWindows: { entries: 0, real: 0, nonElement: 0, selfEqual: 0 },
    },
  };

  it('parses a full-screen Space census without losing any of it', () => {
    const diagnosis = WindowDiagnosisSchema.parse(FULLSCREEN);
    expect(diagnosis.code).toBe('FULLSCREEN_SPACE');
    expect(diagnosis.details?.space).toEqual(FULLSCREEN.details.space);
    expect(diagnosis.details?.scope).toBe('application');
    // Kept by `passthrough`: this side does not read it, and dropping a key
    // the helper measured would make the census unreadable in a log.
    expect(diagnosis.details?.['axWindows']).toEqual(FULLSCREEN.details.axWindows);
  });

  it('accepts a Space census with only the two fields that are always there', () => {
    // `spaces`, `currentSpaceType` and `frontmostApp` come from a private list
    // a macOS may stop vending. Absence must parse, and must not read as false.
    const diagnosis = WindowDiagnosisSchema.parse({
      code: 'FULLSCREEN_SPACE',
      message: 'no accessibility window: the active Space belongs to a full-screen application',
      details: { cgWindows: 6, onScreen: 0, space: { fullScreen: true, evidence: ['AXFullScreen'] } },
    });
    expect(diagnosis.details?.space).toEqual({ fullScreen: true, evidence: ['AXFullScreen'] });
    expect(diagnosis.details?.space?.frontmostApp).toBeUndefined();
  });

  it('still parses a helper that reports no Space at all', () => {
    const diagnosis = WindowDiagnosisSchema.parse({ code: 'NO_WINDOW', details: { cgWindows: 0, onScreen: 0 } });
    expect(diagnosis.details?.space).toBeUndefined();
  });
});
