import {
  FLOAT_SPECIAL_VALUES,
  assertUint32,
  insertDecimalPoint,
  isInt32,
} from "./util.js";

export enum FloatRoundingMode {
  /** Round to nearest, with ties to even. MPFR_RNDN */
  ROUND_NEAREST = 0,
  /** Round toward zero. MPFR_RNDZ */
  ROUND_TO_ZERO = 1,
  /** Round toward +Infinity. MPFR_RNDU */
  ROUND_UP = 2,
  /** Round toward -Infinity. MPFR_RNDD */
  ROUND_DOWN = 3,
  /** Round away from zero. MPFR_RNDA */
  ROUND_FROM_ZERO = 4,
  // /** (Experimental) Faithful rounding. MPFR_RNDF */
  // ROUND_FAITHFUL = 5,
  // /** (Experimental) Round to nearest, with ties away from zero. MPFR_RNDNA */
  // ROUND_TO_NEAREST_AWAY_FROM_ZERO = -1,
}

export interface FloatOptions {
  precisionBits?: number;
  roundingMode?: FloatRoundingMode;
  radix?: number;
}

const INVALID_PARAMETER_ERROR = "Invalid parameter!";
const PREALLOCATED_STR_SIZE = 2 * 1024;

const encoder = new TextEncoder();

