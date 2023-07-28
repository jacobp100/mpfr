import type { FloatOptions } from "gmp-wasm";
import { createFloat } from "./Float.js";

const errorHandler = () => {
  throw new Error("Fatal error in gmp-wasm");
};

const decoder = new TextDecoder();

export const createWasmFloat = async (
  buffer: Response,
  options?: FloatOptions
) => {
  const heap = { HEAP8: new Uint8Array(0) };

  const { instance } = await WebAssembly.instantiateStreaming(buffer, {
    env: {
      emscripten_notify_memory_growth: () => {
        // @ts-expect-error
        heap.HEAP8 = new Uint8Array(instance.exports.memory.buffer);
      },
    },
    wasi_snapshot_preview1: {
      proc_exit: errorHandler,
      fd_write: errorHandler,
      fd_seek: errorHandler,
      fd_close: errorHandler,
    },
  });
  const exports: any = instance.exports;

  heap.HEAP8 = new Uint8Array((exports as any).memory.buffer);

  const gmp = {
    ...exports,
    setData(array: ArrayLike<number>, offset: number) {
      heap.HEAP8.set(array, offset);
    },
    readString(ptr: number): string {
      const mem: Uint8Array = heap.HEAP8;
      const endPtr = mem.indexOf(0, ptr);
      return decoder.decode(mem.subarray(ptr, endPtr));
    },
    readInt32LE(ptr: number): number {
      const memView = new DataView(
        heap.HEAP8.buffer,
        heap.HEAP8.byteOffset,
        heap.HEAP8.byteLength
      );
      return memView.getInt32(ptr, true);
    },
  };

  const Float = createFloat(gmp, options);

  return Float;
};
