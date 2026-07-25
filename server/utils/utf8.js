/**
 * Safely decodes UTF-8 filenames if busboy/multipart headers parsed them as latin1/binary
 */
function decodeUtf8Filename(filename) {
  if (!filename) return filename;
  try {
    const decoded = Buffer.from(filename, 'latin1').toString('utf8');
    if (!decoded.includes('\uFFFD') && decoded !== filename) {
      return decoded;
    }
  } catch (e) {}
  return filename;
}

module.exports = {
  decodeUtf8Filename
};
