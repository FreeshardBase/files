const path = require('path');
const fs = require('fs/promises');
const db = require('../db');

/**
 * Evaluate active filing rules for a user against a filename and optional mimeType.
 * Returns the matching rule or null if no rule matches.
 */
async function evaluateRules(userId, fileName, mimeType = null) {
  const rules = await db.getFilingRulesByUser(userId);
  const activeRules = rules.filter(r => r.is_active === 1 || r.is_active === true);

  const ext = path.extname(fileName).toLowerCase().replace(/^\./, '');
  const lowerName = fileName.toLowerCase();

  for (const rule of activeRules) {
    const condVal = (rule.condition_value || '').trim();
    if (!condVal) continue;

    switch (rule.condition_type) {
      case 'extension': {
        const targetExt = condVal.toLowerCase().replace(/^\./, '');
        if (ext === targetExt) {
          return rule;
        }
        break;
      }
      case 'keyword': {
        if (lowerName.includes(condVal.toLowerCase())) {
          return rule;
        }
        break;
      }
      case 'mime_type': {
        if (mimeType) {
          const ruleType = condVal.toLowerCase();
          const actualType = mimeType.toLowerCase();
          if (ruleType.endsWith('/*')) {
            const prefix = ruleType.slice(0, -2);
            if (actualType.startsWith(prefix)) {
              return rule;
            }
          } else if (actualType === ruleType) {
            return rule;
          }
        }
        break;
      }
      case 'regex': {
        try {
          const regex = new RegExp(condVal, 'i');
          if (regex.test(fileName)) {
            return rule;
          }
        } catch (e) {
          console.error(`Invalid regex rule in auto filing rule #${rule.id}:`, e.message);
        }
        break;
      }
    }
  }

  return null;
}

/**
 * Automatically file a file at relativePath for userId if a rule matches.
 */
async function processAutoFiling(userId, relativePath, mimeType = null) {
  const fileName = path.posix.basename(relativePath);
  const matchedRule = await evaluateRules(userId, fileName, mimeType);

  if (!matchedRule) {
    return { filed: false, originalPath: relativePath, reason: 'No matching rule' };
  }

  const targetFolder = matchedRule.target_folder || '/';
  const destinationPath = path.posix.join(targetFolder, fileName);

  if (relativePath === destinationPath) {
    return { filed: false, originalPath: relativePath, reason: 'File already in target folder', rule: matchedRule };
  }

  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
  const userFilesDir = path.join(dataDir, 'users', userId, 'files');

  const absSource = path.join(userFilesDir, relativePath);
  const absDestDir = path.join(userFilesDir, targetFolder);
  const absDest = path.join(userFilesDir, destinationPath);

  await fs.mkdir(absDestDir, { recursive: true });
  await fs.rename(absSource, absDest);

  return {
    filed: true,
    originalPath: relativePath,
    destinationPath,
    rule: matchedRule
  };
}

module.exports = {
  evaluateRules,
  processAutoFiling
};
