import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { handleGodotRequest } from '../../server/godot/middleware.js';
import { parseSceneOutline, readSceneOutline } from '../../server/godot/scene-outline.js';
import { resolveGodotResourcePath } from '../../server/godot/resource-path.js';
import { runWithViewWorkspace } from '../../server/runtime/path-access.js';

const scene = `[gd_scene format=3 uid="uid://scene"]

[ext_resource type="Script" path="res://scripts/player.gd" id="1_script"]

[node name="Player" type="CharacterBody2D"]
script = ExtResource("1_script")

[node name="Camera" type="Camera2D" parent="."]

[connection signal="ready" from="." to="Camera" method="focus"]
`;

describe('saved Godot scene outline', () => {
  let temp;
  let project;

  before(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-scene-'));
    project = path.join(temp, 'game');
    await fs.mkdir(path.join(project, 'scenes'), { recursive: true });
    await fs.writeFile(path.join(project, 'project.godot'), '[application]\n');
    await fs.writeFile(path.join(project, 'scenes', 'main.tscn'), scene);
    await fs.writeFile(path.join(project, 'scenes', 'player.gd'), 'extends Node\n');
    await fs.writeFile(path.join(temp, 'outside.tscn'), scene);
  });
  after(async () => { await fs.rm(temp, { recursive: true, force: true }); });

  test('extracts nodes, script reference, resources, connections and source lines', () => {
    const outline = parseSceneOutline(scene);
    assert.equal(outline.complete, true);
    assert.deepEqual(outline.descriptor, { format: 3, uid: 'uid://scene' });
    assert.deepEqual(outline.nodes.map((node) => [node.name, node.parent, node.script, node.line]), [
      ['Player', null, 'res://scripts/player.gd', 5],
      ['Camera', '.', null, 8],
    ]);
    assert.deepEqual(outline.nodes.map((node) => node.nodePath), ['.', 'Camera']);
    assert.deepEqual(outline.connections[0], {
      from: '.', to: 'Camera', signal: 'ready', method: 'focus', line: 10,
    });
  });

  test('reports incomplete scenes without claiming validation', () => {
    const outline = parseSceneOutline('[gd_scene format=2]\n[node name="Child" parent="."]\n');
    assert.equal(outline.complete, false);
    assert.ok(outline.warnings.some((warning) => warning.message.includes('Godot 4')));
    assert.ok(outline.warnings.some((warning) => warning.message.includes('root')));
  });

  test('rejects traversal and non-scene files', async () => {
    await assert.rejects(readSceneOutline(project, '../outside.tscn'), /project-relative/);
    await assert.rejects(readSceneOutline(project, 'project.godot'), /project-relative/);
    await assert.rejects(readSceneOutline(project, '/outside.tscn'), /project-relative/);
    const result = await readSceneOutline(project, 'scenes/main.tscn');
    assert.equal(result.nodes.length, 2);
  });

  test('resolves only project-local res:// paths', async () => {
    assert.deepEqual(await resolveGodotResourcePath(project, 'res://scenes/player.gd'), {
      uri: 'res://scenes/player.gd', relativePath: 'scenes/player.gd', kind: 'file',
    });
    assert.equal((await resolveGodotResourcePath(project, 'res://missing.gd')).kind, 'missing');
    await assert.rejects(resolveGodotResourcePath(project, 'res://../outside.tscn'), /Invalid/);
    await assert.rejects(resolveGodotResourcePath(project, 'uid://scene'), /Expected/);
  });

  test('serves only scenes from the selected request workspace', async () => {
    const server = http.createServer((req, res) => {
      runWithViewWorkspace(temp, () => {
        void handleGodotRequest(req, res, new URL(req.url, 'http://127.0.0.1'));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      const base = `http://127.0.0.1:${address.port}/api/godot/scene-outline?project=game&path=`;
      const good = await fetch(base + 'scenes%2Fmain.tscn').then((response) => response.json());
      assert.equal(good.outline.nodes[0].name, 'Player');
      const outside = await fetch(base + '..%2Foutside.tscn');
      assert.equal(outside.status, 400);
      const resource = await fetch(`http://127.0.0.1:${address.port}/api/godot/resolve-resource?project=game&uri=res%3A%2F%2Fscenes%2Fplayer.gd`)
        .then((response) => response.json());
      assert.equal(resource.resource.workspacePath, 'game/scenes/player.gd');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
