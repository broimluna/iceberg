/**
 * Encryption Routes
 * 
 * Handles encryption key exchange for secure requests.
 * 
 * Endpoints:
 * - POST /encryption-trusted/v1/encryptionKey - Get encryption key (GetEncryptionKeyOperation)
 */

import express from "express";
const router = express.Router();
import crypto from "crypto";
import * as db from "../database.ts";
import { buildRsaPublicKeyFromBytes, decryptAesCbc, encryptAesCbc } from "../lib/crypto.ts";
import { rateLimit } from "../utils/rateLimit.ts";
import { logSafe } from "../utils/logSafe.ts";

// No login is needed and every call stores a key, so calls are limited per
// address. The client asks once and reuses the key until it stops working.
const MAX_MODULUS_BYTES = 512; // 4096 bits
const MAX_EXPONENT_BYTES = 4;
const keyLimit = rateLimit({
    name: 'encryption-key', envVar: 'AUTH_ENCRYPTION_KEY_PER_MIN', defaultLimit: 30, windowMs: 60_000,
    onLimited: (res) => res.status(429).json({ error: 'Too many requests' }),
});

/**
 * POST /encryption-trusted/v1/encryptionKey
 * Get encryption key for secure requests
 * 
 * Request: PublicKeyData { exponent: number[], modulus: number[] }
 * Response: EncryptionKey { keyId, encryptedSymmetricKey }
 */
router.post('/encryption-trusted/v1/encryptionKey', keyLimit, (req, res) => {
    const { swid, username } = req.player;
    const publicKeyData = req.body;
    
    console.log(`[ENCRYPTION] ${username} requesting encryption key`);
    
    try {
        // Extract public key components from request
        // The client sends exponent and modulus as base64-encoded strings
        if (!publicKeyData || !publicKeyData.exponent || !publicKeyData.modulus) {
            const h = req.headers;
            const raw = (req as any).rawBody;
            console.error(`[ENCRYPTION] Missing public key data in request: content-type=${logSafe(String(h['content-type'] ?? '(none)'))} length=${logSafe(String(h['content-length'] ?? '?'))} key-id=${h['x-encryption-key-id'] ? 'set' : 'none'} method-override=${logSafe(String(h['x-http-method-override'] ?? 'none'))} client=${logSafe(String(h['x-cp-client-version'] ?? '?'))} body=${typeof publicKeyData}:${logSafe(JSON.stringify(publicKeyData ?? null).slice(0, 200))} raw=${Buffer.isBuffer(raw) ? raw.length : 'none'}`);
            return res.status(400).json({ error: 'Missing public key data' });
        }
        
        console.log(`[ENCRYPTION] Received exponent length: ${publicKeyData.exponent.length}, modulus length: ${publicKeyData.modulus.length}`);
        
        // Decode the base64-encoded public key components
        const exponentBytes = Buffer.from(publicKeyData.exponent, 'base64');
        const modulusBytes = Buffer.from(publicKeyData.modulus, 'base64');
        // The client's key is 1024-bit with exponent 65537. Bigger keys cost
        // a long modular power each, so they're refused.
        const modulusLength = modulusBytes.length - (modulusBytes[0] === 0 ? 1 : 0);
        if (modulusLength > MAX_MODULUS_BYTES || exponentBytes.length > MAX_EXPONENT_BYTES) {
            console.log(`[ENCRYPTION] Refused a ${modulusLength * 8}-bit key with a ${exponentBytes.length}-byte exponent`);
            return res.status(400).json({ error: 'Unsupported public key' });
        }
        
        console.log(`[ENCRYPTION] Decoded exponent bytes: ${exponentBytes.length}, modulus bytes: ${modulusBytes.length}`);
        
        // Build the RSA public key
        const publicKey = buildRsaPublicKeyFromBytes(modulusBytes, exponentBytes);
        
        // Generate a random symmetric key (32 bytes for AES-256)
        // The client expects a 32-byte key for AES-256 encryption
        const symmetricKey = crypto.randomBytes(32);
        
        // Generate a unique key ID
        const keyId = crypto.randomUUID();
        
        // Store the symmetric key in database with 1-hour TTL
        db.storeEncryptionKey(keyId, symmetricKey, 3600);
        
        // Encrypt the symmetric key with the client's RSA public key using PKCS#1 v1.5
        const encryptedSymmetricKey = crypto.publicEncrypt(
            {
                key: publicKey,
                padding: crypto.constants.RSA_PKCS1_PADDING
            },
            symmetricKey
        );
        
        console.log(`[ENCRYPTION] Generated key ID: ${keyId}, encrypted key length: ${encryptedSymmetricKey.length}`);
        
        // Response: EncryptionKey - return as base64 string
        res.json({
            keyId: keyId,
            encryptedSymmetricKey: encryptedSymmetricKey.toString('base64')
        });
    } catch (err) {
        console.error(`[ENCRYPTION] Error generating encryption key:`, err);
        res.status(500).json({ error: 'Failed to generate encryption key' });
    }
});

/**
 * Get a stored symmetric key by ID
 * Used by other routes to decrypt client messages
 */
function getSymmetricKey(keyId) {
    return db.getEncryptionKey(keyId);
}

const decryptAes = decryptAesCbc;
const encryptAes = encryptAesCbc;

/**
 * Middleware to handle encrypted requests from the client
 * Checks for X-Encryption-Key-Id header and decrypts request body if present
 */
function encryptionMiddleware(req, res, next) {
    const keyId = req.headers['x-encryption-key-id'];
    
    if (!keyId) {
        // Not an encrypted request, continue normally
        return next();
    }
    
    const symmetricKey = db.getEncryptionKey(keyId);
    if (!symmetricKey) {
        console.error(`[ENCRYPTION] Unknown encryption key ID: ${keyId}`);
        res.set('X-Encryption-Error', 'UNKNOWN_KEY_ID');
        return res.status(400).json({ error: 'Unknown encryption key ID' });
    }
    
    // Store the key for response encryption
    req.encryptionKey = symmetricKey;
    req.encryptionKeyId = keyId;
    
    // If there's a body, decrypt it
    if (req.body && Buffer.isBuffer(req.rawBody) && req.rawBody.length > 16) {
        try {
            const decrypted = decryptAes(req.rawBody, symmetricKey);
            const jsonStr = decrypted.toString('utf8');
            req.body = JSON.parse(jsonStr);
            console.log(`[ENCRYPTION] Decrypted request body for key ${keyId}`);
        } catch (err) {
            console.error(`[ENCRYPTION] Failed to decrypt request body:`, err.message);
            res.set('X-Encryption-Error', 'DECRYPTION_FAILED');
            return res.status(400).json({ error: 'Failed to decrypt request body' });
        }
    }
    
    // Override res.json to encrypt the response
    const originalJson = res.json.bind(res);
    res.json = function(data) {
        if (req.encryptionKey) {
            try {
                const jsonStr = JSON.stringify(data);
                const encrypted = encryptAes(Buffer.from(jsonStr, 'utf8'), req.encryptionKey);
                res.set('Content-Type', 'application/octet-stream');
                return res.send(encrypted);
            } catch (err) {
                console.error(`[ENCRYPTION] Failed to encrypt response:`, err.message);
                // Fall back to unencrypted response
            }
        }
        return originalJson(data);
    };
    
    next();
}

export default router;
export { getSymmetricKey, encryptionMiddleware, decryptAes, encryptAes };
