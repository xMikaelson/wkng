import { webcrypto as crypto } from 'node:crypto';

const b64uToBytes = s => { const b=s.replace(/-/g,'+').replace(/_/g,'/'); return Uint8Array.from(Buffer.from(b.padEnd(b.length+(4-b.length%4)%4,'='),'base64')); };
const bytesToB64u = b => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
const concat = (...a) => { const o=new Uint8Array(a.reduce((n,x)=>n+x.length,0)); let i=0; for(const x of a){o.set(x,i);i+=x.length;} return o; };

async function hkdf(ikm, salt, info, bits) {
  const key = await crypto.subtle.importKey('raw', ikm, {name:'HKDF'}, false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info}, key, bits));
}

// RFC 8291 Appendix A test vector
const V = {
  plaintext:  'When I grow up, I want to be a watermelon',
  uaPublic:   'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  asPublic:   'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate:  'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt:       'DGv6ra1nlYgDCS1FRnbzlw',
  expected:   'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const enc = new TextEncoder();
const clientPubBytes = b64uToBytes(V.uaPublic);
const authSecret     = b64uToBytes(V.authSecret);
const salt           = b64uToBytes(V.salt);
const serverPubRaw   = b64uToBytes(V.asPublic);

// chiave privata server fissa (nel codice reale e' generata a caso)
const asPub = b64uToBytes(V.asPublic);
const serverPriv = await crypto.subtle.importKey('jwk', {
  kty:'EC', crv:'P-256', d: V.asPrivate,
  x: bytesToB64u(asPub.slice(1,33)), y: bytesToB64u(asPub.slice(33,65)),
  key_ops:['deriveBits'], ext:true,
}, {name:'ECDH', namedCurve:'P-256'}, false, ['deriveBits']);

const clientPubKey = await crypto.subtle.importKey('raw', clientPubBytes, {name:'ECDH',namedCurve:'P-256'}, true, []);
const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH', public: clientPubKey}, serverPriv, 256));

const authInfo = concat(enc.encode('WebPush: info'), new Uint8Array([0x00]), clientPubBytes, serverPubRaw);
const ikm   = await hkdf(sharedSecret, authSecret, authInfo, 256);
const cek   = await hkdf(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 128);
const nonce = await hkdf(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 96);

const aesKey = await crypto.subtle.importKey('raw', cek, {name:'AES-GCM'}, false, ['encrypt']);
const padded = concat(enc.encode(V.plaintext), new Uint8Array([0x02]));
const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv: nonce}, aesKey, padded));

const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
const body = concat(salt, rs, new Uint8Array([serverPubRaw.length]), serverPubRaw, ciphertext);
const got = bytesToB64u(body);

console.log('atteso : ' + V.expected);
console.log('ottenuto: ' + got);
console.log(got === V.expected ? '\n✅ CIFRATURA CORRETTA — combacia col vettore RFC 8291' : '\n❌ NON combacia');
process.exit(got === V.expected ? 0 : 1);
