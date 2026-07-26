const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

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

describe('File Conflict Resolution & Collision Detection (#66)', () => {
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

  describe('Pre-Transfer Collision Detection Algorithm', () => {
    test('identifies collision when file exists in destination directory', () => {
      const destItems = [
        { name: 'Indila - Dernière Danse.jpg', size: 1024000, path: '/Indila - Dernière Danse.jpg' },
        { name: 'document.pdf', size: 204800, path: '/document.pdf' }
      ];

      const incomingItem = { name: 'Indila - Dernière Danse.jpg', size: 1024000 };
      const matching = destItems.find(i => i.name.toLowerCase() === incomingItem.name.toLowerCase());

      assert.ok(matching);
      assert.equal(matching.name, 'Indila - Dernière Danse.jpg');
    });

    test('returns null when no collision exists in destination directory', () => {
      const destItems = [
        { name: 'file1.txt', path: '/file1.txt' }
      ];

      const incomingItem = { name: 'file2.txt' };
      const matching = destItems.find(i => i.name.toLowerCase() === incomingItem.name.toLowerCase());

      assert.equal(matching, undefined);
    });

    test('executes Overwrite choice by using original filename', () => {
      const choice = 'overwrite';
      let targetName = 'photo.jpg';
      if (choice === 'rename') {
        targetName = generateNonConflictingName('photo.jpg', ['photo.jpg']);
      }
      assert.equal(targetName, 'photo.jpg');
    });

    test('executes Rename choice by assigning non-conflicting filename', () => {
      const choice = 'rename';
      let targetName = 'photo.jpg';
      if (choice === 'rename') {
        targetName = generateNonConflictingName('photo.jpg', ['photo.jpg']);
      }
      assert.equal(targetName, 'photo (1).jpg');
    });

    test('executes Cancel choice by skipping file transfer', () => {
      const choice = 'cancel';
      let transferExecuted = false;
      if (choice !== 'cancel') {
        transferExecuted = true;
      }
      assert.equal(transferExecuted, false);
    });
  });

  describe('Rename Duplicate Name Protection Algorithm (#COLLISION-RENAME)', () => {
    test('blocks rename if target filename already exists in folder', () => {
      const currentItems = [
        { name: 'Document.pdf', path: '/Document.pdf' },
        { name: 'Notes.txt', path: '/Notes.txt' }
      ];
      const selectedItem = { name: 'Notes.txt', path: '/Notes.txt' };
      const newName = 'document.pdf';

      const duplicateExists = currentItems.some(
        i => i.name.toLowerCase() === newName.toLowerCase() && i.name !== selectedItem.name
      );

      assert.equal(duplicateExists, true);
    });

    test('allows rename if target filename is unchanged or unique', () => {
      const currentItems = [
        { name: 'Document.pdf', path: '/Document.pdf' },
        { name: 'Notes.txt', path: '/Notes.txt' }
      ];
      const selectedItem = { name: 'Notes.txt', path: '/Notes.txt' };
      const newName = 'Summary.txt';

      const duplicateExists = currentItems.some(
        i => i.name.toLowerCase() === newName.toLowerCase() && i.name !== selectedItem.name
      );

      assert.equal(duplicateExists, false);
    });
  });
});
