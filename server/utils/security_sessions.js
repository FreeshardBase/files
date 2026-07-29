function parseDeviceType(userAgent = '') {
  if (!userAgent || typeof userAgent !== 'string') return 'Unknown';
  const ua = userAgent.toLowerCase();
  if (ua.includes('ipad') || ua.includes('tablet')) {
    return 'Tablet';
  }
  if (ua.includes('mobile') || ua.includes('iphone') || ua.includes('android')) {
    return 'Mobile';
  }
  return 'Desktop';
}

module.exports = {
  parseDeviceType
};
