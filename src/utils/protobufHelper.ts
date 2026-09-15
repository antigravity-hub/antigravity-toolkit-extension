import * as fs from 'fs';
import * as path from 'path';

export interface ProtoField {
  fn: number;
  wt: number;
  data: Buffer;
}

export function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  if (value === 0) return Buffer.from([0]);
  let val = value;
  while (val > 0x7f) {
    bytes.push((val & 0x7f) | 0x80);
    val = Math.floor(val / 128);
  }
  bytes.push(val & 0x7f);
  return Buffer.from(bytes);
}

export function encodeTag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType);
}

export function encodeString(fieldNumber: number, value: string): Buffer {
  const buf = Buffer.from(value, 'utf-8');
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(buf.length), buf]);
}

export function encodeVarintField(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([encodeTag(fieldNumber, 0), encodeVarint(value)]);
}

export function encodeMessage(fieldNumber: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(payload.length), payload]);
}

export function encodeField(fn: number, wt: number, data: Buffer): Buffer {
  const tag = encodeVarint((fn << 3) | wt);
  if (wt === 0) {
    return Buffer.concat([tag, data]);
  } else if (wt === 2) {
    return Buffer.concat([tag, encodeVarint(data.length), data]);
  } else {
    return Buffer.concat([tag, data]);
  }
}

/**
 * Parses binary protobuf into field descriptors.
 */
export function parseProtoFields(buf: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let idx = 0;
  while (idx < buf.length) {
    let tag = 0;
    let shift = 0;
    while (idx < buf.length) {
      const b = buf[idx++];
      tag |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    const fn = tag >> 3;
    const wt = tag & 7;

    if (wt === 0) {
      // varint
      const start = idx;
      while (idx < buf.length && (buf[idx] & 0x80) !== 0) {
        idx++;
      }
      if (idx < buf.length) idx++;
      fields.push({ fn, wt, data: buf.subarray(start, idx) });
    } else if (wt === 2) {
      // length-delimited
      let len = 0;
      shift = 0;
      while (idx < buf.length) {
        const b = buf[idx++];
        len |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      const val = buf.subarray(idx, idx + len);
      idx += len;
      fields.push({ fn, wt, data: val });
    } else if (wt === 1) {
      // 64-bit
      fields.push({ fn, wt, data: buf.subarray(idx, idx + 8) });
      idx += 8;
    } else if (wt === 5) {
      // 32-bit
      fields.push({ fn, wt, data: buf.subarray(idx, idx + 4) });
      idx += 4;
    } else {
      break;
    }
  }
  return fields;
}

/**
 * Updates an existing UserStatus protobuf with new user name and email
 * while preserving Field 33 (cascadeModelConfigData - all 14 models!)
 * and all other essential fields.
 */
export function updateUserStatusProto(
  existingProto: Buffer,
  newName: string,
  newEmail: string
): Buffer {
  const fields = parseProtoFields(existingProto);
  const newChunks: Buffer[] = [];
  let nameUpdated = false;
  let emailUpdated = false;

  for (const field of fields) {
    if (field.fn === 3) {
      // Field 3: User Display Name
      newChunks.push(encodeString(3, newName));
      nameUpdated = true;
    } else if (field.fn === 7) {
      // Field 7: User Email Address
      newChunks.push(encodeString(7, newEmail));
      emailUpdated = true;
    } else {
      // PRESERVE ALL OTHER FIELDS (e.g. Field 33: cascadeModelConfigData, Field 2, Field 36, Field 38)
      newChunks.push(encodeField(field.fn, field.wt, field.data));
    }
  }

  if (!nameUpdated) {
    newChunks.push(encodeString(3, newName));
  }
  if (!emailUpdated) {
    newChunks.push(encodeString(7, newEmail));
  }

  return Buffer.concat(newChunks);
}

/**
 * Wraps binary UserStatus into the USS IPC message structure:
 * uss-userStatus -> field 5: { userStatusSentinelKey -> field 2: { field 1: base64(UserStatus) } }
 */
export function wrapUserStatusInUSS(userStatusBinary: Buffer): string {
  const row = encodeString(1, userStatusBinary.toString('base64'));
  const update = Buffer.concat([
    encodeString(1, 'userStatusSentinelKey'),
    encodeMessage(2, row),
  ]);
  return Buffer.concat([
    encodeString(1, 'uss-userStatus'),
    encodeMessage(5, update),
  ]).toString('base64');
}

/**
 * Wraps binary UserStatus into the full state.vscdb antigravityUnifiedStateSync.userStatus structure.
 */
export function wrapUserStatusForVscdb(userStatusBinary: Buffer): string {
  const row = encodeString(1, userStatusBinary.toString('base64'));
  const update = Buffer.concat([
    encodeString(1, 'userStatusSentinelKey'),
    encodeMessage(2, row),
  ]);
  return Buffer.concat([
    encodeMessage(1, update),
  ]).toString('base64');
}

import { DEFAULT_USER_STATUS_B64 } from './defaultProtoTemplate';

/**
 * Reads the fallback UserStatus protobuf template containing all 14 models.
 */
export function getFallbackUserStatusProto(): Buffer | null {
  try {
    if (DEFAULT_USER_STATUS_B64 && DEFAULT_USER_STATUS_B64.length > 500) {
      return Buffer.from(DEFAULT_USER_STATUS_B64, 'base64');
    }
  } catch (err) {
    console.warn('[ProtobufHelper] Failed to decode template:', err);
  }
  return null;
}
