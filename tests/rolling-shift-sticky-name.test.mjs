import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ui = readFileSync(join(root, 'rolling60h-ui.js'), 'utf8');
const index = readFileSync(join(root, 'index.html'), 'utf8');

const styleStart = ui.indexOf('#wh60-rolling-subpanel .rolling-name-col{');
const styleEnd = ui.indexOf('</style>', styleStart);
assert.ok(styleStart > 0, 'scoped name-column style exists');
const style = ui.slice(styleStart, styleEnd);
assert.match(style, /position:sticky/);
assert.match(style, /left:0/);
assert.match(style, /z-index:2/);
assert.match(style, /background-color:#fff!important/);
assert.match(style, /white-space:nowrap/);
assert.match(style, /text-overflow:ellipsis/);
assert.match(ui, /#wh60-rolling-subpanel thead \.rolling-name-col\{z-index:4;\}/);
assert.match(ui, /class="p-2 rolling-name-col"/);
assert.match(ui, /class="p-2 rolling-name-col font-medium"/);
assert.doesNotMatch(ui, /td:first-child|th:first-child/);
assert.match(ui, /b\.rawCode/);
assert.match(ui, /cellText = '休'/);
assert.match(index, /rolling60h-ui\.js\?v=20261007-1/);
assert.doesNotMatch(index, /td:first-child[\s\S]{0,80}sticky/);

console.log('rolling shift sticky name tests passed');
