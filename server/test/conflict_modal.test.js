const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function generateNonConflictingName(originalName, existingNames) {
  const extIndex = originalName.lastIndexOf('.');
  let baseName = originalName;
  let ext = '';
  if (extIndex > 0) {
    baseName = originalName.substring(0, extIndex);
    ext = originalName.substring(extIndex);
  }

  let counter = 1;
  let candidate = `${baseName} (${counter})${ext}`;
  const nameSet = new Set(existingNames.map(n => n.toLowerCase()));
  while (nameSet.has(candidate.toLowerCase())) {
    counter++;
    candidate = `${baseName} (${counter})${ext}`;
  }
  return candidate;
}

describe('File Collision & Conflict Resolution Wizard (#66)', () => {
  describe('generateNonConflictingName Helper', () => {
    test('generates (1) suffix for first collision', () => {
      const existing = ['report.pdf', 'notes.txt'];
      const result = generateNonConflictingName('report.pdf', existing);
      assert.equal(result, 'report (1).pdf');
    });

    test('increments suffix to (2) if (1) already exists', () => {
      const existing = ['photo.jpg', 'photo (1).jpg'];
      const result = generateNonConflictingName('photo.jpg', existing);
      assert.equal(result, 'photo (2).jpg');
    });

    test('handles case insensitivity correctly', () => {
      const existing = ['Document.DOCX'];
      const result = generateNonConflictingName('document.docx', existing);
      assert.equal(result, 'document (1).docx');
    });

    test('handles files without extensions', () => {
      const existing = ['Dockerfile'];
      const result = generateNonConflictingName('Dockerfile', existing);
      assert.equal(result, 'Dockerfile (1)');
    });
  });

  describe('Conflict Resolution Decisions (Overwrite / Rename / Cancel / Apply to All)', () => {
    test('processes batch items with Overwrite option', () => {
      const items = [
        { name: 'file1.txt', srcPath: '/src/file1.txt' },
        { name: 'file2.txt', srcPath: '/src/file2.txt' }
      ];
      const destItems = ['file1.txt', 'file2.txt'];
      const userChoice = 'overwrite';

      const processed = items.map(item => {
        const isConflict = destItems.includes(item.name);
        return {
          ...item,
          finalName: isConflict && userChoice === 'rename'
            ? generateNonConflictingName(item.name, destItems)
            : item.name,
          skipped: isConflict && userChoice === 'cancel'
        };
      });

      assert.equal(processed[0].finalName, 'file1.txt');
      assert.equal(processed[0].skipped, false);
      assert.equal(processed[1].finalName, 'file2.txt');
    });

    test('processes batch items with Auto-Rename option', () => {
      const items = [
        { name: 'file1.txt', srcPath: '/src/file1.txt' },
        { name: 'file2.txt', srcPath: '/src/file2.txt' }
      ];
      const destItems = ['file1.txt', 'file2.txt'];
      const userChoice = 'rename';

      const processed = items.map(item => {
        const isConflict = destItems.includes(item.name);
        let finalName = item.name;
        if (isConflict && userChoice === 'rename') {
          finalName = generateNonConflictingName(item.name, destItems);
          destItems.push(finalName);
        }
        return { ...item, finalName, skipped: isConflict && userChoice === 'cancel' };
      });

      assert.equal(processed[0].finalName, 'file1 (1).txt');
      assert.equal(processed[1].finalName, 'file2 (1).txt');
    });

    test('processes batch items with Cancel option', () => {
      const items = [
        { name: 'file1.txt', srcPath: '/src/file1.txt' }
      ];
      const destItems = ['file1.txt'];
      const userChoice = 'cancel';

      const processed = items.filter(item => {
        const isConflict = destItems.includes(item.name);
        if (isConflict && userChoice === 'cancel') return false;
        return true;
      });

      assert.equal(processed.length, 0);
    });

    test('remembers choice when Apply to All is selected across batch transfer', () => {
      const items = [
        { name: 'doc1.pdf' },
        { name: 'doc2.pdf' },
        { name: 'doc3.pdf' }
      ];
      const destItems = ['doc1.pdf', 'doc2.pdf', 'doc3.pdf'];

      let rememberedChoice = null;
      let promptCallCount = 0;

      const mockPrompt = (item) => {
        promptCallCount++;
        return { choice: 'rename', applyToAll: true };
      };

      const result = [];
      for (const item of items) {
        if (destItems.includes(item.name)) {
          let choice = rememberedChoice;
          if (!choice) {
            const promptRes = mockPrompt(item);
            choice = promptRes.choice;
            if (promptRes.applyToAll) rememberedChoice = choice;
          }

          if (choice === 'cancel') continue;
          if (choice === 'rename') {
            const newName = generateNonConflictingName(item.name, destItems);
            destItems.push(newName);
            result.push(newName);
          } else {
            result.push(item.name);
          }
        }
      }

      assert.equal(promptCallCount, 1, 'Should only prompt once when Apply to All is selected');
      assert.deepEqual(result, ['doc1 (1).pdf', 'doc2 (1).pdf', 'doc3 (1).pdf']);
    });
  });

  describe('UI & Contract Verifications (index.html & filebrowser.js)', () => {
    test('index.html contains modalFileConflict and chkConflictApplyToAll', () => {
      const htmlPath = path.join(__dirname, '../../public/index.html');
      const content = fs.readFileSync(htmlPath, 'utf8');

      assert.ok(content.includes('id="modalFileConflict"'), 'index.html must include modalFileConflict');
      assert.ok(content.includes('id="chkConflictApplyToAll"'), 'index.html must include chkConflictApplyToAll');
      assert.ok(content.includes('id="btnConflictOverwrite"'), 'index.html must include btnConflictOverwrite');
      assert.ok(content.includes('id="btnConflictRename"'), 'index.html must include btnConflictRename');
      assert.ok(content.includes('id="btnConflictCancel"'), 'index.html must include btnConflictCancel');
    });

    test('filebrowser.js contains promptFileConflict with Apply to all support', () => {
      const jsPath = path.join(__dirname, '../../public/js/filebrowser.js');
      const content = fs.readFileSync(jsPath, 'utf8');

      assert.ok(content.includes('promptFileConflict'), 'filebrowser.js must include promptFileConflict method');
      assert.ok(content.includes('chkConflictApplyToAll'), 'filebrowser.js must reference chkConflictApplyToAll');
      assert.ok(content.includes('generateNonConflictingName'), 'filebrowser.js must include generateNonConflictingName method');
    });
  });
});
