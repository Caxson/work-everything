import { describe, expect, it } from 'vitest';
import { AxNodeSchema, createLineDecoder, decodeMessage, encodeRequest } from '../src/perception/macos/axProtocol.js';

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
