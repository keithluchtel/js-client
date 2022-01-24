import * as crypto from "../aion_crypto";
import * as sjcl from "../sjcl";
import Bignum from "./bignum";
import Point from "./point";
import type { BitArray } from "./bitarray";

export const Curve = crypto.Curve;

// Converter functions
// --------------------------
export const pointFromBits = (bits) => crypto.pointFromBits(bits);

export const pointFromHex = (hex: string): Point => new Point(pointFromBits(sjcl.codec.hex.toBits(hex)));
export const pointToHex = (point: Point): string => sjcl.codec.hex.fromBits(point.toBits(true));

export const bignumFromHex = (hex: string): Bignum => new Bignum(sjcl.bn.fromBits(sjcl.codec.hex.toBits(hex)));
export const bignumToHex = (bignum: Bignum): string => sjcl.codec.hex.fromBits(bignum.toBits());

export const hashToBignum = (hash: BitArray): Bignum => new Bignum(crypto.hashToBn(hash));

// Other
// --------------------------
export const generateRandomBignum = () => new Bignum(crypto.randomBN());

export const pointFromX = (x: Bignum): Point => {
  const flag = !x.isEven() ? 2 : 3;
  const flagBignum = new sjcl.bn(flag);

  const encodedPoint = sjcl.bitArray.concat(flagBignum.toBits(), x.toBits());

  return new Point(pointFromBits(encodedPoint));
}

export const addPoints = (a: Point, b: Point): Point => {
  return new Point(crypto.addPoints(a.toEccPoint(), b.toEccPoint()));
}

export const isValidHexString = (test: string): boolean => {
  if(test.length % 2 !== 0)
    return false;   // Hex string must be even length

  return test.match(/^[0-9A-Fa-f]+$/) !== null;
}
