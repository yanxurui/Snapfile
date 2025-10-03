/**
 * End-to-End Encryption using Web Crypto API
 * 
 * This module provides encryption and decryption functions for messages and files
 * using AES-GCM (256-bit) with a key derived from the user's passcode.
 */

class E2EEncryption {
    constructor() {
        this.key = null;
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();
        this.CHUNK_SIZE = 64 * 1024 * 1024; // 64MB chunks
        this.AES_GCM_TAG_LENGTH = 16; // AES-GCM authentication tag length
        this.IV_LENGTH = 12; // IV length for AES-GCM
    }

    /**
     * Derive encryption key from passcode using PBKDF2
     * @param {string} passcode - The user's passcode
     * @param {Uint8Array} salt - Salt for key derivation (16 bytes)
     * @returns {Promise<CryptoKey>} The derived key
     */
    async deriveKey(passcode, salt) {
        const keyMaterial = await window.crypto.subtle.importKey(
            'raw',
            this.encoder.encode(passcode),
            'PBKDF2',
            false,
            ['deriveBits', 'deriveKey']
        );

        return window.crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: salt,
                iterations: 480000,
                hash: 'SHA-256'
            },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    /**
     * Initialize encryption with a passcode
     * @param {string} passcode - The user's passcode
     * @returns {Promise<void>}
     */
    async initialize(passcode) {
        // Use a fixed salt derived from the passcode for consistent key generation
        const hashBuffer = await window.crypto.subtle.digest(
            'SHA-256',
            this.encoder.encode(passcode)
        );
        const salt = new Uint8Array(hashBuffer).slice(0, 16);
        this.key = await this.deriveKey(passcode, salt);
    }

    /**
     * Encrypt text message
     * @param {string} text - Plain text to encrypt
     * @returns {Promise<string>} Base64 encoded encrypted data (IV + ciphertext)
     */
    async encryptText(text) {
        if (!this.key) {
            throw new Error('Encryption key not initialized');
        }

        const iv = window.crypto.getRandomValues(new Uint8Array(12)); // 12 bytes for GCM
        const encoded = this.encoder.encode(text);
        
        const ciphertext = await window.crypto.subtle.encrypt(
            {
                name: 'AES-GCM',
                iv: iv
            },
            this.key,
            encoded
        );

        // Combine IV and ciphertext
        const combined = new Uint8Array(iv.length + ciphertext.byteLength);
        combined.set(iv, 0);
        combined.set(new Uint8Array(ciphertext), iv.length);

        // Convert to base64
        return btoa(String.fromCharCode.apply(null, combined));
    }

