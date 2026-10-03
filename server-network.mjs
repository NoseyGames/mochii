import { lookup as lookupAddress } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export function isPublicAddress(address) {
  if (typeof address !== 'string' || !ipaddr.isValid(address)) return false;
  // process() converts IPv4-mapped IPv6 before classification, so an address
  // such as ::ffff:127.0.0.1 cannot bypass the loopback/private-address checks.
  return ipaddr.process(address).range() === 'unicast';
}

export async function resolvePublicAddress(hostname, lookup = lookupAddress) {
  const records = await lookup(hostname, { all: true, order: 'ipv4first' });
  const record = records.find(({ address }) => isPublicAddress(address));
  if (!record) {
    const error = new Error('The destination does not resolve to a public IP address.');
    error.code = 'EACCES';
    throw error;
  }
  // Wisp expects a single address string and caches it for both its access
  // check and the TCP connection. Never return the unchecked hostname.
  return record.address;
}
