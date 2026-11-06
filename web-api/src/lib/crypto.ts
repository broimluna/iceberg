/**
 * Shared RSA/AES helpers.
 *
 * Extracted from routes/encryption.ts and routes/mix.ts, which each
 * independently implemented the same ASN.1 DER RSA-public-key builder
 * and AES-256-CBC encrypt/decrypt logic.
 */

import crypto, { type KeyObject } from "crypto";

/**
 * Build an RSA public key from raw modulus/exponent byte buffers.
 * Returns a Node.js crypto KeyObject.
 */
export function buildRsaPublicKeyFromBytes(modulusBytes: Buffer, exponentBytes: Buffer): KeyObject {
    // Build ASN.1 DER encoding for RSA public key
    // RSAPublicKey ::= SEQUENCE { modulus INTEGER, publicExponent INTEGER }

    function encodeLength(len: number): Buffer {
        if (len < 128) {
            return Buffer.from([len]);
        } else if (len < 256) {
            return Buffer.from([0x81, len]);
        } else {
            return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
        }
    }

    function encodeInteger(buf: Buffer): Buffer {
        // Add leading zero if high bit is set (to ensure positive integer)
        const needsPadding = buf[0] & 0x80;
        const len = buf.length + (needsPadding ? 1 : 0);
        const lenBytes = encodeLength(len);
        const result = Buffer.alloc(1 + lenBytes.length + len);
        result[0] = 0x02; // INTEGER tag
        lenBytes.copy(result, 1);
        if (needsPadding) {
            result[1 + lenBytes.length] = 0x00;
            buf.copy(result, 2 + lenBytes.length);
        } else {
            buf.copy(result, 1 + lenBytes.length);
        }
        return result;
    }

    const modulusEncoded = encodeInteger(modulusBytes);
    const exponentEncoded = encodeInteger(exponentBytes);

    // SEQUENCE containing modulus and exponent
    const innerSeqContent = Buffer.concat([modulusEncoded, exponentEncoded]);
    const innerSeqLen = encodeLength(innerSeqContent.length);
    const innerSeq = Buffer.concat([Buffer.from([0x30]), innerSeqLen, innerSeqContent]);

    // BIT STRING wrapping the inner sequence
    const bitStringContent = Buffer.concat([Buffer.from([0x00]), innerSeq]); // 0x00 = no unused bits
    const bitStringLen = encodeLength(bitStringContent.length);
    const bitString = Buffer.concat([Buffer.from([0x03]), bitStringLen, bitStringContent]);

    // Algorithm identifier for RSA: OID 1.2.840.113549.1.1.1 + NULL
    const algorithmOid = Buffer.from([
        0x30, 0x0d, // SEQUENCE, length 13
        0x06, 0x09, // OID, length 9
        0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, // 1.2.840.113549.1.1.1 (rsaEncryption)
        0x05, 0x00  // NULL
    ]);

    // Outer SEQUENCE: algorithm + bit string
    const outerSeqContent = Buffer.concat([algorithmOid, bitString]);
    const outerSeqLen = encodeLength(outerSeqContent.length);
    const derKey = Buffer.concat([Buffer.from([0x30]), outerSeqLen, outerSeqContent]);

    // Convert to PEM
    const pem = '-----BEGIN PUBLIC KEY-----\n' +
                derKey.toString('base64').match(/.{1,64}/g)!.join('\n') +
                '\n-----END PUBLIC KEY-----';

    return crypto.createPublicKey(pem);
}

/**
 * Decrypt AES-256-CBC encrypted data.
 * Format: first 16 bytes are the IV, rest is ciphertext.
 */
export function decryptAesCbc(encryptedData: Buffer, key: Buffer): Buffer {
    if (encryptedData.length <= 16) {
        throw new Error('Encrypted data too short - must include IV');
    }
    const iv = encryptedData.subarray(0, 16);
    const ciphertext = encryptedData.subarray(16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Encrypt data with AES-256-CBC.
 * Format: IV (16 bytes) + ciphertext.
 */
export function encryptAesCbc(data: Buffer, key: Buffer): Buffer {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([iv, encrypted]);
}
