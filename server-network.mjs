import { lookup as lookupAddress } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export function isPublicAddress(address) {
  if (typeof address !== 'string' || !ipaddr.isValid(address)) return false;
                                                                             
                                                                                
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
                                                                           
                                                                       
  return record.address;
}