    /**
     * Decrypt text message
     * @param {string} encryptedBase64 - Base64 encoded encrypted data
     * @returns {Promise<string>} Decrypted plain text
     */
    async decryptText(encryptedBase64) {
        if (!this.key) {
            throw new Error('Encryption key not initialized');
        }

        // Decode from base64
        const combined = new Uint8Array(
            atob(encryptedBase64).split('').map(c => c.charCodeAt(0))
        );

        // Extract IV and ciphertext
        const iv = combined.slice(0, 12);
        const ciphertext = combined.slice(12);

        const decrypted = await window.crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: iv
            },
            this.key,
            ciphertext
        );

        return this.decoder.decode(decrypted);
    }

    /**
     * Create a transform stream that decrypts data on-the-fly
     * This allows streaming decryption without loading entire file into memory
     * @param {function} progressCallback - Optional progress callback
     * @returns {TransformStream} Transform stream that decrypts data
     */
    createDecryptTransform(progressCallback) {
        if (!this.key) {
            throw new Error('Encryption key not initialized');
        }

        const CHUNK_SIZE = this.CHUNK_SIZE;
        const AES_GCM_TAG_LENGTH = this.AES_GCM_TAG_LENGTH;
        const ENCRYPTED_CHUNK_SIZE = CHUNK_SIZE + AES_GCM_TAG_LENGTH;
        const IV_LENGTH = this.IV_LENGTH;

        let iv = null;
        let buffer = new Uint8Array(0);
        let totalProcessed = 0;
        const key = this.key;

        return new TransformStream({
            async transform(chunk, controller) {
                // Append new data to buffer
                const newBuffer = new Uint8Array(buffer.length + chunk.length);
                newBuffer.set(buffer, 0);
                newBuffer.set(new Uint8Array(chunk), buffer.length);
                buffer = newBuffer;

                // Extract IV from first chunk
                if (!iv && buffer.length >= IV_LENGTH) {
                    iv = buffer.slice(0, IV_LENGTH);
                    buffer = buffer.slice(IV_LENGTH);
                }

                // Process complete encrypted chunks
                while (iv && buffer.length >= ENCRYPTED_CHUNK_SIZE) {
                    const encryptedChunk = buffer.slice(0, ENCRYPTED_CHUNK_SIZE);
                    buffer = buffer.slice(ENCRYPTED_CHUNK_SIZE);

                    try {
                        const decryptedChunk = await window.crypto.subtle.decrypt(
                            { name: 'AES-GCM', iv: iv },
                            key,
                            encryptedChunk
                        );

                        controller.enqueue(new Uint8Array(decryptedChunk));
                        totalProcessed += ENCRYPTED_CHUNK_SIZE;
                        
                        if (progressCallback) {
                            progressCallback(totalProcessed, totalProcessed + buffer.length);
                        }
                    } catch (error) {
                        controller.error(error);
                        throw error;
                    }
                }
            },

            async flush(controller) {
                // Process any remaining data in buffer (last chunk)
                if (buffer.length > 0 && iv) {
                    try {
                        const decryptedChunk = await window.crypto.subtle.decrypt(
                            { name: 'AES-GCM', iv: iv },
                            key,
                            buffer
                        );
                        controller.enqueue(new Uint8Array(decryptedChunk));
                        
                        if (progressCallback) {
                            progressCallback(totalProcessed + buffer.length, totalProcessed + buffer.length);
                        }
                    } catch (error) {
                        controller.error(error);
                        throw error;
                    }
                }
            }
        });
    }

    /**
     * Create a transform stream that encrypts data on-the-fly
     * This allows streaming encryption without loading entire file into memory
     * @returns {Promise<TransformStream>} Transform stream that encrypts data
     */
    async createEncryptTransformStream() {
        if (!this.key) {
            throw new Error('Encryption key not initialized');
        }

        const CHUNK_SIZE = this.CHUNK_SIZE;
        const AES_GCM_TAG_LENGTH = this.AES_GCM_TAG_LENGTH;
        const IV_LENGTH = this.IV_LENGTH;
        const iv = window.crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        const key = this.key;

        let buffer = new Uint8Array(0);
        let firstChunk = true;

        return new TransformStream({
            async transform(chunk, controller) {
                // Send IV as the first chunk
                if (firstChunk) {
                    controller.enqueue(iv);
                    firstChunk = false;
                }

                // Append new data to buffer
                const newBuffer = new Uint8Array(buffer.length + chunk.length);
                newBuffer.set(buffer, 0);
                newBuffer.set(new Uint8Array(chunk), buffer.length);
                buffer = newBuffer;

                // Process complete chunks
                while (buffer.length >= CHUNK_SIZE) {
                    const chunkToEncrypt = buffer.slice(0, CHUNK_SIZE);
                    buffer = buffer.slice(CHUNK_SIZE);

                    try {
                        const encryptedChunk = await window.crypto.subtle.encrypt(
                            { name: 'AES-GCM', iv: iv },
                            key,
                            chunkToEncrypt
                        );

                        controller.enqueue(new Uint8Array(encryptedChunk));
                    } catch (error) {
                        controller.error(error);
                        throw error;
                    }
                }
            },

            async flush(controller) {
                // Process any remaining data in buffer (last chunk)
                if (buffer.length > 0) {
                    try {
                        const encryptedChunk = await window.crypto.subtle.encrypt(
                            { name: 'AES-GCM', iv: iv },
                            key,
                            buffer
                        );
                        controller.enqueue(new Uint8Array(encryptedChunk));
                    } catch (error) {
                        controller.error(error);
                        throw error;
                    }
                }
            }
        });
    }

    /**
     * Check if Web Crypto API is available
     * @returns {boolean}
     */
    static isSupported() {
        return window.crypto && window.crypto.subtle;
    }
}

// Create global instance
const crypto_e2e = new E2EEncryption();
