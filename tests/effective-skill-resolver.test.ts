import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';
import { reconcileSessionSkills } from '../src/effective-skill-resolver.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('reconcileSessionSkills', () => {
  test('materializes directory skills on Windows without symlink privilege', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-skills-'));
    tempDirs.push(root);

    const skillPath = path.join(root, 'source-skill');
    const sessionClaudeDir = path.join(root, 'session', '.claude');
    fs.mkdirSync(skillPath, { recursive: true });
    fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# test');

    reconcileSessionSkills(
      sessionClaudeDir,
      {
        schemaVersion: 1,
        hash: 'test',
        policy: { mode: 'inherit', ids: [] },
        hostPolicy: { mode: 'inherit', ids: [] },
        candidates: [],
        selected: [
          {
            id: 'source-skill',
            source: 'host',
            path: skillPath,
            definitionHash: 'test',
            overrides: [],
          },
        ],
        conflicts: [],
        missingManagedSkillIds: [],
        missingHostSkillIds: [],
      },
      { materializeLinks: true },
    );

    const materialized = path.join(sessionClaudeDir, 'skills', 'source-skill');
    expect(fs.lstatSync(materialized).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(materialized)).toBe(fs.realpathSync(skillPath));
  });
});
