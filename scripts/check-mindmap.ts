import { mindmapBundleFingerprint } from "../src/mindmap-bundle";
import { mindmapSourceFingerprint } from "./mindmap-source";

const expected = mindmapSourceFingerprint();
const actual = mindmapBundleFingerprint();
if (expected !== actual) {
  console.error("src/mindmap-bundle.ts is stale. Run `yarn build:mindmap` and commit the result.");
  process.exit(1);
}
console.log(`mindmap bundle current (${expected.slice(0, 12)})`);
