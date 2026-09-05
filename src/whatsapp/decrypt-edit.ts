import { proto } from 'baileys';
import { aesDecryptGCM, hmacSign } from 'baileys/lib/Utils/crypto.js';

/**
 * Decrypt secretEncryptedMessage MESSAGE_EDIT.
 * Based on https://github.com/WhiskeySockets/Baileys/issues/2541#issuecomment-2761900000
 * WhatsApp E2EE edit: encPayload ter-encrypt pakai messageSecret dari pesan asli.
 */
export function decryptEditedMessage(
  secEnc: {
    encPayload: Uint8Array;
    encIv: Uint8Array;
    targetMessageKey: { id: string };
  },
  secret: Uint8Array | string,
  sender: string,
): proto.IMessage | null {
  try {
    const toBinary = (txt: string) => Buffer.from(txt);
    const encKey =
      typeof secret === 'string'
        ? Buffer.from(secret as string, 'base64')
        : Buffer.from(secret);
    if (!encKey?.length) return null;
    const id = secEnc.targetMessageKey.id;
    const senderBuf = toBinary(sender);
    const sign = Buffer.concat([
      toBinary(id),
      senderBuf,
      senderBuf,
      toBinary('Message Edit'),
      new Uint8Array([1]),
    ]);
    const key = hmacSign(encKey, new Uint8Array(32), 'sha256');
    const decKey = hmacSign(sign, key as unknown as Uint8Array, 'sha256');
    const decrypted = aesDecryptGCM(
      secEnc.encPayload as unknown as Uint8Array,
      decKey as unknown as Uint8Array,
      secEnc.encIv as unknown as Uint8Array,
      Buffer.from(''),
    );
    return proto.Message.decode(decrypted as unknown as Uint8Array);
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const secret = '+HYdgQKylAwLqcNbZZp3JbWi5Y0HoDNuSCGCrrtEYrQ=';
  const secEnc = {
    targetMessageKey: {
      remoteJid: '120363304325920491@g.us',
      id: '2A389FA2F76123721C61',
    } as never,
    encPayload: new Uint8Array([
      155, 244, 175, 188, 116, 168, 245, 200, 161, 131, 44, 244, 65, 15, 42,
      193, 189, 94, 146, 226, 34, 217, 209, 85, 206, 116, 157, 7, 9, 128, 47,
      212, 94, 200, 206, 113, 48, 234, 144, 222, 98, 18, 80, 86, 187, 170, 43,
      188, 163, 237, 136, 61, 34, 168, 130, 199, 186, 132, 34, 89, 160, 7, 90,
      27, 107, 105, 161, 138, 79, 252, 180, 202, 29, 118, 17, 166, 224, 50, 89,
      12, 180, 64, 17, 91, 134, 185, 36, 80, 107, 86, 132, 41, 143, 4, 119, 69,
      0, 228, 57, 91, 33, 38, 88, 235, 41, 152, 37, 215, 82, 209, 62, 215, 21,
      46, 181, 233, 55, 209, 39, 112, 243, 162, 226, 243, 100, 116, 11, 226,
    ]),
    encIv: new Uint8Array([
      41, 237, 54, 82, 54, 123, 124, 128, 212, 118, 211, 90,
    ]),
  } as never;
  const r1 = decryptEditedMessage(
    secEnc as never,
    secret,
    '75935709679712@lid',
  );
  console.log('lid:', r1);
  const r2 = decryptEditedMessage(
    secEnc as never,
    secret,
    '6285163063603@s.whatsapp.net',
  );
  console.log('pn:', r2);
}
