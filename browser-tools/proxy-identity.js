export function cleanUserAgent(value) {
  return typeof value === 'string' && value.length <= 512 && /^[\x20-\x7e]*$/.test(value) ? value.trim() : '';
}

export function proxyViewUrl(origin, target, userAgent = '') {
  const url = new URL('/proxy-host.html', origin);
  const value = cleanUserAgent(userAgent);
  if (value) url.searchParams.set('ua', value);
  url.hash = encodeURIComponent(target);
  return url.href;
}
