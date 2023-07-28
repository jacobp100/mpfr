import { readFile } from "node:fs/promises";
import { resolve } from "path";
import { createWasmFloat } from "./WasmFloat.js";

const wasm = new Response(await readFile(resolve("wasm/float.wasm")), {
  headers: { "Content-Type": "application/wasm" },
});
const Float = await createWasmFloat(wasm, {
  precisionBits: 1 << 14,
});

let f = new Float(1e6);
for (let i = 0; i < 20; i += 1) {
  f = f.mul(f);
  console.log(f.toString().length - 1);
}
