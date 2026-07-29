/**
 * Client-Side PDF Tools utility (#38)
 *
 * Provides PDF page counting, rotation, splitting, and merging routines.
 */

'use strict';

const path = require('path');

/**
 * Extracts page count from a PDF Buffer.
 * @param {Buffer} buffer
 * @returns {number}
 */
function getPdfPageCount(buffer) {
  if (!buffer || buffer.length === 0) return 0;
  const content = buffer.toString('latin1');
  const pageMatches = content.match(/\/Type\s*\/Page\b(?!\s*s)/g);
  if (pageMatches && pageMatches.length > 0) {
    return pageMatches.length;
  }
  const countMatch = content.match(/\/Count\s+(\d+)/);
  if (countMatch) {
    return parseInt(countMatch[1], 10);
  }
  return 1;
}

/**
 * Rotates pages in a PDF buffer.
 * @param {Buffer} buffer
 * @param {object} [options]
 * @param {number} [options.angle=90]
 * @param {number[]} [options.pages] 1-indexed page numbers to rotate. If omitted/null, rotates all pages.
 * @returns {Buffer}
 */
function rotatePdfPages(buffer, options = {}) {
  const { angle = 90, pages = null } = options;
  const normalizedAngle = ((angle % 360) + 360) % 360;
  let content = buffer.toString('latin1');

  const objRegex = /(\d+\s+\d+\s+obj[\s\S]*?endobj)/g;
  let pageIndex = 0;

  const newContent = content.replace(objRegex, (objStr) => {
    if (/\/Type\s*\/Page\b(?!\s*s)/.test(objStr)) {
      pageIndex++;
      const shouldRotate = !pages || pages.length === 0 || pages.includes(pageIndex);
      if (!shouldRotate) return objStr;

      if (/\/Rotate\s+(\d+)/.test(objStr)) {
        return objStr.replace(/\/Rotate\s+(\d+)/, (_, curAngle) => {
          const newDeg = (parseInt(curAngle, 10) + normalizedAngle) % 360;
          return `/Rotate ${newDeg}`;
        });
      } else {
        return objStr.replace(/\/Type\s*\/Page\b/, `/Type /Page /Rotate ${normalizedAngle}`);
      }
    }
    return objStr;
  });

  return Buffer.from(newContent, 'latin1');
}

/**
 * Splits a PDF buffer into multiple PDF buffers based on page ranges.
 * @param {Buffer} buffer
 * @param {object} [options]
 * @param {Array<number[]>} [options.ranges] Array of 1-indexed page arrays, e.g. [[1], [2, 3]]
 * @returns {Buffer[]}
 */
function splitPdfPages(buffer, options = {}) {
  const totalPages = getPdfPageCount(buffer);
  let ranges = options.ranges;

  if (!ranges || !Array.isArray(ranges) || ranges.length === 0) {
    ranges = Array.from({ length: totalPages }, (_, i) => [i + 1]);
  }

  const content = buffer.toString('latin1');
  const pageObjs = [];
  const objRegex = /(\d+\s+\d+\s+obj[\s\S]*?endobj)/g;
  let match;

  while ((match = objRegex.exec(content)) !== null) {
    if (/\/Type\s*\/Page\b(?!\s*s)/.test(match[1])) {
      pageObjs.push(match[1]);
    }
  }

  if (pageObjs.length === 0) {
    pageObjs.push(content);
  }

  const splitBuffers = [];

  for (const pageGroup of ranges) {
    const selectedObjs = [];
    for (const pNum of pageGroup) {
      if (pNum >= 1 && pNum <= pageObjs.length) {
        selectedObjs.push(pageObjs[pNum - 1]);
      }
    }

    if (selectedObjs.length === 0) continue;

    let body = '';
    const kidRefs = [];

    selectedObjs.forEach((pObj, idx) => {
      const objId = idx + 3;
      kidRefs.push(`${objId} 0 R`);
      let cleanedObj = pObj.replace(/^\d+\s+\d+\s+obj/, `${objId} 0 obj`);
      cleanedObj = cleanedObj.replace(/\/Parent\s+\d+\s+\d+\s+R/, '/Parent 2 0 R');
      body += `${cleanedObj}\n`;
    });

    const newPdfStr = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Count ${selectedObjs.length} /Kids [ ${kidRefs.join(' ')} ] >>
endobj
${body}%%EOF`;

    splitBuffers.push(Buffer.from(newPdfStr, 'latin1'));
  }

  return splitBuffers;
}

/**
 * Merges multiple PDF buffers into a single combined PDF buffer.
 * @param {Buffer[]} buffers
 * @returns {Buffer}
 */
function mergePdfBuffers(buffers) {
  if (!buffers || !Array.isArray(buffers) || buffers.length === 0) {
    throw new Error('No PDF buffers provided for merge');
  }

  let nextObjId = 3;
  const mergedObjs = [];
  const kidRefs = [];

  for (const buf of buffers) {
    const content = buf.toString('latin1');
    const objRegex = /(\d+\s+\d+\s+obj[\s\S]*?endobj)/g;
    let match;

    while ((match = objRegex.exec(content)) !== null) {
      const origStr = match[1];
      if (/\/Type\s*\/Catalog\b/.test(origStr) || /\/Type\s*\/Pages\b/.test(origStr)) {
        continue;
      }

      const currentObjId = nextObjId++;
      if (/\/Type\s*\/Page\b(?!\s*s)/.test(origStr)) {
        kidRefs.push(`${currentObjId} 0 R`);
      }

      let updatedStr = origStr.replace(/^\d+\s+\d+\s+obj/, `${currentObjId} 0 obj`);
      updatedStr = updatedStr.replace(/\/Parent\s+\d+\s+\d+\s+R/, '/Parent 2 0 R');
      mergedObjs.push(updatedStr);
    }
  }

  const newPdfStr = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Count ${kidRefs.length} /Kids [ ${kidRefs.join(' ')} ] >>
endobj
${mergedObjs.join('\n')}
%%EOF`;

  return Buffer.from(newPdfStr, 'latin1');
}

module.exports = {
  getPdfPageCount,
  rotatePdfPages,
  splitPdfPages,
  mergePdfBuffers
};