export const createFloat = (
  gmp: any,
  defaultOptions: FloatOptions = {},
  customRetain?: (obj: any, ptr: number) => void
) => {
  type AnyNumber = Float | number;

  const {
    precisionBits: defaultPrecisionBits = 53,
    roundingMode: defaultRoundingMode = FloatRoundingMode.ROUND_NEAREST,
    radix: defaultRadix = 10,
  } = defaultOptions;

  let retain: (obj: any, ptr: number) => any;
  if (customRetain) {
    retain = customRetain;
  } else {
    // @ts-ignore
    const registry = new FinalizationRegistry((mpfr_t) => {
      gmp.r_clear(mpfr_t);
      gmp.r_t_free(mpfr_t);
    });
    retain = (target: any, mpfr_t: number) => registry.register(target, mpfr_t);
  }

  let strBuf = gmp.g_malloc(PREALLOCATED_STR_SIZE);
  let mpfr_exp_t_ptr = gmp.g_malloc(4);

  const getStringPointer = (input: string) => {
    const data = encoder.encode(input);
    let srcPtr = strBuf;
    if (data.length + 1 > PREALLOCATED_STR_SIZE) {
      srcPtr = gmp.g_malloc(data.length + 1);
    }
    gmp.setData(data, srcPtr);
    gmp.setData([0], srcPtr + data.length);
    return srcPtr;
  };

  const mergeOptions = (
    a: FloatOptions | null | undefined,
    b: FloatOptions | null | undefined
  ): FloatOptions | null => {
    if (a == null && b == null) {
      return null;
    }

    const precisionBits1 = a?.precisionBits ?? defaultPrecisionBits;
    const precisionBits2 = b?.precisionBits ?? defaultPrecisionBits;

    return {
      precisionBits: Math.max(precisionBits1, precisionBits2),
      roundingMode: b?.roundingMode ?? a?.roundingMode ?? defaultRoundingMode,
      radix: b?.radix ?? a?.radix ?? defaultRoundingMode,
    };
  };

  class Float {
    private gcHandle?: any;
    private mpfr_t: number;
    private options?: FloatOptions;

    constructor(
      val: AnyNumber | string | null,
      options?: FloatOptions | null | undefined
    ) {
      const precisionBits = options?.precisionBits ?? defaultPrecisionBits;
      const roundingMode = options?.roundingMode ?? defaultRoundingMode;
      const radix = options?.radix ?? defaultRadix;

      const mpfr_t = gmp.r_t();

      // Attempt to avoid megamorphic cases
      // If retain returns a GC handle (in RN), it will store on every object
      // The MPFR pointer is always stored
      // The options is only stored if it's needed
      // So at most two object shapes - or 1 if you just use the defaults
      const gcHandle = retain(this, mpfr_t);
      if (gcHandle != null) {
        this.gcHandle = gcHandle;
      }

      gmp.r_init2(mpfr_t, precisionBits);
      this.mpfr_t = mpfr_t;

      if (options != null) {
        this.options = options;
      }

      if (typeof val === "string") {
        const srcPtr = getStringPointer(val);
        const res = gmp.r_set_str(mpfr_t, srcPtr, radix, roundingMode);
        if (res !== 0) {
          throw new Error("Invalid number provided!");
        }
      } else if (typeof val === "number") {
        if (isInt32(val)) {
          gmp.r_set_si(mpfr_t, val, roundingMode);
          if (Object.is(val, -0)) {
            gmp.r_neg(mpfr_t, mpfr_t, roundingMode);
          }
        } else {
          gmp.r_set_d(mpfr_t, val, roundingMode);
        }
      } else if (val instanceof Float) {
        gmp.r_set(mpfr_t, val.mpfr_t, roundingMode);
      } else if (val != null) {
        throw new Error(INVALID_PARAMETER_ERROR);
      }
    }

    get precisionBits(): number {
      return this.options?.precisionBits ?? defaultPrecisionBits;
    }

    get roundingMode(): FloatRoundingMode {
      return this.options?.roundingMode ?? defaultRoundingMode;
    }

    get radix(): number {
      return this.options?.radix ?? defaultRadix;
    }

    toString(options?: { radix?: number; truncate?: boolean }): string {
      const radix = options?.radix ?? this.radix;
      const roundingMode = this.roundingMode;
      const truncate = options?.truncate ?? false;

      if (truncate && roundingMode !== FloatRoundingMode.ROUND_TO_ZERO) {
        throw new Error("Only MPFR_RNDZ is supported in truncate mode!");
      }

      const prec = gmp.r_get_prec(this.mpfr_t);

      const n = truncate
        ? Math.floor((prec * Math.log2(2)) / Math.log2(radix))
        : gmp.r_get_str_ndigits(radix, prec);

      const requiredSize = Math.max(7, n + 2);
      let destPtr = 0;
      if (requiredSize < PREALLOCATED_STR_SIZE) {
        destPtr = strBuf;
      }

      const strPtr = gmp.r_get_str(
        destPtr,
        mpfr_exp_t_ptr,
        radix,
        n,
        this.mpfr_t,
        truncate ? FloatRoundingMode.ROUND_TO_ZERO : roundingMode
      );
      let str = gmp.readString(strPtr);

      const specialValue = FLOAT_SPECIAL_VALUES[str];
      if (specialValue != null) {
        str = specialValue;
      } else {
        // decimal point needs to be inserted
        const pointPos = gmp.readInt32LE(mpfr_exp_t_ptr);
        str = insertDecimalPoint(str, pointPos);
      }

      if (destPtr !== strBuf) {
        gmp.r_free_str(strPtr);
      }
      return str;
    }

    // toFixed(options?: { digits?: number, radix?: number }): string {
    //   const digits = options?.digits ?? 0
    //   assertUint32(digits)

    //   const radix = this.radix

    //   const str = this.toString(options);
    //   if (Object.values(FLOAT_SPECIAL_VALUES).includes(str)) {
    //     return str;
    //   }

    //   let multiplier = null;
    //   if (radix === 2) {
    //     multiplier = new Float(digits).exp2();
    //   } else if (radix === 10) {
    //     multiplier = new Float(digits).exp10();
    //   } else {
    //     multiplier = new Float(radix).pow(digits);
    //   }
    //   const multiplied = this.mul(multiplier);
    //   const int = ctx.intContext.Integer(multiplied);
    //   const isNegative = int.sign() === -1;
    //   let intStr = int.abs().toString(radix);
    //   if (intStr.length < digits + 1) {
    //     intStr = '0'.repeat(digits + 1 - intStr.length) + intStr;
    //   }
    //   return `${isNegative ? '-' : ''}${intStr.slice(0, -digits)}.${intStr.slice(-digits)}`;
    // }

    add(val: AnyNumber): Float {
      const roundingMode = this.roundingMode;

      if (typeof val === "number") {
        const n = new Float(null, this.options);
        gmp.r_add_d(n.mpfr_t, this.mpfr_t, val, roundingMode);
        return n;
      } else if (val instanceof Float) {
        const n = new Float(null, mergeOptions(this.options, val.options));
        gmp.r_add(n.mpfr_t, this.mpfr_t, val.mpfr_t, roundingMode);
        return n;
      } else {
        throw new Error(INVALID_PARAMETER_ERROR);
      }
    }

    sub(val: AnyNumber): Float {
      const roundingMode = this.roundingMode;

      if (typeof val === "number") {
        const n = new Float(null, this.options);
        gmp.r_sub_d(n.mpfr_t, this.mpfr_t, val, roundingMode);
        return n;
      } else if (val instanceof Float) {
        const n = new Float(null, mergeOptions(this.options, val.options));
        gmp.r_sub(n.mpfr_t, this.mpfr_t, val.mpfr_t, roundingMode);
        return n;
      } else {
        throw new Error(INVALID_PARAMETER_ERROR);
      }
    }

    mul(val: AnyNumber): Float {
      const roundingMode = this.roundingMode;

      if (typeof val === "number") {
        const n = new Float(null, this.options);
        if (isInt32(val)) {
          gmp.r_mul_si(n.mpfr_t, this.mpfr_t, val, roundingMode);
        } else {
          gmp.r_mul_d(n.mpfr_t, this.mpfr_t, val, roundingMode);
        }
        return n;
      } else if (val instanceof Float) {
        const n = new Float(null, mergeOptions(this.options, val.options));
        gmp.r_mul(n.mpfr_t, this.mpfr_t, val.mpfr_t, roundingMode);
        return n;
      } else {
        throw new Error(INVALID_PARAMETER_ERROR);
      }
    }

    div(val: AnyNumber): Float {
      const roundingMode = this.roundingMode;

      if (typeof val === "number") {
        const n = new Float(null, this.options);
        gmp.r_div_d(n.mpfr_t, this.mpfr_t, val, roundingMode);
        return n;
      } else if (val instanceof Float) {
        const n = new Float(null, mergeOptions(this.options, val.options));
        gmp.r_div(n.mpfr_t, this.mpfr_t, val.mpfr_t, roundingMode);
        return n;
      } else {
        throw new Error(INVALID_PARAMETER_ERROR);
      }
    }
  }

  return Float;
};
