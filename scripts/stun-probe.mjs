// Ask Cloudflare's STUN server what it sees, over UDP.
//
// One question, and the voice pipeline cannot answer it on its own: does UDP from this machine
// reach Cloudflare and come back? The client offers host candidates only - deliberately, because
// Cloudflare's SFU is publicly routable and answers to whatever source address it observes - so a
// connection that dies in `checking` looks identical whether the packets never left, never arrived,
// or arrived and could not be answered.
//
// A STUN binding request is the smallest possible version of the same round trip: one UDP packet
// out, one back, no credentials, no allocation. If this prints a mapped address, the network can
// carry the media path and the fault is elsewhere. If it times out on every interface, it cannot,
// and no amount of client-side ICE tuning will change that - only a relay (TURN over TCP/TLS) will.
//
//   node scripts/stun-probe.mjs
//   node scripts/stun-probe.mjs stun.l.google.com:19302     # compare against a second server
//
// Binds each local IPv4 interface in turn, because "UDP works" is per-route: a tunnel that holds
// the default route can pass traffic while the LAN address cannot egress at all, which is exactly
// the shape that leaves ICE with several host candidates and no working pair.

import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';

const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const TIMEOUT_MS = 3000;

const [hostArg] = process.argv.slice(2);
const [host, port] = (hostArg ?? 'stun.cloudflare.com:3478').split(':');

/** A 20-byte STUN binding request: no attributes, just the header and a transaction id. */
function bindingRequest() {
  const packet = Buffer.alloc(20);
  packet.writeUInt16BE(BINDING_REQUEST, 0);
  packet.writeUInt16BE(0, 2); // no attributes
  packet.writeUInt32BE(MAGIC_COOKIE, 4);
  crypto.getRandomValues(new Uint8Array(packet.buffer, 8, 12));
  return packet;
}

/**
 * Pull the reflexive address out of a binding success.
 *
 * XOR-MAPPED-ADDRESS rather than MAPPED-ADDRESS: the former is what every current server sends,
 * obfuscated against middleboxes that would otherwise rewrite an address they recognise.
 */
function mappedAddress(msg, transactionId) {
  if (msg.length < 20 || msg.readUInt16BE(0) !== BINDING_SUCCESS) return null;
  let offset = 20;
  while (offset + 4 <= msg.length) {
    const type = msg.readUInt16BE(offset);
    const length = msg.readUInt16BE(offset + 2);
    const value = msg.subarray(offset + 4, offset + 4 + length);
    if (type === ATTR_XOR_MAPPED_ADDRESS && value.length >= 8 && value[1] === 0x01) {
      const mappedPort = value.readUInt16BE(2) ^ (MAGIC_COOKIE >>> 16);
      const cookie = Buffer.alloc(4);
      cookie.writeUInt32BE(MAGIC_COOKIE);
      const ip = Array.from(value.subarray(4, 8), (byte, i) => byte ^ cookie[i]).join('.');
      return `${ip}:${mappedPort}`;
    }
    // Attributes are padded to a 4-byte boundary; the padding is not counted in `length`.
    offset += 4 + length + ((4 - (length % 4)) % 4);
  }
  void transactionId;
  return null;
}

function probe(localAddress) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const request = bindingRequest();
    const done = (result) => {
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };
    const timer = setTimeout(() => done({ localAddress, ok: false, detail: 'timed out' }), TIMEOUT_MS);

    socket.on('message', (msg) => {
      const mapped = mappedAddress(msg, request.subarray(8, 20));
      done(
        mapped
          ? { localAddress, ok: true, detail: `seen as ${mapped}` }
          : { localAddress, ok: false, detail: 'replied, but with no usable address' },
      );
    });
    socket.on('error', (err) => done({ localAddress, ok: false, detail: err.message }));

    // Bound to one specific interface, which is the whole point - see the note at the top.
    socket.bind({ address: localAddress, port: 0 }, () => {
      socket.send(request, Number(port), host, (err) => {
        if (err) done({ localAddress, ok: false, detail: err.message });
      });
    });
  });
}

const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
  .map((iface) => iface.address);

// '0.0.0.0' first: the OS picks the source itself from the routing table, which is what an
// application that does not enumerate interfaces (Discord's voice client, for one) effectively does.
const targets = ['0.0.0.0', ...addresses];

console.log(`STUN ${host}:${port}\n`);
for (const address of targets) {
  const { ok, detail } = await probe(address);
  const label = address === '0.0.0.0' ? '0.0.0.0 (OS default route)' : address;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label.padEnd(28)} ${detail}`);
}
console.log(
  '\nAny OK means UDP can reach this server and return, and the media path is usable from that\n' +
    'interface. All FAIL means it cannot, and only a TURN relay over TCP/TLS will help.',
);
