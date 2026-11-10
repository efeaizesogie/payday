// Nimiq message signing and address derivation, matching Nimiq's own implementations
// (php-utils SignatureUtils, core-rs-albatross wallet): data = "\x16Nimiq Signed Message:\n" + byteLength + message,
// hashed with SHA-256, signed with Ed25519. Address = first 20 bytes of BLAKE2b-256(publicKey), IBAN-style checksum.
import * as ed from '@noble/ed25519'
import { blake2b } from '@noble/hashes/blake2.js'
import { sha256 } from '@noble/hashes/sha2.js'

const PREFIX = '\x16Nimiq Signed Message:\n'
const B32 = '0123456789ABCDEFGHJKLMNPQRSTUVXY'
const enc = new TextEncoder()

export const hexToBytes = (hex: string) => Uint8Array.from((hex.match(/../g) ?? []).map(h => parseInt(h, 16)))
export const bytesToHex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')

function base32(bytes: Uint8Array) {
  let bits = ''
  for (const b of bytes) bits += b.toString(2).padStart(8, '0')
  let s = ''
  for (let i = 0; i + 5 <= bits.length; i += 5) s += B32[parseInt(bits.slice(i, i + 5), 2)]
  return s
}
function ibanCheck(str: string) {
  const num = str.toUpperCase().split('').map(c => parseInt(c, 36).toString()).join('')
  let r = 0
  for (const ch of num) r = (r * 10 + Number(ch)) % 97
  return r
}

export function addressFromPublicKey(pubHex: string): string {
  const base = base32(blake2b(hexToBytes(pubHex), { dkLen: 32 }).slice(0, 20))
  const check = ('00' + (98 - ibanCheck(base + 'NQ00'))).slice(-2)
  return ('NQ' + check + base).replace(/(.{4})/g, '$1 ').trim()
}

const messageHash = (message: string) => {
  const m = enc.encode(message)
  return sha256(enc.encode(PREFIX + m.length + message))
}

export async function verifyNimiqMessage(message: string, sigHex: string, pubHex: string): Promise<boolean> {
  try { return await ed.verifyAsync(hexToBytes(sigHex), messageHash(message), hexToBytes(pubHex)) }
  catch { return false }
}

/** Demo only: a throwaway key so the demo can produce a payslip that verifies the same way. */
export async function demoSign(message: string) {
  const sk = ed.utils.randomSecretKey()
  const pub = await ed.getPublicKeyAsync(sk)
  const sig = await ed.signAsync(messageHash(message), sk)
  return { publicKey: bytesToHex(pub), signature: bytesToHex(sig) }
}

// base64url helpers for links
export const b64urlEncode = (s: string) => btoa(String.fromCharCode(...enc.encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const b64urlDecode = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)))
