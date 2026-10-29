// Lets Node resolve the browser import map ("three", "three/addons/") for headless tests:
//   node --import ./tests/node-loader.mjs tests/play.test.mjs
import { register } from 'node:module';
register(new URL('./node-hooks.mjs', import.meta.url));
