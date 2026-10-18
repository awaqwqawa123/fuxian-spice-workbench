import { isIP } from 'node:net'

export function publicAddress(address:string):boolean {
  if(isIP(address)===4){const [a,b]=address.split('.').map(Number);return a>0&&a!==10&&a!==127&&a<224&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&b===168)&&!(a===100&&b>=64&&b<=127)&&!(a===198&&(b===18||b===19))}
  // GitHub currently has IPv4. Only globally routable IPv6 (2000::/3) is
  // accepted; local, mapped IPv4, link local and multicast are rejected.
  return isIP(address)===6&&/^[23][0-9a-f]{3}:/i.test(address)&&!/^2001:db8:/i.test(address)
}
